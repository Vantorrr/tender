import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it } from "vitest";
import { runUploadQueue } from "@/lib/upload-queue";
import { createSession } from "@/server/auth";
import { reextractStoredArchive } from "@/server/archive-ingest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { analyzeUpload } from "@/server/grand-smeta";
import {
  createManualProcurement,
  makeOfficialCalculationAndSchedule,
  upgradeCalculationToOfficialLogic,
} from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import { MAX_ARCHIVE_DEPTH } from "@/server/safe-archive";
import { isOleCompound } from "@/server/xls-workbook";
import "./setup";

function xlsSchedule(): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Наименование работы", "Единица", "Количество", "Ставка"],
    ["Монтаж ОРЧ", "шт", 4, 1500],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "График");
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "biff8" }) as Uint8Array);
}

async function zipBytes(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.data);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })) as Buffer;
}

async function postFile(procurementId: string, name: string, bytes: Buffer) {
  const form = new FormData();
  form.set("procurementId", procurementId);
  form.set("file", new File([new Uint8Array(bytes)], name));
  const { POST } = await import("@/app/api/dokumenty/route");
  return POST(new Request("http://local/api/dokumenty", {
    method: "POST",
    headers: { authorization: `Bearer ${createSession("u-ruk")}` },
    body: form,
  }));
}

describe("production blockers: archives, xls, batch upload, official chain", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("unpacks a 3-level archive and rejects a chain deeper than 5", async () => {
    expect(MAX_ARCHIVE_DEPTH).toBe(5);
    const created = createManualProcurement("u-ruk", { title: "Вложенные архивы", region: "Ямал" });
    const schedule = xlsSchedule();
    expect(isOleCompound(schedule)).toBe(true);
    const mid = await zipBytes([{ name: "Приложение 1. График.xls", data: schedule }]);
    const outer = await zipBytes([{ name: "20061403.zip", data: mid }]);
    const response = await postFile(created.id, "Документы и приложения.zip", outer);
    expect(response.status).toBe(200);
    const docs = readAppData().documents.filter((document) => document.procurementId === created.id);
    const xls = docs.find((document) => document.fileName === "Приложение 1. График.xls");
    expect(xls).toBeTruthy();
    expect(xls?.extractionErrors ?? []).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/формат пока нельзя|формат не анализируется/i),
    ]));
    expect(xls?.analyticalNote ?? "").not.toMatch(/формат не анализируется/i);
    expect((xls?.citations.length ?? 0) + (xls?.estimatePositions?.length ?? 0)).toBeGreaterThan(0);
    expect(docs.some((document) => (document.extractionErrors ?? []).some((message) => /глубин/i.test(message)))).toBe(false);

    let payload = Buffer.from("leaf");
    let entryName = "leaf.txt";
    for (let level = 6; level >= 1; level -= 1) {
      payload = await zipBytes([{ name: entryName, data: payload }]) as typeof payload;
      entryName = `level-${level}.zip`;
    }
    const deep = createManualProcurement("u-ruk", { title: "Слишком глубокий архив", region: "Ямал" });
    const deepResponse = await postFile(deep.id, "level-1.zip", payload);
    expect(deepResponse.status).toBe(200);
    const deepDocs = readAppData().documents.filter((document) => document.procurementId === deep.id);
    const depthErrors = deepDocs.flatMap((document) => document.extractionErrors ?? []);
    expect(depthErrors.some((message) => message.includes(`(${MAX_ARCHIVE_DEPTH})`))).toBe(true);
    expect(deepDocs.some((document) => document.fileName === "leaf.txt")).toBe(false);
  });

  it("re-extracts an already stored archive so a third level is indexed", async () => {
    const created = createManualProcurement("u-ruk", { title: "Повторная распаковка", region: "Ямал" });
    const schedule = xlsSchedule();
    const mid = await zipBytes([{ name: "График.xls", data: schedule }]);
    const outer = await zipBytes([{ name: "inner.zip", data: mid }]);
    const response = await postFile(created.id, "outer.zip", outer);
    expect(response.status).toBe(200);
    const before = readAppData();
    const root = before.documents.find((document) => document.procurementId === created.id && document.fileName === "outer.zip");
    expect(root).toBeTruthy();
    mutateAppData((data) => {
      data.documents = data.documents.filter((document) =>
        document.procurementId !== created.id || document.id === root!.id
      );
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      procurement.documentIds = procurement.documentIds.filter((id) => id === root!.id);
      const archive = data.documents.find((document) => document.id === root!.id)!;
      archive.extractionErrors = ["Превышена максимальная глубина вложенных архивов (2)"];
      archive.extractedFiles = [];
      return data;
    });
    const summary = await reextractStoredArchive("u-ruk", root!.id);
    expect(summary.errors.join(" ")).not.toMatch(/глубина вложенных архивов \(2\)/);
    const xls = readAppData().documents.find((document) => document.procurementId === created.id && document.fileName === "График.xls");
    expect(xls?.analyticalNote ?? "").not.toMatch(/формат не анализируется/i);
    expect((xls?.citations.length ?? 0) + (xls?.estimatePositions?.length ?? 0)).toBeGreaterThan(0);
    await expect(reextractStoredArchive("u-beta-tender", root!.id)).rejects.toThrow(/доступ/i);
  });

  it("parses a binary xls workbook directly and from inside an archive", async () => {
    const bytes = xlsSchedule();
    const direct = await analyzeUpload("Приложение 1. График 6520 (20).xls", "xls", bytes);
    expect(direct.analyticalNote).not.toMatch(/формат не анализируется|пока нельзя автоматически/i);
    expect(direct.citations.length + direct.positions.length).toBeGreaterThan(0);
    expect(direct.positions.some((position) => position.name.includes("ОРЧ"))).toBe(true);

    const created = createManualProcurement("u-ruk", { title: "XLS из архива", region: "Ямал" });
    const packed = await zipBytes([{ name: "Приложение 2. График 6520 (20).xls", data: bytes }]);
    const response = await postFile(created.id, "графики.zip", packed);
    expect(response.status).toBe(200);
    const stored = readAppData().documents.find((document) => document.fileName === "Приложение 2. График 6520 (20).xls");
    expect(stored?.status).not.toBe("oshibka");
    expect(stored?.extractionErrors ?? []).toEqual([]);
    expect(stored?.estimatePositions?.some((position) => position.name.includes("ОРЧ"))).toBe(true);
  });

  it("uploads several files through the queue and keeps per-file failures", async () => {
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const result = await runUploadQueue(
      [
        new File(["a"], "a.pdf"),
        new File(["b"], "b.xls"),
        new File(["c"], "c.docx"),
        new File([""], "empty.pdf"),
        new File(["d"], ".hidden.pdf"),
      ],
      async (file) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (file.name === "b.xls") throw new Error("битый xls");
        calls.push(file.name);
      },
      { concurrency: 3 },
    );
    expect(calls.sort()).toEqual(["a.pdf", "c.docx"]);
    expect(result.uploaded).toBe(2);
    expect(result.errors).toEqual([{ name: "b.xls", message: "битый xls" }]);
    expect(peak).toBeLessThanOrEqual(3);

    const created = createManualProcurement("u-ruk", { title: "Пакет файлов", region: "Ямал" });
    const first = await postFile(created.id, "one.pdf", Buffer.from("%PDF-1.1"));
    const second = await postFile(created.id, "two.txt", Buffer.from("договор поставки"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const names = readAppData().documents
      .filter((document) => document.procurementId === created.id)
      .map((document) => document.fileName);
    expect(names).toEqual(expect.arrayContaining(["one.pdf", "two.txt"]));
  });

  it("creates a calculation and GPR from a procurement on 2×11, 43/10/40 and output duration", async () => {
    const created = createManualProcurement("u-ruk", { title: "Техническое перевооружение ОРЧ конденсатопровода Мессояха–Дудинка, 2 этап", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const uploaded = await saveUpload("orch-pack", "orch.xlsx", Buffer.from("estimate"));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-orch-pack",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "ОРЧ",
        fileName: "orch.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "Монтаж ОРЧ 8 шт",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: uploaded.storedPath,
        estimatePositions: [{
          id: "e-orch",
          code: "ОРЧ-1",
          name: "Монтаж ОРЧ",
          unit: "шт",
          quantity: 8,
          rate: 0,
          rateMissing: true,
          isWorkItem: true,
          sectionName: "Опоры",
          workName: "Монтаж ОРЧ",
        }],
      });
      return data;
    });
    const official = makeOfficialCalculationAndSchedule("u-ruk", created.id);
    const after = readAppData();
    const draft = after.calculations.find((item) => item.id === official.calculationId)!;
    expect(draft.dataFlags ?? []).not.toContain("legacy_estimate_seeded_cost");
    expect(draft.resourceScheduleParams).toMatchObject({
      personnelShiftsPerDay: 2,
      equipmentShiftsPerDay: 2,
      hoursPerShift: 11,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    });
    const schedule = after.schedules.find((item) => item.id === official.scheduleId)!;
    expect(schedule.calendar?.weekendDays).toEqual([]);
    expect(schedule.calendar?.hoursPerShift).toBe(11);
    expect(schedule.calendar?.shiftsPerDay).toBe(2);
    const stage = schedule.stages.find((item) => item.name === "Монтаж ОРЧ");
    expect(stage?.durationBasis).toBe("site_daily");
    expect(stage?.durationDays).toBe(2);
    expect(schedule.assumptions?.some((line) => /не делится поровну|не делится/i.test(line))).toBe(true);
    const span = stage ? (Date.parse(`${stage.end}T00:00:00Z`) - Date.parse(`${stage.start}T00:00:00Z`)) / 86400000 : 0;
    expect(span).toBe(1);

    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.dataFlags = ["legacy_estimate_seeded_cost", "seeded_from_customer_estimate"];
      calc.resourceScheduleParams = {
        ...calc.resourceScheduleParams!,
        equipmentShiftsPerDay: 1,
        personnelShiftsPerDay: 2,
        hoursPerShift: 11,
      };
      calc.positions = [
        ...calc.positions,
        { id: "legacy-labor", code: "LAB-1", name: "Плотник", unit: "чел.-ч", quantity: 10, rate: 100 },
      ];
      calc.costSummary = {
        C0: 999,
        C: 999,
        reserve: 0,
        profit: 0,
        priceExVat: 999,
        vatAmount: null,
        priceIncVat: null,
        method: "saved-legacy",
        incomplete: [],
        totalsIncomplete: false,
        at: "2020-01-01T00:00:00.000Z",
      };
      const old = data.schedules.find((item) => item.id === schedule.id)!;
      old.stages = old.stages.map((item) => ({ ...item, durationBasis: undefined, durationDays: undefined }));
      old.calendar = { weekendDays: [0, 6], hoursPerShift: 8, shiftsPerDay: 1, timezone: "Asia/Krasnoyarsk" };
      return data;
    });
    expect(() => upgradeCalculationToOfficialLogic("u-beta-tender", draft.id)).toThrow(/доступ/i);
    upgradeCalculationToOfficialLogic("u-ruk", draft.id);
    const upgraded = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(upgraded.dataFlags ?? []).not.toContain("legacy_estimate_seeded_cost");
    expect(upgraded.resourceScheduleParams).toMatchObject({
      personnelShiftsPerDay: 2,
      equipmentShiftsPerDay: 2,
      hoursPerShift: 11,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    });
    expect(upgraded.costSummary?.C0).not.toBe(999);
    expect(upgraded.costSummary?.reserve).toBeCloseTo((upgraded.costSummary?.C0 ?? 0) * 0.1, 2);
    expect(upgraded.costSummary?.priceExVat).toBeCloseTo((upgraded.costSummary?.C0 ?? 0) * 1.5, 2);
    const rebuilt = readAppData().schedules.find((item) => item.id === schedule.id)!;
    expect(rebuilt.calendar?.weekendDays).toEqual([]);
    expect(rebuilt.stages.some((item) => item.durationBasis === "site_daily")).toBe(true);
    const fixture = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    expect(fs.existsSync(fixture)).toBe(true);
  });
});
