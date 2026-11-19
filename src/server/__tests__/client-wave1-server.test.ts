import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { roundMoney } from "@/lib/calc-math";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import { mergeStageResources } from "@/lib/resource-merge";
import type { GprStage, GprStageResource } from "@/lib/types";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import {
  addCalcPositionFromDirectory,
  addMoneyPayment,
  createManualProcurement,
  deleteGprStage,
  deleteProcurement,
} from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import { config } from "@/server/config";
import "./setup";

const stageDates = { id: "s", name: "Бурение", sequence: 1, start: "2026-01-01", end: "2026-01-10" };

function knownMoney(resources: GprStageResource[]) {
  let sum = 0;
  for (const resource of resources) {
    const resolved = resolveResourceDimensions(resource, stageDates);
    if (resolved.amount != null) sum = roundMoney(sum + resolved.amount);
  }
  return sum;
}

describe("client wave 1 server", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("adds equipment with a zero directory rate and marks the rate as missing", () => {
    mutateAppData((data) => {
      const park = data.directories.find((item) => item.type === "park" && item.current);
      if (!park) throw new Error("no park");
      park.rows.push({ code: "EQ-ZERO", name: "Буровая", unit: "маш.-ч", rate: 0 });
      return data;
    });
    const calc = readAppData().calculations.find((item) => item.kind === "resource_draft");
    expect(calc).toBeTruthy();
    addCalcPositionFromDirectory("u-smet", calc!.id, { type: "park", code: "EQ-ZERO", quantity: 1 });
    const added = readAppData().calculations.find((item) => item.id === calc!.id)!
      .positions.find((position) => position.code === "EQ-ZERO");
    expect(added?.rateMissing).toBe(true);
    expect(added?.rate).toBe(0);
  });

  it("stores the payment type the user chose, including a legacy key payment", () => {
    const plan = readAppData().moneyPlans[0];
    addMoneyPayment("u-smet", plan.id, {
      type: "spisanie",
      title: "Аванс 2 этап",
      amount: 300_000,
      date: "2026-12-01",
      week: 49,
      month: 12,
    });
    addMoneyPayment("u-smet", plan.id, {
      type: "klyuchevoy",
      title: "Оплата этапа отделки",
      amount: 10,
      date: "2026-12-02",
      week: 49,
      month: 12,
    });
    const saved = readAppData().moneyPlans.find((item) => item.id === plan.id)!.payments;
    expect(saved.find((payment) => payment.amount === 300_000)?.type).toBe("spisanie");
    expect(saved.find((payment) => payment.amount === 10 && payment.title === "Оплата этапа отделки")?.type).toBe("klyuchevoy");
  });

  it("lets only a manager delete a procurement, its file and its own exchange", async () => {
    const created = createManualProcurement("u-ruk", { title: "На удаление", region: "Ямал" });
    const stored = await saveUpload("wave1-del", "файл.txt", Buffer.from("документ"));
    const other = await saveUpload("wave1-keep", "чужой.txt", Buffer.from("чужой"));
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      data.documents.unshift({
        id: "d-wave1-del",
        orgId: procurement.orgId,
        procurementId: procurement.id,
        title: "Файл",
        fileName: "файл.txt",
        fileType: "other",
        status: "zagruzheno",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: stored.storedPath,
      });
      data.smetaExchanges.unshift(
        {
          id: "sx-wave1-own",
          orgId: procurement.orgId,
          procurementId: procurement.id,
          name: `Смета · ${procurement.id}`,
          at: new Date().toISOString(),
          authorId: "u-ruk",
          positionsMapped: 1,
          discrepancies: [],
          confirmed: true,
        },
        {
          id: "sx-wave1-other",
          orgId: procurement.orgId,
          procurementId: "p-10",
          name: `Чужая смета упоминает ${procurement.id}`,
          at: new Date().toISOString(),
          authorId: "u-ruk",
          positionsMapped: 1,
          discrepancies: [],
          confirmed: true,
        },
      );
      return data;
    });
    expect(() => deleteProcurement("u-tender", created.id)).toThrow(/руководитель/);
    expect(readAppData().procurements.some((item) => item.id === created.id)).toBe(true);
    expect(deleteProcurement("u-ruk", created.id).deleted).toBe(true);
    expect(deleteProcurement("u-ruk", created.id).deleted).toBe(false);
    const after = readAppData();
    expect(after.procurements.some((item) => item.id === created.id)).toBe(false);
    expect(after.documents.some((item) => item.id === "d-wave1-del")).toBe(false);
    expect(after.smetaExchanges.some((item) => item.id === "sx-wave1-own")).toBe(false);
    expect(after.smetaExchanges.some((item) => item.id === "sx-wave1-other")).toBe(true);
    expect(fs.existsSync(path.join(config.dataDir, stored.storedPath))).toBe(false);
    expect(fs.existsSync(path.join(config.dataDir, other.storedPath))).toBe(true);
  });

  it("returns 404 when the same procurement is deleted twice", async () => {
    const created = createManualProcurement("u-ruk", { title: "Повторное удаление", region: "Ямал" });
    const stored = await saveUpload("wave1-twice", "ещё.txt", Buffer.from("ещё"));
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      data.documents.unshift({
        id: "d-wave1-twice",
        orgId: procurement.orgId,
        procurementId: procurement.id,
        title: "Файл",
        fileName: "ещё.txt",
        fileType: "other",
        status: "zagruzheno",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: stored.storedPath,
      });
      return data;
    });
    const { POST } = await import("@/app/api/zakupki/route");
    const call = () => POST(new Request("http://local/api/zakupki", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-ruk")}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "deleteProcurement", id: created.id }),
    }));
    const [first, second] = await Promise.all([call(), call()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 404]);
    expect(readAppData().procurements.some((item) => item.id === created.id)).toBe(false);
    expect(fs.existsSync(path.join(config.dataDir, stored.storedPath))).toBe(false);
    const again = await call();
    expect(again.status).toBe(404);
  });

  it("rejects a tender specialist without GPR access from deleting or editing a stage", async () => {
    const before = readAppData().schedules.find((item) => item.id === "g-1")!;
    const { PATCH } = await import("@/app/api/gpr/route");
    const call = (body: unknown) => PATCH(new Request("http://local/api/gpr", {
      method: "PATCH",
      headers: { authorization: `Bearer ${createSession("u-tender")}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect((await call({ id: "g-1", action: "deleteStage", stageId: "gs-2" })).status).toBe(403);
    expect((await call({ id: "g-1", patch: { title: "Чужая правка" } })).status).toBe(403);
    const after = readAppData().schedules.find((item) => item.id === "g-1")!;
    expect(after.stages.some((item) => item.id === "gs-2")).toBe(true);
    expect(after.title).toBe(before.title);
  });

  it("rejects a payment amount of zero or an invalid number", () => {
    const plan = readAppData().moneyPlans[0];
    const before = plan.payments.length;
    const row = { type: "avans" as const, title: "Пустая сумма", date: "2026-12-01", week: 49, month: 12 };
    expect(() => addMoneyPayment("u-smet", plan.id, { ...row, amount: 0 })).toThrow(/больше нуля/);
    expect(() => addMoneyPayment("u-smet", plan.id, { ...row, amount: Number.NaN })).toThrow(/больше нуля/);
    expect(() => addMoneyPayment("u-smet", plan.id, { ...row, amount: -5 })).toThrow(/больше нуля/);
    expect(readAppData().moneyPlans.find((item) => item.id === plan.id)!.payments).toHaveLength(before);
  });

  it("removes a GPR stage together with dependencies and resource links", () => {
    mutateAppData((data) => {
      const schedule = data.schedules.find((item) => item.id === "g-1")!;
      const stage = schedule.stages.find((item) => item.id === "gs-2")!;
      stage.resources = [{ id: "res-gs2", kind: "material", name: "Кирпич", unit: "шт", quantity: 4, rate: 10 }];
      const calc = data.calculations.find((item) => item.id === schedule.calculationId)!;
      calc.positions.push({
        id: "pos-gs2",
        sourceResourceId: "res-gs2",
        code: "М",
        name: "Кирпич",
        unit: "шт",
        quantity: 4,
        rate: 10,
      });
      const plan = data.planFacts.find((item) => item.procurementId === schedule.procurementId)!;
      plan.dailyFacts = [{
        id: "df-gs2",
        date: "2026-12-22",
        workName: "Демонтаж перегородок",
        unit: "м2",
        quantity: 1,
        resourceLines: [{ kind: "material", sourceResourceId: "res-gs2", name: "Кирпич", unit: "шт", planQty: 4, factQty: 1 }],
        photos: [],
        authorId: "u-obj",
        at: "2026-12-22T08:00:00Z",
      }];
      return data;
    });
    deleteGprStage("u-smet", "g-1", "gs-2");
    const schedule = readAppData().schedules.find((item) => item.id === "g-1")!;
    expect(schedule.stages.some((item) => item.id === "gs-2")).toBe(false);
    expect(schedule.stages.find((item) => item.id === "gs-3")?.dependsOn).toBeUndefined();
    expect(schedule.stages.find((item) => item.id === "gs-4")?.dependsOn).toBeUndefined();
    const plan = readAppData().planFacts.find((item) => item.procurementId === "p-1")!;
    expect(plan.entries.some((entry) => entry.workName === "Демонтаж перегородок")).toBe(false);
    expect(plan.dailyFacts?.[0]?.resourceLines ?? []).toEqual([]);
    const calc = readAppData().calculations.find((item) => item.id === schedule.calculationId)!;
    expect(calc.positions.some((position) => position.id === "pos-gs2")).toBe(false);
  });

  it("keeps the burenie resource total after identical lines are merged", async () => {
    const parsed = await parseGrandBuffer(fs.readFileSync(path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx")));
    expect(parsed?.positions.length).toBeGreaterThan(0);
    const resources: GprStageResource[] = (parsed?.positions ?? [])
      .filter((position) => !position.isWorkItem && position.quantity !== 0)
      .map((position, index) => {
        const hour = /(?:маш|чел|н)\s*[.\-]*\s*ч|час/iu.test(position.unit);
        const kind = position.resourceKind && position.resourceKind !== "other"
          ? position.resourceKind
          : hour ? "labor" : "material";
        return {
          id: `bur-${index}`,
          kind,
          name: position.name,
          unit: position.unit,
          quantity: position.quantity,
          rate: position.rate > 0 ? position.rate : null,
          quantityBasis: kind === "material" || !hour ? "material_qty" as const : "total_hours" as const,
        };
      });
    const merged = mergeStageResources(resources);
    expect(knownMoney(merged)).toBe(knownMoney(resources));
    const stage: GprStage = { ...stageDates, resources: merged };
    const [node] = buildHierarchicalEstimate({ stages: [stage] });
    expect(node.subtotal ?? 0).toBe(knownMoney(resources));
  });

  it("does not create a calculation when a document file is downloaded", async () => {
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.calculationId = undefined;
      procurement.gprId = undefined;
      procurement.reviewStatus = "novaya";
      procurement.status = "zagruzheno";
      return data;
    });
    const document = readAppData().documents.find((item) => item.procurementId === "p-2");
    expect(document).toBeTruthy();
    const { GET } = await import("@/app/api/dokumenty/file/route");
    const response = await GET(new Request(`http://local/api/dokumenty/file?id=${document!.id}`, {
      headers: { authorization: `Bearer ${createSession("u-tender")}` },
    }));
    expect(response.status).toBe(200);
    const procurement = readAppData().procurements.find((item) => item.id === "p-2")!;
    expect(procurement.calculationId).toBeUndefined();
    expect(procurement.gprId).toBeUndefined();
    expect(procurement.reviewStatus).toBe("novaya");
    expect(procurement.status).toBe("zagruzheno");
  });
});
