import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { signedQuantityBySection, buildStagesFromEstimatePositions } from "@/lib/estimate-stages";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import type { CalcPosition } from "@/lib/types";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, healthSnapshot, mutateAppData, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import { positionLineSum } from "@/lib/calc-math";
import { patchMergedPositions } from "@/lib/resource-merge";
import { foldNorthernEconomics } from "@/lib/wave23";
import {
  createManualProcurement,
  createProcurementSchedule,
  getBootstrap,
  recomputeCalculationCost,
  saveCustomerAnswer,
  sendProcurementToCalculation,
  deleteGprStage,
  setStagePredecessor,
  updateCalculation,
  updatePlanFact,
  updateSchedule,
} from "@/server/repo";
import { extractArchiveSafely, readArchiveMember } from "@/server/safe-archive";
import { saveUpload } from "@/server/uploads";
import "./setup";

function makeZip(files: Record<string, Buffer | string>): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tk-zip-"));
  const zipPath = path.join(dir, "pack.zip");
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, "src", name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    execFileSync("python3", ["-c", "import os,sys,zipfile\nroot,dest=sys.argv[1],sys.argv[2]\nwith zipfile.ZipFile(dest,'w') as z:\n  for base, dirs, files in os.walk(root):\n    for name in files:\n      full=os.path.join(base,name)\n      z.write(full, os.path.relpath(full, root))\n", path.join(dir, "src"), zipPath], { stdio: "pipe" });
    return fs.readFileSync(zipPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("wave 2–3 server checks", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("keeps burenie quantities by section in the calculation and the schedule", async () => {
    const parsed = await parseGrandBuffer(fs.readFileSync(path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx")));
    const positions: CalcPosition[] = (parsed?.positions ?? []).map((position, index) => ({
      id: `row-${index + 1}`,
      code: position.code,
      name: position.name,
      unit: position.unit,
      quantity: position.quantity,
      rate: position.rate > 0 ? position.rate : 0,
      rateMissing: !(position.rate > 0),
      ...(position.isWorkItem ? { isWorkItem: true } : {}),
      ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
      ...(position.sectionName ? { sourceSectionName: position.sectionName } : {}),
      ...(position.workName ? { sourceWorkName: position.workName } : {}),
    }));
    const stages = buildStagesFromEstimatePositions(positions, "2026-11-19T00:00:00.000Z");
    const source = positions.filter((position) => !position.isWorkItem && position.quantity !== 0).map((position) => ({
      section: position.sourceSectionName,
      name: position.name,
      unit: position.unit,
      quantity: position.quantity,
    }));
    const scheduled = stages.flatMap((stage) => (stage.resources ?? []).map((resource) => ({
      section: stage.sectionName,
      name: resource.name,
      unit: resource.unit,
      quantity: resource.quantity,
    })));
    const sourceTotals = signedQuantityBySection(source);
    const stageTotals = signedQuantityBySection(scheduled);
    for (const [key, quantity] of sourceTotals) {
      expect(stageTotals.get(key) ?? 0).toBeCloseTo(quantity, 4);
    }
    const sourceSections = new Set(source.map((row) => row.section).filter(Boolean));
    const stageSections = new Set(stages.map((stage) => stage.sectionName).filter(Boolean));
    expect(stageSections.size).toBe(sourceSections.size);
    const shown = buildHierarchicalEstimate({ stages: [], positions }).flatMap((node) => node.groups.flatMap((group) => group.leaves));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((leaf) => leaf.quantity >= 0)).toBe(true);
    const difference = (name: string) => shown.filter((leaf) => leaf.name.includes(name)).reduce((sum, leaf) => sum + (leaf.difference ?? 0), 0);
    expect(difference("Вода")).toBeCloseTo(-2728.28, 2);
    expect(difference("электросварные")).toBeCloseTo(-14.68, 2);
    expect(difference("обсадные")).toBeCloseTo(-170.76, 2);
  });

  it("keeps a return negative when its shown quantity is saved", () => {
    const created = createManualProcurement("u-ruk", { title: "Возврат воды", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind !== "customer_original")!;
    const positions: CalcPosition[] = [
      { id: "pay", code: "LAB-1", name: "Плотник", unit: "чел-ч", quantity: 10, rate: 100 },
      { id: "ret-a", code: "ФССЦ-1", name: "Вода", unit: "м3", quantity: -10, rate: 20, resourceKind: "material" },
      { id: "ret-b", code: "ФССЦ-1", name: "Вода", unit: "м3", quantity: -5, rate: 20, resourceKind: "material" },
    ];
    const lineTotal = (rows: CalcPosition[]) => rows.reduce((sum, row) => sum + positionLineSum(row), 0);
    mutateAppData((data) => {
      data.calculations.find((item) => item.id === draft.id)!.positions = positions;
      return data;
    });
    const before = lineTotal(positions);
    const leaf = buildHierarchicalEstimate({ stages: [], positions })
      .flatMap((node) => node.groups.flatMap((group) => group.leaves))
      .find((item) => item.name.includes("Вода"))!;
    expect(leaf.quantity).toBe(15);
    expect(leaf.difference).toBeCloseTo(-15);
    updateCalculation("u-ruk", draft.id, { positions: patchMergedPositions(positions, leaf, leaf.quantity) });
    const kept = readAppData().calculations.find((item) => item.id === draft.id)!.positions;
    expect(lineTotal(kept)).toBeCloseTo(before);
    expect(kept.filter((row) => row.name === "Вода").every((row) => row.quantity < 0)).toBe(true);
    updateCalculation("u-ruk", draft.id, { positions: patchMergedPositions(kept, leaf, 18) });
    const edited = readAppData().calculations.find((item) => item.id === draft.id)!.positions;
    expect(lineTotal(edited) - before).toBeCloseTo(-60);
    expect(edited.find((row) => row.id === "pay")).toMatchObject({ quantity: 10, rate: 100 });
    expect(edited.filter((row) => row.name === "Вода").reduce((sum, row) => sum + row.quantity, 0)).toBeCloseTo(-18);
  });

  it("extracts a nested zip and downloads one file without leaving the archive", async () => {
    const inner = makeZip({ "inner.txt": "внутри" });
    const outer = makeZip({ "docs/note.txt": "заметка", "nested/inner.zip": inner });
    const extracted = extractArchiveSafely("pack.zip", outer, fs.mkdtempSync(path.join(os.tmpdir(), "tk-out-")));
    expect(extracted.ok).toBe(true);
    expect(extracted.files.map((file) => file.relativePath).sort()).toEqual(["docs/note.txt", "nested/inner.zip"]);
    const note = readArchiveMember("pack.zip", outer, "docs/note.txt");
    expect(note.ok && note.data.toString("utf8")).toBe("заметка");
    expect(readArchiveMember("pack.zip", outer, "../secret.txt").ok).toBe(false);
    const nested = extracted.files.find((file) => file.name === "inner.zip");
    const nestedBytes = fs.readFileSync(nested!.absolutePath);
    const opened = extractArchiveSafely("inner.zip", nestedBytes, fs.mkdtempSync(path.join(os.tmpdir(), "tk-inner-")));
    expect(opened.files.map((file) => file.relativePath)).toEqual(["inner.txt"]);

    const procurement = readAppData().procurements.find((item) => item.id === "p-1")!;
    const stored = await saveUpload("archive-member", "pack.zip", outer);
    const { createDocument } = await import("@/server/repo");
    const { documentId } = createDocument("u-ruk", {
      orgId: procurement.orgId,
      procurementId: procurement.id,
      title: "Архив",
      fileName: "pack.zip",
      fileType: "zip",
      category: "archive",
      storedPath: stored.storedPath,
      fileSize: stored.fileSize,
    });
    const { GET } = await import("@/app/api/dokumenty/file/route");
    const response = await GET(new Request(`http://local/api/dokumenty/file?id=${documentId}&member=${encodeURIComponent("docs/note.txt")}`, {
      headers: { authorization: `Bearer ${createSession("u-ruk")}` },
    }));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe("заметка");
    const escaped = await GET(new Request(`http://local/api/dokumenty/file?id=${documentId}&member=${encodeURIComponent("../secret.txt")}`, {
      headers: { authorization: `Bearer ${createSession("u-ruk")}` },
    }));
    expect(escaped.status).toBe(400);

    const tarDir = fs.mkdtempSync(path.join(os.tmpdir(), "tk-tar-"));
    fs.writeFileSync(path.join(tarDir, "note.txt"), "tar-ok");
    execFileSync("tar", ["-czf", "pack.tar.gz", "note.txt"], { cwd: tarDir });
    const tarBytes = fs.readFileSync(path.join(tarDir, "pack.tar.gz"));
    const tarNote = readArchiveMember("pack.tar.gz", tarBytes, "note.txt");
    expect(tarNote.ok && tarNote.data.toString("utf8")).toBe("tar-ok");
    if (execFileSync("bash", ["-lc", "command -v 7z || command -v 7zz || true"], { encoding: "utf8" }).trim()) {
      const sevenBin = execFileSync("bash", ["-lc", "command -v 7z || command -v 7zz"], { encoding: "utf8" }).trim();
      execFileSync(sevenBin, ["a", "-bd", "pack.7z", "note.txt"], { cwd: tarDir });
      const seven = fs.readFileSync(path.join(tarDir, "pack.7z"));
      const sevenNote = readArchiveMember("pack.7z", seven, "note.txt");
      expect(sevenNote.ok && sevenNote.data.toString("utf8")).toBe("tar-ok");
    }
  });

  it("rejects a 7z path traversal and an oversized member before extracting", () => {
    const bin = execFileSync("bash", ["-lc", "command -v 7z || command -v 7zz || true"], { encoding: "utf8" }).trim();
    if (!bin) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tk-7z-guard-"));
    try {
      fs.writeFileSync(path.join(dir, "note.txt"), "внутри");
      const traversal = path.join(dir, "traversal.7z");
      execFileSync(bin, ["a", "-bd", "-mx=0", traversal, "note.txt"], { cwd: dir, stdio: "pipe" });
      execFileSync(bin, ["rn", traversal, "note.txt", "../escape.txt"], { cwd: dir, stdio: "pipe" });
      const traversalBytes = fs.readFileSync(traversal);
      const outside = path.join(dir, "escape.txt");
      const target = path.join(dir, "out");
      const extracted = extractArchiveSafely("traversal.7z", traversalBytes, target);
      expect(extracted.ok).toBe(false);
      expect(extracted.files).toHaveLength(0);
      expect(extracted.errors.join(" ")).toMatch(/traversal/i);
      expect(fs.existsSync(outside)).toBe(false);

      const big = path.join(dir, "big.bin");
      execFileSync("dd", ["if=/dev/zero", "of=" + big, "bs=1048576", "count=33"], { stdio: "pipe" });
      const oversized = path.join(dir, "big.7z");
      execFileSync(bin, ["a", "-bd", "-mx=0", oversized, "big.bin"], { cwd: dir, stdio: "pipe" });
      const limited = extractArchiveSafely("big.7z", fs.readFileSync(oversized), path.join(dir, "big-out"));
      expect(limited.ok).toBe(false);
      expect(limited.files).toHaveLength(0);
      expect(limited.errors.join(" ")).toMatch(/size limit/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a manager create a schedule and refuses a tender specialist", () => {
    const created = createManualProcurement("u-ruk", { title: "Доступ к графику", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    expect(() => createProcurementSchedule("u-tender", created.id)).toThrow(/Недостаточно прав/);
    expect(createProcurementSchedule("u-ruk", created.id).outcome).toBeTruthy();
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    const added = {
      id: "gs-added",
      name: "Монтаж",
      start: "2026-11-10",
      end: "2026-11-12",
      sequence: schedule.stages.length + 1,
    };
    updateSchedule("u-ruk", schedule.id, { stages: [...schedule.stages, added] });
    expect(readAppData().schedules.find((item) => item.id === schedule.id)!.stages.some((stage) => stage.name === "Монтаж")).toBe(true);
    expect(() => deleteGprStage("u-tender", schedule.id, "gs-added")).toThrow(/Недостаточно прав/);
    deleteGprStage("u-ruk", schedule.id, "gs-added");
    expect(readAppData().schedules.find((item) => item.id === schedule.id)!.stages.some((stage) => stage.id === "gs-added")).toBe(false);
    const current = readAppData().schedules.find((item) => item.id === schedule.id)!;
    const [first, second] = current.stages;
    setStagePredecessor("u-ruk", schedule.id, second.id, first.id);
    const shifted = readAppData().schedules.find((item) => item.id === schedule.id)!.stages.find((stage) => stage.id === second.id)!;
    expect(shifted.dependsOn).toBe(first.id);
    expect(shifted.start > first.end).toBe(true);
    expect(() => setStagePredecessor("u-ruk", schedule.id, first.id, second.id)).toThrow(/не может начинаться после самой себя/);
  });

  it("saves a customer answer and does not send mail without SMTP", async () => {
    saveCustomerAnswer("u-ruk", "p-1", "Какой аванс?", "Аванс 30 процентов по проекту договора.");
    const saved = readAppData().procurements.find((item) => item.id === "p-1")!;
    expect(saved.customerAnswers?.[0]).toMatchObject({ question: "Какой аванс?", answer: "Аванс 30 процентов по проекту договора." });
    const health = healthSnapshot() as { ocr: { configured: boolean }; procurement: { detail: string; lastSuccessAt: string | null } };
    expect(typeof health.ocr.configured).toBe("boolean");
    expect(health.procurement.detail).not.toMatch(/api[_-]?key|bearer/iu);

    const { upsertSupplier, upsertSupplyRequest } = await import("@/server/repo");
    const supplier = upsertSupplier("u-ruk", { name: "СеверСнаб", email: "sales@example.test", materialKeywords: ["труба"], regions: ["Ямал"] });
    const supply = upsertSupplyRequest("u-ruk", {
      procurementId: "p-1",
      materialName: "Труба",
      unit: "м",
      qtyNeed: 10,
      needBy: "2026-12-01",
      supplierIds: [supplier.id],
    }).supplyRequests!.find((item) => item.materialName === "Труба")!;
    const { POST } = await import("@/app/api/supply/route");
    const response = await POST(new Request("http://local/api/supply", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-ruk")}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "sendRfq", id: supply.id, supplierId: supplier.id, confirmed: true }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; message: string };
    expect(body.status).toBe("не отправлено");
    expect(body.message).toMatch(/почта не подключена/);
    expect(readAppData().supplyRequests!.find((item) => item.id === supply.id)?.sentToSupplierIds ?? []).not.toContain(supplier.id);
  });

  it("stores northern add-ons in the calculation total and the workbook", async () => {
    const created = createManualProcurement("u-ruk", { title: "Северная смета", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const calculation = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind !== "customer_original")!;
    mutateAppData((data) => {
      const draft = data.calculations.find((item) => item.id === calculation.id)!;
      draft.positions = [{ id: "labor-1", code: "LAB-1", name: "Плотник", unit: "чел-ч", quantity: 10, rate: 100 }];
      return data;
    });
    recomputeCalculationCost("u-ruk", calculation.id, {
      useResourceScheduleEconomics: true,
      officeOverhead: 200,
      northern: { applicable: true, confirmedItems: [{ id: "n1", name: "Вахта", status: "known", amount: 100, basis: "приказ" }], notes: [] },
      resourceScheduleParams: {
        ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
        districtCoefficient: 1.8,
        northernPayrollShare: 0.8,
        overheadRate: 0.43,
        profitMarkupOnCostWithOh: 0,
      },
    });
    const saved = readAppData().calculations.find((item) => item.id === calculation.id)!;
    const expected = foldNorthernEconomics({
      labor: 1000,
      materials: 0,
      equipment: 0,
      other: 0,
      profitRate: 0,
      params: { districtCoefficient: 1.8, northernPayrollShare: 0.8, overheadRate: 0.43 },
    });
    expect(saved.costSummary?.northernAdjustments).toMatchObject({
      district: expected.district,
      allowance: expected.allowance,
      overhead: expected.overhead,
    });
    expect(saved.costSummary?.priceExVat).toBe(expected.total + 200 + 100);
    const { buildCalculationXlsx, buildCalculationPdf } = await import("@/server/export");
    const workbook = new (await import("exceljs")).Workbook();
    await workbook.xlsx.load(await buildCalculationXlsx(calculation.id) as unknown as import("exceljs").Buffer);
    const sheet = workbook.getWorksheet("Расчёт")!;
    const labels = sheet.getColumn(2).values.map((value) => String(value ?? ""));
    expect(labels).toEqual(expect.arrayContaining(["Районный коэффициент", "Северная надбавка", "Накладные расходы"]));
    const pdf = (await buildCalculationPdf(calculation.id)).toString("latin1");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("applies northern defaults when the calculation is formed", async () => {
    const formed = createManualProcurement("u-ruk", { title: "Север при создании", region: "Ямал" });
    expect(readAppData().risks.some((item) => item.procurementId === formed.id)).toBe(true);
    const uploaded = await saveUpload("est-north", "smeta.xlsx", Buffer.from("estimate"));
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === formed.id)!;
      data.documents.unshift({
        id: "doc-north-labor",
        orgId: procurement.orgId,
        procurementId: formed.id,
        title: "Смета",
        fileName: "smeta.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: uploaded.storedPath,
        estimatePositions: [{ id: "lab-1", code: "LAB-1", name: "Оплата труда", unit: "чел-ч", quantity: 10, rate: 1000 }],
      });
      data.directories.find((item) => item.type === "rascenki" && item.current)?.rows.unshift({ code: "LAB-1", work: "Оплата труда", unit: "чел-ч", rate: 1000 });
      return data;
    });
    sendProcurementToCalculation("u-ruk", formed.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === formed.id && item.kind === "resource_draft")!;
    expect(draft.resourceScheduleParams).toMatchObject({ districtCoefficient: 1.8, northernPayrollShare: 0.8, overheadRate: 0.43 });
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: draft.resourceScheduleParams, useResourceScheduleEconomics: true });
    const totaled = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(totaled.costSummary?.northernAdjustments?.district).toBe(8000);
    expect(totaled.costSummary?.northernAdjustments?.allowance).toBe(8000);
    const firstTotal = totaled.costSummary?.priceExVat ?? 0;
    expect(firstTotal).toBeGreaterThan(20000);

    sendProcurementToCalculation("u-ruk", formed.id);
    const again = readAppData().calculations.find((item) => item.id === draft.id)!;
    recomputeCalculationCost("u-ruk", again.id, { resourceScheduleParams: again.resourceScheduleParams, useResourceScheduleEconomics: true });
    const repeated = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(repeated.resourceScheduleParams?.districtCoefficient).toBe(1.8);
    expect(repeated.costSummary?.priceExVat).toBe(firstTotal);

    recomputeCalculationCost("u-ruk", draft.id, {
      resourceScheduleParams: { ...repeated.resourceScheduleParams!, districtCoefficient: 1.2 },
      useResourceScheduleEconomics: true,
    });
    const edited = readAppData().calculations.find((item) => item.id === draft.id)!;
    const editedTotal = edited.costSummary?.priceExVat ?? 0;
    expect(edited.resourceScheduleParams?.districtCoefficient).toBe(1.2);
    expect(editedTotal).not.toBe(firstTotal);
    sendProcurementToCalculation("u-ruk", formed.id);
    const kept = readAppData().calculations.find((item) => item.id === draft.id)!;
    recomputeCalculationCost("u-ruk", kept.id, { resourceScheduleParams: kept.resourceScheduleParams, useResourceScheduleEconomics: true });
    const afterEdit = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(afterEdit.resourceScheduleParams?.districtCoefficient).toBe(1.2);
    expect(afterEdit.costSummary?.priceExVat).toBe(editedTotal);

    const { districtCoefficient: _district, northernPayrollShare: _share, ...scheduleWithoutNorth } = afterEdit.resourceScheduleParams!;
    void _district;
    void _share;
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: scheduleWithoutNorth, useResourceScheduleEconomics: true });
    const plainTotal = readAppData().calculations.find((item) => item.id === draft.id)!.costSummary?.priceExVat;
    sendProcurementToCalculation("u-ruk", formed.id);
    const untouched = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(untouched.resourceScheduleParams?.districtCoefficient).toBeUndefined();
    recomputeCalculationCost("u-ruk", untouched.id, { resourceScheduleParams: untouched.resourceScheduleParams, useResourceScheduleEconomics: true });
    expect(readAppData().calculations.find((item) => item.id === draft.id)!.costSummary?.priceExVat).toBe(plainTotal);
  });

  it("splits a unit out of an existing plan row on read and save", () => {
    const plan = readAppData().planFacts[0]!;
    mutateAppData((data) => {
      const item = data.planFacts.find((row) => row.id === plan.id)!;
      item.entries = [{ id: "old-row", workName: "Бурение скважин, м", unit: "", plan: 12, fact: 0 }];
      item.dailyFacts = [{
        id: "day-old",
        date: "2026-11-02",
        workName: "Бурение скважин, м",
        unit: "",
        quantity: 3,
        photos: [],
        authorId: "u-ruk",
        at: "2026-11-02T08:00:00.000Z",
      }];
      return data;
    });
    const shown = getBootstrap(readAppData().users.find((user) => user.id === "u-ruk")!).data.planFacts.find((item) => item.id === plan.id)!;
    expect(shown.entries[0]).toMatchObject({ workName: "Бурение скважин", unit: "м" });
    expect(shown.dailyFacts?.[0]).toMatchObject({ workName: "Бурение скважин", unit: "м", quantity: 3 });
    updatePlanFact("u-ruk", plan.id, { entries: [{ id: "old-row", workName: "Бурение скважин, м", unit: "", plan: 12, fact: 1 }] });
    const stored = readAppData().planFacts.find((item) => item.id === plan.id)!;
    expect(stored.entries[0]).toMatchObject({ workName: "Бурение скважин", unit: "м", fact: 1 });
    expect(stored.dailyFacts?.[0]).toMatchObject({ workName: "Бурение скважин", unit: "м", quantity: 3 });
    mutateAppData((data) => {
      const item = data.planFacts.find((row) => row.id === plan.id)!;
      item.entries = [{ id: "old-row", workName: "Бурение скважин", unit: "м", plan: 12, fact: 1 }];
      item.dailyFacts = [{
        id: "day-old",
        date: "2026-11-02",
        workName: "Бурение скважин, м",
        unit: "",
        quantity: 3,
        photos: [],
        authorId: "u-ruk",
        at: "2026-11-02T08:00:00.000Z",
      }];
      return data;
    });
    updatePlanFact("u-ruk", plan.id, {
      entries: [{ id: "old-row", workName: "Бурение скважин", unit: "м", plan: 12, fact: 1 }],
    });
    expect(readAppData().planFacts.find((item) => item.id === plan.id)!.dailyFacts?.[0]).toMatchObject({
      workName: "Бурение скважин",
      unit: "м",
      quantity: 3,
    });
  });

  it("drafts a volume sheet from the model and saves it into the calculation", async () => {
    const created = createManualProcurement("u-ruk", { title: "Ведомость из ТЗ", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const calculation = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind !== "customer_original")!;
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-tz-wave",
        orgId: calculation.orgId,
        procurementId: created.id,
        title: "Техническое задание",
        fileName: "tz.txt",
        fileType: "other",
        category: "tz",
        status: "gotovo",
        versions: [],
        analyticalNote: "Бурение скважин 716 м по трассе.",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
      });
      const rates = data.directories.find((item) => item.type === "rascenki" && item.current);
      rates?.rows.unshift({ code: "BUR", work: "Бурение скважин", unit: "м", rate: 1400 });
      return data;
    });
    const { draftVolumeSheet, acceptVolumeDraft, VOLUME_MODEL_MISSING } = await import("@/server/volume-sheet");
    const missing = await draftVolumeSheet("u-ruk", calculation.id);
    expect(missing.configured).toBe(false);
    expect(missing.message).toBe(VOLUME_MODEL_MISSING);
    const drafted = await draftVolumeSheet("u-ruk", calculation.id, async () => JSON.stringify({
      rows: [{ work: "Бурение скважин", unit: "м", volume: 716, quote: "Бурение скважин 716 м" }],
    }));
    expect(drafted.rows[0]).toMatchObject({ volume: 716, rate: 1400, quote: "Бурение скважин 716 м" });
    acceptVolumeDraft("u-ruk", calculation.id, drafted.rows);
    const saved = readAppData().calculations.find((item) => item.id === calculation.id)!;
    expect(saved.positions.some((position) => position.name === "Бурение скважин" && position.quantity === 716 && position.rate === 1400)).toBe(true);
    expect(saved.assumptions.some((line) => line.includes("Бурение скважин 716 м"))).toBe(true);
  });

  it("reads a volume sheet from the uploaded specification file", async () => {
    const created = createManualProcurement("u-ruk", { title: "ТЗ файлом", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const calculation = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind !== "customer_original")!;
    const spec = "Ведомость объёмов.\nБурение скважин 716 м по трассе.";
    const stored = await saveUpload("tz-file", "Техническое задание.txt", Buffer.from(spec, "utf8"));
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Бурение скважин 716 м по трассе.</w:t></w:r></w:p></w:body></w:document>`);
    const docx = await zip.generateAsync({ type: "nodebuffer" });
    const { extractUploadedSpecText } = await import("@/server/volume-sheet");
    expect(await extractUploadedSpecText("tz.docx", docx)).toContain("Бурение скважин 716 м");
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.drawText("Drilling 716 m", { x: 50, y: 700, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
    expect(await extractUploadedSpecText("tz.pdf", Buffer.from(await pdf.save()))).toContain("Drilling 716 m");
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-tz-file",
        orgId: calculation.orgId,
        procurementId: created.id,
        title: "Техническое задание",
        fileName: "Техническое задание.txt",
        fileType: "other",
        category: "tz",
        status: "gotovo",
        versions: [],
        analyticalNote: "Краткое описание без объёма.",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: stored.storedPath,
      });
      data.directories.find((item) => item.type === "rascenki" && item.current)?.rows.unshift({ code: "BUR", work: "Бурение скважин", unit: "м", rate: 1400 });
      return data;
    });
    const { draftVolumeSheet, acceptVolumeDraft } = await import("@/server/volume-sheet");
    const fromFile = await draftVolumeSheet("u-ruk", calculation.id, async (system, user) => {
      expect(system).toMatch(/цитата/);
      expect(user).toContain("Бурение скважин 716 м по трассе");
      expect(user).not.toMatch(/^Краткое описание/);
      return JSON.stringify({ rows: [{ work: "Бурение скважин", unit: "м", volume: 716, quote: "Бурение скважин 716 м по трассе" }] });
    });
    expect(fromFile.rows[0]).toMatchObject({ volume: 716, rate: 1400 });
    const invented = await draftVolumeSheet("u-ruk", calculation.id, async () => JSON.stringify({
      rows: [{ work: "Бурение скважин", unit: "м", volume: 1, quote: "Краткое описание без объёма" }],
    }));
    expect(invented.rows).toHaveLength(0);
    acceptVolumeDraft("u-ruk", calculation.id, fromFile.rows);
    const saved = readAppData().calculations.find((item) => item.id === calculation.id)!;
    expect(saved.positions.some((position) => position.name === "Бурение скважин" && position.quantity === 716)).toBe(true);
  });

  it("reviews a contract with the model checklist and labels the local fallback", async () => {
    const { reviewContractText } = await import("@/server/contract-risk");
    const text = "Неустойка 0,1% за каждый день просрочки. Аванс не предусмотрен.";
    const local = await reviewContractText(text, { configured: false });
    expect(local.mode).toBe("local");
    expect(local.label).toMatch(/модель не подключена/);
    const model = await reviewContractText(text, {
      configured: true,
      ask: async () => JSON.stringify({
        items: [{ item: "Штрафы и неустойка", severity: "high", quote: "Неустойка 0,1% за каждый день просрочки" }],
      }),
    });
    expect(model.mode).toBe("model");
    expect(model.remarks[0]).toMatchObject({ text: "Штрафы и неустойка", sourceExcerpt: "Неустойка 0,1% за каждый день просрочки" });
    const risk = readAppData().risks[0]!;
    const { saveContractReview } = await import("@/server/repo");
    saveContractReview("u-ruk", risk.id, model);
    expect(readAppData().risks.find((item) => item.id === risk.id)?.reviewLabel).toBe("Разбор по чек-листу с цитатами");
  });
});
