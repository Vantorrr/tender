import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import {
  applyCommercialQuote,
  assignCalculationOwner,
  createManualProcurement,
  patchScheduleResourceAndSync,
  recordSupplierQuote,
  recomputeCalculationCost,
  saveDirectorDecision,
  sendProcurementToCalculation,
  updateCalculation,
  upsertSupplyRequest,
} from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import { buildBddsFrame, bddsReadiness } from "@/lib/wave5-client";
import { addMoneyPayment } from "@/server/repo";
import "./setup";

const BURENIE_C0 = 280939759.9;
const BURENIE_PRICE = 393315663.86;

const PARAMS = {
  personHourRate: 1400,
  personnelShiftsPerDay: 2,
  hoursPerShift: 11,
  equipmentShiftsPerDay: 2,
  overheadRate: 0.43,
  profitMarkupOnCostWithOh: 0.4,
};

function draftOf(procurementId: string) {
  return readAppData().calculations.find((item) => item.procurementId === procurementId && item.kind === "resource_draft")!;
}

describe("wave 5 client logic", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("keeps the average as a hint, writes the chosen quote into the rate and restores the manual economics", () => {
    const created = createManualProcurement("u-ruk", { title: "КП в ставку", region: "Ямал", nmck: 1_000_000 });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = draftOf(created.id);
    updateCalculation("u-ruk", draft.id, {
      positions: [{
        id: "pipe",
        costRole: "commercial",
        code: "MAT-PIPE",
        name: "Труба",
        unit: "м",
        quantity: 10,
        rate: 100,
        rateMissing: false,
        resourceKind: "material",
      }],
    });
    recomputeCalculationCost("u-ruk", draft.id, {
      useResourceScheduleEconomics: true,
      vatPercent: 20,
      resourceScheduleParams: PARAMS,
      economicsManual: {
        overhead: { mode: "rate", value: 0.2 },
        profit: { mode: "amount", value: 80 },
      },
    });
    mutateAppData((data) => {
      const item = data.calculations.find((row) => row.id === draft.id)!;
      item.referenceReprice = {
        C0: BURENIE_C0,
        C: BURENIE_C0,
        reserve: 0,
        profit: BURENIE_PRICE - BURENIE_C0,
        priceExVat: BURENIE_PRICE,
        vatAmount: null,
        priceIncVat: null,
        method: "reference-reprice-not-cost+fixture",
        incomplete: [],
        at: "2026-11-01T00:00:00.000Z",
      };
      return data;
    });
    const before = readAppData().calculations.find((item) => item.id === draft.id)!;
    const reference = JSON.stringify(before.referenceReprice);
    expect(before.costSummary).toMatchObject({ C0: 1200, reserve: 120, C: 1320, profit: 80, priceExVat: 1400, vatAmount: 280 });
    const supply = upsertSupplyRequest("u-ruk", {
      procurementId: created.id,
      materialName: "Труба",
      unit: "м",
      qtyNeed: 10,
      needBy: "2026-12-01",
    });
    recordSupplierQuote("u-ruk", supply.supplyId, { id: "q-cheap", supplierName: "Дешёвый", unitPrice: 150 });
    recordSupplierQuote("u-ruk", supply.supplyId, { id: "q-dear", supplierName: "Дорогой", unitPrice: 450 });
    const untouched = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(untouched.positions.find((position) => position.id === "pipe")?.rate).toBe(100);
    expect(untouched.positions.find((position) => position.id === "pipe")?.selectedQuoteId).toBeUndefined();

    applyCommercialQuote("u-ruk", draft.id, "pipe", "q-dear");
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(priced.positions.find((position) => position.id === "pipe")).toMatchObject({
      rate: 450,
      selectedQuoteId: "q-dear",
      quoteSupplierName: "Дорогой",
      priceSource: "quote",
      baseRate: 100,
    });
    expect(priced.costSummary).toMatchObject({ C0: 5400, reserve: 540, C: 5940, profit: 80, priceExVat: 6020, vatAmount: 1204 });
    expect(priced.economicsManual).toMatchObject({
      overhead: { mode: "rate", value: 0.2 },
      profit: { mode: "amount", value: 80 },
    });
    expect(JSON.stringify(priced.referenceReprice)).toBe(reference);
    expect(priced.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(priced.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);

    applyCommercialQuote("u-ruk", draft.id, "pipe", null);
    const reset = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(reset.positions.find((position) => position.id === "pipe")).toMatchObject({ rate: 100, priceSource: "manual" });
    expect(reset.positions.find((position) => position.id === "pipe")?.selectedQuoteId).toBeUndefined();
    expect(reset.costSummary).toMatchObject({ C0: 1200, C: 1320, profit: 80, priceExVat: 1400 });
    expect(JSON.stringify(reset.referenceReprice)).toBe(reference);
    expect(reset.economicsManual?.overhead?.value).toBe(0.2);
  });

  it("rejects another organisation, a foreign purchase, a negative price and an extreme price", () => {
    const created = createManualProcurement("u-ruk", { title: "Своя труба", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = draftOf(created.id);
    updateCalculation("u-ruk", draft.id, {
      positions: [{
        id: "pipe",
        costRole: "commercial",
        code: "MAT-PIPE",
        name: "Труба",
        unit: "м",
        quantity: 2,
        rate: 50,
        resourceKind: "material",
      }],
    });
    const otherPurchase = createManualProcurement("u-ruk", { title: "Другая закупка", region: "Ямал" });
    const foreignSupply = upsertSupplyRequest("u-ruk", {
      procurementId: otherPurchase.id,
      materialName: "Труба",
      unit: "м",
      qtyNeed: 1,
      needBy: "2026-12-01",
    });
    recordSupplierQuote("u-ruk", foreignSupply.supplyId, { id: "q-foreign-purchase", supplierName: "Сосед", unitPrice: 80 });
    expect(() => applyCommercialQuote("u-ruk", draft.id, "pipe", "q-foreign-purchase")).toThrow(/разным закупкам/);

    const beta = createManualProcurement("u-beta-tender", { title: "Чужая труба", region: "Ямал" });
    const betaSupply = upsertSupplyRequest("u-beta-tender", {
      procurementId: beta.id,
      materialName: "Труба",
      unit: "м",
      qtyNeed: 1,
      needBy: "2026-12-01",
    });
    recordSupplierQuote("u-beta-tender", betaSupply.supplyId, { id: "q-beta", supplierName: "Бета", unitPrice: 70 });
    expect(() => applyCommercialQuote("u-ruk", draft.id, "pipe", "q-beta")).toThrow(/организац/);
    expect(() => applyCommercialQuote("u-beta-tender", draft.id, "pipe", "q-beta")).toThrow(/организац/);

    const own = upsertSupplyRequest("u-ruk", {
      procurementId: created.id,
      materialName: "Труба",
      unit: "м",
      qtyNeed: 2,
      needBy: "2026-12-01",
    });
    recordSupplierQuote("u-ruk", own.supplyId, { id: "q-bad", supplierName: "Плохая цена", unitPrice: 10 });
    mutateAppData((data) => {
      const quote = data.supplyRequests!.find((item) => item.id === own.supplyId)!.quotes!.find((item) => item.id === "q-bad")!;
      quote.unitPrice = -5;
      return data;
    });
    expect(() => applyCommercialQuote("u-ruk", draft.id, "pipe", "q-bad")).toThrow(/отрицательн/);
    mutateAppData((data) => {
      const quote = data.supplyRequests!.find((item) => item.id === own.supplyId)!.quotes!.find((item) => item.id === "q-bad")!;
      quote.unitPrice = 1_000_000_001;
      return data;
    });
    expect(() => applyCommercialQuote("u-ruk", draft.id, "pipe", "q-bad")).toThrow(/слишком больш/);
    expect(readAppData().calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.id === "pipe")?.rate).toBe(50);
    expect(() => applyCommercialQuote("u-ruk", draft.id, "pipe", "missing-quote")).toThrow(/не найдено/);
  });

  it("stores a director decision when NMCK is at or below full cost and does not auto-refuse", () => {
    const created = createManualProcurement("u-ruk", { title: "Разбор директора", region: "Ямал", nmck: 1000 });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = draftOf(created.id);
    updateCalculation("u-smet", draft.id, {
      participateDecision: "na_rassmotrenii",
      positions: [
        { id: "cable", costRole: "commercial", code: "MAT-CABLE", name: "Кабель", unit: "м", quantity: 5, rate: 4000, resourceKind: "material" },
        { id: "pipe", costRole: "commercial", code: "MAT-PIPE", name: "Труба", unit: "м", quantity: 10, rate: 1000, resourceKind: "material" },
        { id: "sand", costRole: "commercial", code: "MAT-SAND", name: "Песок", unit: "м3", quantity: 2, rate: 3000, resourceKind: "material" },
        { id: "clip", costRole: "commercial", code: "MAT-CLIP", name: "Скоба", unit: "шт", quantity: 1, rate: 100, resourceKind: "material" },
      ],
    });
    recomputeCalculationCost("u-ruk", draft.id, {
      useResourceScheduleEconomics: true,
      vatPercent: 20,
      resourceScheduleParams: PARAMS,
    });
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(priced.committeeSnapshot?.nmckVsCost).toBe("at_or_below_cost");
    expect(priced.committeeSnapshot?.fullCost).toBeCloseTo(priced.costSummary?.C ?? 0, 2);
    expect(priced.participateDecision).toBe("na_rassmotrenii");
    expect(readAppData().organizations.find((item) => item.id === priced.orgId)?.tenderLogic?.nmckAtOrBelowCostPolicy ?? "warn").toBe("warn");
    saveDirectorDecision("u-ruk", draft.id, { choice: "decline", comment: "Цена не покрывает себестоимость, решаем не участвовать." });
    const saved = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(saved.participateDecision).not.toBe("otkaz");
    expect(saved.directorDecision).toMatchObject({
      choice: "decline",
      comment: "Цена не покрывает себестоимость, решаем не участвовать.",
      authorId: "u-ruk",
      authorName: "Павел Руководителев",
    });
    expect(saved.directorDecision?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readAppData().organizations.find((item) => item.id === priced.orgId)?.tenderLogic?.nmckAtOrBelowCostPolicy ?? "warn").toBe("warn");
    const drivers = ["Кабель", "Труба", "Песок"];
    const amounts = saved.positions
      .map((position) => ({ name: position.name, amount: position.quantity * position.rate }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3)
      .map((row) => row.name);
    expect(amounts).toEqual(drivers);
  });

  it("assigns the tender engineer, allows another role to edit, and keeps the organisation boundary", async () => {
    const created = createManualProcurement("u-ruk", { title: "Ответственный за сбор", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = draftOf(created.id);
    expect(draft.ownerUserId).toBe("u-tender");
    expect(draft.ownerRole).toBe("tender");
    assignCalculationOwner("u-ruk", draft.id, "u-smet");
    expect(readAppData().calculations.find((item) => item.id === draft.id)).toMatchObject({
      ownerUserId: "u-smet",
      ownerRole: "smetchik",
    });
    updateCalculation("u-smet", draft.id, { assumptions: ["Правка сметчика без визы остальных служб"] });
    const edited = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(edited.lastEditorId).toBe("u-smet");
    expect(edited.lastEditorName).toBe("Сергей Сметчиков");
    expect(edited.ownerUserId).toBe("u-smet");
    expect(edited.assumptions).toContain("Правка сметчика без визы остальных служб");
    expect(() => assignCalculationOwner("u-ruk", draft.id, "u-beta-tender")).toThrow(/организац/);
    expect(() => updateCalculation("u-beta-tender", draft.id, { title: "Чужое" })).toThrow(/организац/);

    const { POST } = await import("@/app/api/raschety/route");
    const denied = await POST(new Request("http://local/api/raschety", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createSession("u-obj")}`,
      },
      body: JSON.stringify({ action: "assignOwner", calculationId: draft.id, ownerUserId: "u-obj" }),
    }));
    expect(denied.status).toBe(403);

    mutateAppData((data) => {
      data.users.find((user) => user.id === "u-tender")!.blocked = true;
      return data;
    });
    const fallback = createManualProcurement("u-ruk", { title: "Без инженера", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", fallback.id);
    expect(draftOf(fallback.id).ownerUserId).toBe("u-ruk");
    mutateAppData((data) => {
      data.users.find((user) => user.id === "u-tender")!.blocked = false;
      return data;
    });
  });

  it("does not turn money-plan payments into a cash-flow gap", () => {
    const plan = readAppData().moneyPlans[0];
    addMoneyPayment("u-smet", plan.id, {
      type: "postuplenie",
      title: "Выдуманный аванс",
      amount: 999999,
      date: "2026-12-01",
      week: 49,
      month: 12,
    });
    const calc = readAppData().calculations.find((item) => item.id === "c-1")!;
    const stages = readAppData().schedules.filter((item) => item.procurementId === calc.procurementId).flatMap((item) => item.stages);
    const frame = buildBddsFrame(bddsReadiness({ calculation: calc, stages }));
    expect(frame.cashGaps).toBeNull();
    expect(frame.paymentSchedule).toBeNull();
    expect(frame.figures).toBeNull();
    expect(frame.statusText).toMatch(/ждём правила распределения платежей и авансов от Андрея/);
    const text = JSON.stringify(frame);
    expect(text).not.toContain("999999");
    expect(text).not.toContain("Выдуманный аванс");
  });

  it("keeps the burenie reference reprice after a quote is applied and reset", async () => {
    const filePath = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    const parsed = await parseGrandBuffer(fs.readFileSync(filePath));
    const created = createManualProcurement("u-ruk", { title: "Бурение волна 5", region: "Ямал", nmck: 500_000_000 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const uploaded = await saveUpload("wave5-burenie", "ls-02-02-01-burenie.xlsx", fs.readFileSync(filePath));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave5-burenie",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "ЛС бурение",
        fileName: "ls-02-02-01-burenie.xlsx",
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
        estimatePositions: (parsed?.positions ?? []).map((position, index) => ({
          id: `bur-${index + 1}`,
          code: position.code,
          name: position.name,
          unit: position.unit,
          quantity: position.quantity,
          rate: position.rate,
          ...(position.rateMissing ? { rateMissing: true } : {}),
          ...(position.isWorkItem ? { isWorkItem: true } : {}),
          ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
          ...(position.sectionName ? { sectionName: position.sectionName } : {}),
          ...(position.workName ? { workName: position.workName } : {}),
        })),
      });
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = draftOf(created.id);
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true, vatPercent: 20 });
    const baseline = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(baseline.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(baseline.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);
    const reference = JSON.stringify(baseline.referenceReprice);
    updateCalculation("u-ruk", draft.id, {
      positions: [
        ...baseline.positions,
        {
          id: "pipe-commercial",
          costRole: "commercial" as const,
          code: "MAT-PIPE",
          name: "Труба коммерческая",
          unit: "м",
          quantity: 4,
          rate: 100,
          rateMissing: false,
          resourceKind: "material" as const,
        },
      ],
    });
    const supply = upsertSupplyRequest("u-ruk", {
      procurementId: created.id,
      materialName: "Труба коммерческая",
      unit: "м",
      qtyNeed: 4,
      needBy: "2026-12-01",
    });
    recordSupplierQuote("u-ruk", supply.supplyId, { id: "q-bur", supplierName: "Поставщик трубы", unitPrice: 250 });
    applyCommercialQuote("u-ruk", draft.id, "pipe-commercial", "q-bur");
    applyCommercialQuote("u-ruk", draft.id, "pipe-commercial", null);
    const after = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(JSON.stringify(after.referenceReprice)).toBe(reference);
    expect(after.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(after.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);
  });

  it("writes a quote only onto the linked resource and drops the badge after a manual rate edit", () => {
    const created = createManualProcurement("u-ruk", { title: "Две трубы", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = draftOf(created.id);
    updateCalculation("u-ruk", draft.id, {
      positions: [
        { id: "pipe-a", costRole: "commercial", code: "MAT-PIPE", name: "Труба", unit: "м", quantity: 2, rate: 100, sourceResourceId: "res-a", resourceKind: "material" },
        { id: "pipe-b", costRole: "commercial", code: "MAT-PIPE", name: "Труба", unit: "м", quantity: 2, rate: 100, sourceResourceId: "res-b", resourceKind: "material" },
      ],
      resourceScheduleParams: PARAMS,
    });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      data.schedules.unshift({
        id: "g-two-pipes",
        orgId: procurement.orgId,
        procurementId: created.id,
        calculationId: draft.id,
        title: "ГПР двух труб",
        status: "v_rabote",
        version: 1,
        authorId: "u-ruk",
        updatedAt: new Date().toISOString(),
        stages: [
          { id: "st-a", name: "Участок А", start: "2026-12-01", end: "2026-12-05", sequence: 1, resources: [{ id: "res-a", kind: "material", name: "Труба", unit: "м", quantity: 2, rate: 100 }] },
          { id: "st-b", name: "Участок Б", start: "2026-12-06", end: "2026-12-10", sequence: 2, resources: [{ id: "res-b", kind: "material", name: "Труба", unit: "м", quantity: 2, rate: 250 }] },
        ],
      });
      return data;
    });
    const supply = upsertSupplyRequest("u-ruk", {
      procurementId: created.id,
      materialName: "Труба",
      unit: "м",
      qtyNeed: 4,
      needBy: "2026-12-01",
    });
    recordSupplierQuote("u-ruk", supply.supplyId, { id: "q-a", supplierName: "Альфа", unitPrice: 450 });
    recordSupplierQuote("u-ruk", supply.supplyId, { id: "q-b", supplierName: "Бета", unitPrice: 150 });
    applyCommercialQuote("u-ruk", draft.id, "pipe-a", "q-a");
    applyCommercialQuote("u-ruk", draft.id, "pipe-b", "q-b");
    const both = readAppData();
    const resources = both.schedules.find((item) => item.id === "g-two-pipes")!.stages.flatMap((stage) => stage.resources ?? []);
    expect(resources.find((resource) => resource.id === "res-a")?.rate).toBe(450);
    expect(resources.find((resource) => resource.id === "res-b")?.rate).toBe(150);
    const lines = both.calculations.find((item) => item.id === draft.id)!.positions.filter((position) => position.name === "Труба");
    expect(lines.find((position) => position.sourceResourceId === "res-a")).toMatchObject({ selectedQuoteId: "q-a", rate: 450 });
    expect(lines.find((position) => position.sourceResourceId === "res-b")).toMatchObject({ selectedQuoteId: "q-b", rate: 150 });

    applyCommercialQuote("u-ruk", draft.id, "pipe-a", null);
    const afterReset = readAppData();
    const resetResources = afterReset.schedules.find((item) => item.id === "g-two-pipes")!.stages.flatMap((stage) => stage.resources ?? []);
    expect(resetResources.find((resource) => resource.id === "res-a")?.rate).toBe(100);
    expect(resetResources.find((resource) => resource.id === "res-b")?.rate).toBe(150);
    const kept = afterReset.calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.sourceResourceId === "res-b");
    expect(kept).toMatchObject({ selectedQuoteId: "q-b", rate: 150, priceSource: "quote" });

    patchScheduleResourceAndSync("u-ruk", "g-two-pipes", { resourceId: "res-b", stageId: "st-b", rate: 888 });
    const afterGpr = readAppData();
    const gprLine = afterGpr.calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.sourceResourceId === "res-b")!;
    expect(gprLine.rate).toBe(888);
    expect(gprLine.selectedQuoteId).toBeUndefined();
    expect(gprLine.quoteSupplierName).toBeUndefined();
    expect(gprLine.priceSource).toBe("manual");
    expect(afterGpr.calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.sourceResourceId === "res-a")).toMatchObject({ rate: 100 });
    applyCommercialQuote("u-ruk", draft.id, gprLine.id, null);
    expect(readAppData().calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.id === gprLine.id)?.rate).toBe(888);
    expect(readAppData().schedules.find((item) => item.id === "g-two-pipes")!.stages.flatMap((stage) => stage.resources ?? []).find((resource) => resource.id === "res-a")?.rate).toBe(100);

    applyCommercialQuote("u-ruk", draft.id, gprLine.id, "q-b");
    const current = readAppData().calculations.find((item) => item.id === draft.id)!;
    updateCalculation("u-ruk", draft.id, {
      positions: current.positions.map((position) => position.id === gprLine.id ? { ...position, rate: 777 } : position),
    });
    const edited = readAppData().calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.id === gprLine.id)!;
    expect(edited.rate).toBe(777);
    expect(edited.selectedQuoteId).toBeUndefined();
    expect(edited.quoteSupplierName).toBeUndefined();
    expect(edited.priceSource).toBe("manual");
    applyCommercialQuote("u-ruk", draft.id, edited.id, null);
    expect(readAppData().calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.id === edited.id)?.rate).toBe(777);
  });

  it("restores the base rate after the chosen quote leaves the active list", () => {
    const created = createManualProcurement("u-ruk", { title: "Снятое КП", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = draftOf(created.id);
    updateCalculation("u-ruk", draft.id, {
      positions: [{ id: "pipe", costRole: "commercial", code: "MAT-PIPE", name: "Труба", unit: "м", quantity: 2, rate: 100, resourceKind: "material" }],
      resourceScheduleParams: PARAMS,
    });
    const supply = upsertSupplyRequest("u-ruk", {
      procurementId: created.id,
      materialName: "Труба",
      unit: "м",
      qtyNeed: 2,
      needBy: "2026-12-01",
    });
    recordSupplierQuote("u-ruk", supply.supplyId, { id: "q-gone", supplierName: "Альфа", unitPrice: 450 });
    applyCommercialQuote("u-ruk", draft.id, "pipe", "q-gone");
    mutateAppData((data) => {
      const row = data.supplyRequests!.find((item) => item.id === supply.supplyId)!;
      row.status = "cancelled";
      row.materialName = "Другое имя";
      return data;
    });
    const hidden = readAppData().calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.id === "pipe")!;
    expect(hidden).toMatchObject({ rate: 450, priceSource: "quote", selectedQuoteId: "q-gone", quoteUnitPrice: 450 });
    applyCommercialQuote("u-ruk", draft.id, "pipe", null);
    const restored = readAppData().calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.id === "pipe")!;
    expect(restored.rate).toBe(100);
    expect(restored.priceSource).toBe("manual");
    expect(restored.selectedQuoteId).toBeUndefined();
  });
});
