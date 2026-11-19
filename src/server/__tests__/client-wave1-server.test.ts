import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { roundMoney } from "@/lib/calc-math";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import { mergeStageResources } from "@/lib/resource-merge";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import type { GprStage, GprStageResource } from "@/lib/types";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import {
  addCalcPositionFromDirectory,
  addMoneyPayment,
  createManualProcurement,
  ensureProcurementChain,
  createProcurementSchedule,
  sendProcurementToCalculation,
  updateLinkedResourcesFromCalculation,
  deleteGprStage,
  addDailyProductionFact,
  deleteProcurement,
  updateDocument,
  updateMoney,
  updatePlanFact,
} from "@/server/repo";
import { deleteUpload, resolveUploadPath, saveUpload } from "@/server/uploads";
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
    const photo = await saveUpload("wave1-photo", "фото.jpg", Buffer.from("фото"));
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
      data.planFacts.unshift({
        id: "pf-wave1-del",
        orgId: procurement.orgId,
        objectId: "obj-wave1",
        procurementId: procurement.id,
        title: "Фото",
        status: "v_rabote",
        entries: [],
        updatedAt: new Date().toISOString(),
        dailyFacts: [{
          id: "df-wave1",
          date: "2026-12-01",
          workName: "Работа",
          unit: "м2",
          quantity: 1,
          photos: [{ id: "ph-wave1", fileName: "фото.jpg", storedPath: photo.storedPath, at: "2026-12-01T00:00:00Z" }],
          authorId: "u-ruk",
          at: "2026-12-01T00:00:00Z",
        }],
      });
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
    expect(fs.existsSync(path.join(config.dataDir, photo.storedPath))).toBe(false);
  });

  it("does not let a plan-fact photo take or delete another upload", async () => {
    const created = createManualProcurement("u-ruk", { title: "Чужой файл", region: "Ямал" });
    const victim = await saveUpload("wave1-victim", "чужой.txt", Buffer.from("чужой"));
    const own = await saveUpload("wave1-own", "свой.jpg", Buffer.from("свой"));
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      const other = data.procurements.find((item) => item.orgId === procurement.orgId && item.id !== procurement.id);
      if (!other) throw new Error("нет второй закупки");
      data.documents.unshift({
        id: "d-wave1-victim",
        orgId: other.orgId,
        procurementId: other.id,
        title: "Чужой",
        fileName: "чужой.txt",
        fileType: "other",
        status: "zagruzheno",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: victim.storedPath,
      });
      data.planFacts.unshift({
        id: "pf-wave1-plant",
        orgId: procurement.orgId,
        objectId: "obj-wave1",
        procurementId: procurement.id,
        title: "Фото",
        status: "v_rabote",
        entries: [{ id: "e1", workName: "Работа", unit: "м2", plan: 1, fact: 0 }],
        updatedAt: new Date().toISOString(),
        dailyFacts: [{
          id: "df-wave1-plant",
          date: "2026-12-01",
          workName: "Работа",
          unit: "м2",
          quantity: 1,
          photos: [{ id: "ph-own", fileName: "свой.jpg", storedPath: own.storedPath, at: "2026-12-01T00:00:00Z" }],
          authorId: "u-ruk",
          at: "2026-12-01T00:00:00Z",
        }],
      });
      return data;
    });
    updatePlanFact("u-tender", "pf-wave1-plant", {
      dailyFacts: [{
        id: "df-wave1-plant",
        date: "2026-12-01",
        workName: "Работа",
        unit: "м2",
        quantity: 1,
        photos: [
          { id: "ph-own", fileName: "свой.jpg", storedPath: victim.storedPath, at: "2026-12-01T00:00:00Z" },
          { id: "ph-new", fileName: "новый.jpg", storedPath: victim.storedPath, at: "2026-12-01T00:00:00Z" },
        ],
        authorId: "u-tender",
        at: "2026-12-01T00:00:00Z",
      }],
    });
    const patched = readAppData().planFacts.find((item) => item.id === "pf-wave1-plant");
    const photos = patched?.dailyFacts?.[0]?.photos ?? [];
    expect(photos.find((photo) => photo.id === "ph-own")?.storedPath).toBe(own.storedPath);
    expect(photos.find((photo) => photo.id === "ph-new")?.storedPath).toBeUndefined();
    addDailyProductionFact("u-tender", "pf-wave1-plant", {
      date: "2026-12-02",
      workName: "Работа",
      unit: "м2",
      quantity: 1,
      photos: [{ id: "ph-json", fileName: "json.jpg", storedPath: victim.storedPath, at: "2026-12-02T00:00:00Z" }],
    });
    const plantedFact = readAppData().planFacts
      .find((item) => item.id === "pf-wave1-plant")
      ?.dailyFacts?.find((fact) => fact.date === "2026-12-02");
    expect(plantedFact?.photos[0]?.storedPath).toBeUndefined();
    mutateAppData((data) => {
      const plan = data.planFacts.find((item) => item.id === "pf-wave1-plant")!;
      plan.dailyFacts![0].photos.push({
        id: "ph-planted",
        fileName: "чужой.txt",
        storedPath: victim.storedPath,
        at: "2026-12-01T00:00:00Z",
      });
      return data;
    });
    expect(deleteProcurement("u-ruk", created.id).deleted).toBe(true);
    expect(fs.existsSync(path.join(config.dataDir, victim.storedPath))).toBe(true);
    expect(fs.existsSync(path.join(config.dataDir, own.storedPath))).toBe(false);
    expect(readAppData().documents.some((item) => item.id === "d-wave1-victim")).toBe(true);
  });

  it("does not bind or delete an upload through a path alias", async () => {
    const created = createManualProcurement("u-ruk", { title: "Псевдоним файла", region: "Ямал" });
    const victim = await saveUpload("wave1-alias", "чужой.txt", Buffer.from("чужой"));
    const aliases = [
      victim.storedPath.replace(/^uploads\//, "uploads/./"),
      victim.storedPath.replace(/^uploads\//, "uploads//"),
      victim.storedPath.replaceAll("/", "\\"),
    ];
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      const other = data.procurements.find((item) => item.orgId === procurement.orgId && item.id !== procurement.id);
      if (!other) throw new Error("нет второй закупки");
      data.documents.unshift({
        id: "d-wave1-alias",
        orgId: other.orgId,
        procurementId: other.id,
        title: "Чужой",
        fileName: "чужой.txt",
        fileType: "other",
        status: "zagruzheno",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: victim.storedPath,
      });
      data.planFacts.unshift({
        id: "pf-wave1-alias",
        orgId: procurement.orgId,
        objectId: "obj-wave1",
        procurementId: procurement.id,
        title: "Фото",
        status: "v_rabote",
        entries: [{ id: "e1", workName: "Работа", unit: "м2", plan: 1, fact: 0 }],
        updatedAt: new Date().toISOString(),
        dailyFacts: [],
      });
      return data;
    });
    for (const [index, alias] of aliases.entries()) {
      addDailyProductionFact("u-tender", "pf-wave1-alias", {
        date: `2026-12-0${index + 1}`,
        workName: "Работа",
        unit: "м2",
        quantity: 1,
        photos: [{ id: `ph-alias-${index}`, fileName: "json.jpg", storedPath: alias, at: "2026-12-01T00:00:00Z" }],
      });
    }
    const facts = readAppData().planFacts.find((item) => item.id === "pf-wave1-alias")?.dailyFacts ?? [];
    expect(facts.flatMap((fact) => fact.photos).every((photo) => photo.storedPath == null)).toBe(true);
    mutateAppData((data) => {
      const plan = data.planFacts.find((item) => item.id === "pf-wave1-alias")!;
      plan.dailyFacts = [{
        id: "df-alias",
        date: "2026-12-04",
        workName: "Работа",
        unit: "м2",
        quantity: 1,
        photos: [{ id: "ph-alias-kept", fileName: "чужой.txt", storedPath: aliases[0], at: "2026-12-04T00:00:00Z" }],
        authorId: "u-tender",
        at: "2026-12-04T00:00:00Z",
      }];
      return data;
    });
    expect(deleteProcurement("u-ruk", created.id).deleted).toBe(true);
    expect(fs.existsSync(path.join(config.dataDir, victim.storedPath))).toBe(true);
    expect(readAppData().documents.some((item) => item.id === "d-wave1-alias")).toBe(true);
  });

  it("does not delete a file outside the uploads folder and ignores a rewritten path", () => {
    const outside = path.join(config.dataDir, "not-an-upload.txt");
    fs.writeFileSync(outside, "keep");
    deleteUpload("not-an-upload.txt");
    deleteUpload(outside);
    deleteUpload("uploads/../../not-an-upload.txt");
    expect(fs.existsSync(outside)).toBe(true);
    expect(resolveUploadPath("/etc/passwd")).toBeNull();
    fs.unlinkSync(outside);
    mutateAppData((data) => {
      const doc = data.documents.find((item) => item.orgId === "org-alfa");
      if (!doc) throw new Error("нет документа");
      doc.storedPath = "uploads/seed-keep.txt";
      return data;
    });
    const doc = readAppData().documents.find((item) => item.storedPath === "uploads/seed-keep.txt");
    expect(doc).toBeTruthy();
    updateDocument("u-tender", doc!.id, { storedPath: "not-an-upload.txt", title: doc!.title });
    expect(readAppData().documents.find((item) => item.id === doc!.id)?.storedPath).toBe("uploads/seed-keep.txt");
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

  it("lets a calculation editor change resources and still blocks GPR stage edits", async () => {
    const { PATCH: patchCalc } = await import("@/app/api/raschety/route");
    const { PATCH: patchGpr } = await import("@/app/api/gpr/route");
    const headersFor = (userId: string) => ({
      authorization: `Bearer ${createSession(userId)}`,
      "content-type": "application/json",
    });
    const schedule = readAppData().schedules.find((item) => item.id === "g-1")!;
    const withBrick = schedule.stages.map((stage) => stage.id === "gs-2"
      ? { ...stage, resources: [{ id: "res-tender", kind: "material" as const, name: "Кирпич", unit: "шт", quantity: 4, rate: 10 }] }
      : stage);
    const saved = await patchCalc(new Request("http://local/api/raschety", {
      method: "PATCH",
      headers: headersFor("u-tender"),
      body: JSON.stringify({ id: "c-1", linkedResources: { stages: withBrick } }),
    }));
    expect(saved.status).toBe(200);
    const added = readAppData().schedules.find((item) => item.id === "g-1")!;
    expect(added.stages.find((stage) => stage.id === "gs-2")?.resources?.[0]?.rate).toBe(10);
    const rated = added.stages.map((stage) => stage.id === "gs-2"
      ? { ...stage, resources: (stage.resources ?? []).map((resource) => ({ ...resource, rate: 15 })) }
      : stage);
    const rerate = await patchCalc(new Request("http://local/api/raschety", {
      method: "PATCH",
      headers: headersFor("u-tender"),
      body: JSON.stringify({ id: "c-1", linkedResources: { stages: rated } }),
    }));
    expect(rerate.status).toBe(200);
    const afterRate = readAppData().schedules.find((item) => item.id === "g-1")!;
    const removed = afterRate.stages.map((stage) => stage.id === "gs-2" ? { ...stage, resources: [] } : stage);
    const drop = await patchCalc(new Request("http://local/api/raschety", {
      method: "PATCH",
      headers: headersFor("u-tender"),
      body: JSON.stringify({ id: "c-1", linkedResources: { stages: removed } }),
    }));
    expect(drop.status).toBe(200);
    const afterResources = readAppData().schedules.find((item) => item.id === "g-1")!;
    expect(afterResources.stages.find((stage) => stage.id === "gs-2")?.resources ?? []).toEqual([]);
    expect(afterResources.stages.some((stage) => stage.id === "gs-2")).toBe(true);
    const denied = await patchGpr(new Request("http://local/api/gpr", {
      method: "PATCH",
      headers: headersFor("u-tender"),
      body: JSON.stringify({ id: "g-1", action: "deleteStage", stageId: "gs-2" }),
    }));
    expect(denied.status).toBe(403);
    expect(readAppData().schedules.find((item) => item.id === "g-1")!.stages.some((stage) => stage.id === "gs-2")).toBe(true);
    const otherOrg = await patchCalc(new Request("http://local/api/raschety", {
      method: "PATCH",
      headers: headersFor("u-beta-tender"),
      body: JSON.stringify({ id: "c-1", linkedResources: { stages: withBrick } }),
    }));
    expect(otherOrg.status).toBe(403);
  });

  it("returns 403 when a tender specialist tries to delete a procurement", async () => {
    const created = createManualProcurement("u-ruk", { title: "Не его удаление", region: "Ямал" });
    const { POST } = await import("@/app/api/zakupki/route");
    const response = await POST(new Request("http://local/api/zakupki", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-tender")}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "deleteProcurement", id: created.id }),
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Удалять закупку могут руководитель и администратор",
    });
    expect(readAppData().procurements.some((item) => item.id === created.id)).toBe(true);
  });

  it("keeps a legacy zero payment while another payment is deleted", () => {
    const plan = readAppData().moneyPlans[0];
    mutateAppData((data) => {
      const item = data.moneyPlans.find((row) => row.id === plan.id)!;
      item.payments.push(
        { id: "pay-legacy-0", type: "avans", title: "Старый ноль", amount: 0, date: "2026-01-01", week: 1, month: 1 },
        { id: "pay-drop", type: "postuplenie", title: "Убрать", amount: 80, date: "2026-02-01", week: 5, month: 2 },
      );
      return data;
    });
    const current = readAppData().moneyPlans.find((item) => item.id === plan.id)!;
    updateMoney("u-smet", plan.id, { payments: current.payments.filter((payment) => payment.id !== "pay-drop") });
    const saved = readAppData().moneyPlans.find((item) => item.id === plan.id)!;
    expect(saved.payments.some((payment) => payment.id === "pay-legacy-0" && payment.amount === 0)).toBe(true);
    expect(saved.payments.some((payment) => payment.id === "pay-drop")).toBe(false);
    expect(() => updateMoney("u-smet", plan.id, {
      payments: saved.payments.map((payment) => payment.id === "pay-legacy-0" ? payment : { ...payment, amount: 0 }),
    })).toThrow(/больше нуля/);
  });

  it("keeps calculation creation separate from the schedule and reads burenie hours", async () => {
    const parsed = await parseGrandBuffer(fs.readFileSync(path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx")));
    const labor = (parsed?.positions ?? []).filter((position) => position.name === "Затраты труда рабочих");
    const machines = (parsed?.positions ?? []).filter((position) => position.name === "Затраты труда машинистов");
    expect(labor.length).toBeGreaterThan(0);
    expect(machines.length).toBeGreaterThan(0);
    expect(labor[0]?.unit).toMatch(/ч/);
    expect(labor[0]?.quantity).toBeGreaterThan(1);
    const bits = (parsed?.positions ?? []).filter((position) => position.name.startsWith("Долото трехшарошечное III 295"));
    const sections = new Set(bits.map((position) => position.sectionName));
    expect(bits).toHaveLength(3);
    expect(sections.size).toBe(3);
    const created = createManualProcurement("u-ruk", { title: "Только расчёт", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const afterCalc = readAppData().procurements.find((item) => item.id === created.id)!;
    expect(afterCalc.calculationId).toBeTruthy();
    expect(afterCalc.gprId).toBeUndefined();
    expect(afterCalc.reviewStatus).toBe("na_rassmotrenii");
    createProcurementSchedule("u-ruk", created.id);
    expect(readAppData().procurements.find((item) => item.id === created.id)?.gprId).toBeTruthy();
  });

  it("replaces a navigation stub with stages from the estimate", () => {
    const created = createManualProcurement("u-ruk", { title: "Заготовка графика", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    ensureProcurementChain("u-ruk", created.id);
    const stub = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    expect(stub.stages[0]?.name).toBe("Подготовка");
    expect(createProcurementSchedule("u-ruk", created.id).outcome).toBe("placeholder");
    expect(readAppData().schedules.find((item) => item.id === stub.id)!.stages[0]?.name).toBe("Подготовка");
    mutateAppData((data) => {
      const schedule = data.schedules.find((item) => item.id === stub.id)!;
      schedule.calculationId = "stale-calc";
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const relinked = readAppData().schedules.find((item) => item.id === stub.id)!;
    expect(relinked.stages[0]?.name).toBe("Подготовка");
    expect(relinked.calculationId).toBe(readAppData().procurements.find((item) => item.id === created.id)!.calculationId);
    mutateAppData((data) => {
      const draft = data.calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
      draft.positions = [{
        id: "draft-bit",
        code: "ФССЦ-01.4.01.03-0146",
        name: "Долото трехшарошечное III 295,373-ЦВ",
        unit: "шт",
        quantity: 16.5396,
        rate: 0,
        rateMissing: true,
        resourceKind: "material",
        sourceSectionName: "Раздел 1. Бурение скважин",
        sourceWorkName: "Бурение скважин диаметром 450 мм",
      }];
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    expect(readAppData().schedules.find((item) => item.id === stub.id)!.stages[0]?.name).toBe("Подготовка");
    expect(createProcurementSchedule("u-ruk", created.id).outcome).toBe("estimate");
    const schedule = readAppData().schedules.find((item) => item.id === stub.id)!;
    expect(schedule.stages.some((stage) => stage.name === "Подготовка")).toBe(false);
    expect(schedule.stages.some((stage) => stage.sectionName === "Раздел 1. Бурение скважин")).toBe(true);
    expect(schedule.stages.flatMap((stage) => stage.resources ?? []).some((resource) => resource.quantity === 16.5396)).toBe(true);
    expect(createProcurementSchedule("u-ruk", created.id).outcome).toBe("unchanged");
  });

  it("updates the calculation when its last linked resources are cleared and leaves the production plan alone", () => {
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === "c-1")!;
      calc.resourceScheduleParams = { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS };
      const schedule = data.schedules.find((item) => item.id === "g-1")!;
      const stage = schedule.stages.find((item) => item.id === "gs-2")!;
      stage.resources = [{ id: "res-clear", kind: "material", name: "Кирпич", unit: "шт", quantity: 4, rate: 10 }];
      return data;
    });
    const before = readAppData();
    const schedule = before.schedules.find((item) => item.id === "g-1")!;
    const planBefore = JSON.stringify(before.planFacts.find((item) => item.procurementId === schedule.procurementId)?.entries ?? []);
    const workNames = schedule.stages.map((stage) => stage.workName ?? stage.name);
    updateLinkedResourcesFromCalculation("u-tender", "c-1", schedule.stages);
    const linked = readAppData().calculations.find((item) => item.id === "c-1")!;
    expect(linked.positions.some((position) => position.name === "Кирпич")).toBe(true);
    const cleared = readAppData().schedules.find((item) => item.id === "g-1")!.stages.map((stage) =>
      stage.id === "gs-2" ? { ...stage, resources: [] } : stage
    );
    updateLinkedResourcesFromCalculation("u-tender", "c-1", cleared);
    const after = readAppData();
    expect(after.schedules.find((item) => item.id === "g-1")!.stages.find((stage) => stage.id === "gs-2")?.resources ?? []).toEqual([]);
    expect(after.calculations.find((item) => item.id === "c-1")!.positions.some((position) => position.name === "Кирпич")).toBe(false);
    expect(after.schedules.find((item) => item.id === "g-1")!.stages.map((stage) => stage.workName ?? stage.name)).toEqual(workNames);
    expect(JSON.stringify(after.planFacts.find((item) => item.procurementId === schedule.procurementId)?.entries ?? [])).toBe(planBefore);
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
