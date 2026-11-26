import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { bucketsFromPositions } from "@/lib/cost-engine";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import {
  DEFAULT_TENDER_LOGIC_SETTINGS,
  DOC1_7PLUS1_SHIFT_PROFILE,
  REFERENCE_REPRICE_DISCLAIMER,
  resolveTenderLogicSettings,
} from "@/lib/tender-logic-settings";
import type { CostSummarySnapshot } from "@/lib/types";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, getDb, mutateAppData, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import {
  createManualProcurement,
  createProcurementSchedule,
  recomputeCalculationCost,
  shiftGprStage,
  sendProcurementToCalculation,
} from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import "./setup";

const BURENIE_C0 = 280939759.9;
const BURENIE_PRICE = 393315663.86;

function savedSummary(c0: number): CostSummarySnapshot {
  return {
    C0: c0,
    C: c0,
    reserve: 0,
    profit: 0,
    priceExVat: c0,
    vatAmount: null,
    priceIncVat: null,
    method: "saved-legacy",
    incomplete: [],
    totalsIncomplete: false,
    at: "2020-01-01T00:00:00.000Z",
  };
}

describe("wave 1 tender logic", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("uses the documented defaults and ignores an unknown override", () => {
    expect(DEFAULT_TENDER_LOGIC_SETTINGS).toEqual({
      importEstimateRowsMode: "translation_table",
      shiftProfile: "client_2x11_no_weekends",
      nmckAtOrBelowCostPolicy: "warn",
    });
    expect(DOC1_7PLUS1_SHIFT_PROFILE.appliesToSavedResourceScheduleParams).toBe(false);
    expect(resolveTenderLogicSettings({ tenderLogic: { importEstimateRowsMode: "empty_packages" } })).toMatchObject({
      importEstimateRowsMode: "empty_packages",
      shiftProfile: "client_2x11_no_weekends",
      nmckAtOrBelowCostPolicy: "warn",
    });
    expect(resolveTenderLogicSettings({ tenderLogic: { shiftProfile: "not-a-profile" as "excel_current" } }).shiftProfile).toBe("client_2x11_no_weekends");
    expect(EXCEL_RESOURCE_SCHEDULE_DEFAULTS).toMatchObject({
      personHourRate: 1400,
      personnelShiftsPerDay: 2,
      hoursPerShift: 11,
      equipmentShiftsPerDay: 1,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    });
  });

  it("keeps the customer original immutable and does not copy the customer rate into the source sheet", async () => {
    const created = createManualProcurement("u-ruk", { title: "Ставка заказчика", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const uploaded = await saveUpload("wave1-rate", "smeta.xlsx", Buffer.from("estimate"));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave1-rate",
        orgId: procurement.orgId,
        procurementId: created.id,
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
        estimatePositions: [{
          id: "rock-1",
          code: "TEST-ROCK",
          name: "Щебень фракции 20–40",
          unit: "м³",
          quantity: 12,
          rate: 900,
          sectionName: "Раздел 1",
        }],
      });
      data.directories.find((item) => item.type === "rascenki" && item.current)?.rows.unshift({
        code: "TEST-ROCK",
        work: "Щебень фракции 20–40",
        unit: "м³",
        rate: 125,
      });
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const after = readAppData();
    const original = after.calculations.find((item) => item.id === after.procurements.find((row) => row.id === created.id)!.originalCalculationId)!;
    const draft = after.calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    expect(original.immutable).toBe(true);
    expect(original.kind).toBe("customer_original");
    expect(original.positions.map((position) => position.rate)).toEqual([900]);
    expect(draft.positions[0]).toMatchObject({
      costRole: "customer_source",
      code: "TEST-ROCK",
      quantity: 12,
      rate: 125,
      rateMissing: false,
    });
    expect(draft.positions[0]?.rate).not.toBe(900);
    expect(draft.assumptions.join(" ")).toMatch(/цена заказчика не копировалась/i);
    expect(draft.assumptions.join(" ")).not.toMatch(/черновик заполнен/i);
    expect(draft.assumptions.join(" ")).toMatch(/не расчёт себестоимости/i);
  });

  it("loads the burenie workbook, prices the reference sheet at the known total, and leaves the official total unconfirmed", async () => {
    const filePath = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    const parsed = await parseGrandBuffer(fs.readFileSync(filePath));
    expect(parsed?.positions.length).toBeGreaterThan(0);
    const created = createManualProcurement("u-ruk", { title: "Бурение волна 1", region: "Ямал", nmck: 500_000_000 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      const org = data.organizations.find((item) => item.id === procurement.orgId)!;
      org.tenderLogic = { shiftProfile: "doc1_7plus1" };
      return data;
    });
    const uploaded = await saveUpload("wave1-burenie", "ls-02-02-01-burenie.xlsx", fs.readFileSync(filePath));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave1-burenie",
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
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    expect(draft.resourceScheduleParams).toMatchObject({
      personHourRate: 1400,
      personnelShiftsPerDay: 2,
      hoursPerShift: 11,
      equipmentShiftsPerDay: 1,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    });
    const savedParams = { ...draft.resourceScheduleParams! };
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(priced.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(priced.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);
    expect(priced.costSummary?.C0 ?? 0).not.toBeCloseTo(BURENIE_C0, 0);
    expect(priced.costSummary?.C0 ?? 0).not.toBeCloseTo(280972515.48, 0);
    expect(priced.costSummary?.totalsIncomplete).toBe(true);
    expect(priced.dataFlags).toContain("reference_reprice_not_cost");
    expect(priced.positions.every((position) => position.costRole === "customer_source")).toBe(true);
    expect(priced.resourceScheduleParams?.hoursPerShift).toBe(11);
    expect(priced.resourceScheduleParams?.personHourRate).toBe(1400);

    mutateAppData((data) => {
      data.organizations.find((item) => item.id === procurement.orgId)!.tenderLogic = { shiftProfile: "doc1_7plus1" };
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "commercial-1",
        costRole: "commercial",
        code: "LAB-OWN",
        name: "Плотник",
        unit: "чел.-ч",
        quantity: 2,
        rate: 100,
        rateMissing: false,
      });
      calc.participateDecision = "na_rassmotrenii";
      data.procurements.find((item) => item.id === created.id)!.nmck = 10;
      return data;
    });
    recomputeCalculationCost("u-ruk", draft.id, {
      resourceScheduleParams: savedParams,
      useResourceScheduleEconomics: true,
    });
    const withCommercial = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(withCommercial.resourceScheduleParams).toMatchObject({
      personHourRate: 1400,
      hoursPerShift: 11,
      personnelShiftsPerDay: 2,
      equipmentShiftsPerDay: 1,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    });
    expect(withCommercial.costSummary?.C0 ?? 0).toBeGreaterThan(200);
    expect(withCommercial.costSummary?.C0 ?? 0).toBeLessThan(1_000_000);
    expect(withCommercial.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(withCommercial.participateDecision).not.toBe("otkaz");
    expect(withCommercial.committeeSnapshot).toMatchObject({
      nmck: 10,
      targetMarginPercent: null,
      floorMarginPercent: null,
      nmckVsCost: "at_or_below_cost",
    });
    expect(withCommercial.committeeSnapshot?.fullCost).toBeCloseTo(withCommercial.costSummary?.C ?? 0, 2);
    const officialBeforeSchedule = withCommercial.costSummary?.C0 ?? 0;

    createProcurementSchedule("u-ruk", created.id);
    recomputeCalculationCost("u-ruk", draft.id, {
      resourceScheduleParams: savedParams,
      useResourceScheduleEconomics: true,
    });
    const afterSchedule = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(readAppData().procurements.find((item) => item.id === created.id)?.gprId).toBeTruthy();
    expect(afterSchedule.costSummary?.C0 ?? 0).not.toBeCloseTo(BURENIE_C0, 0);
    expect(afterSchedule.costSummary?.C0).toBeCloseTo(officialBeforeSchedule, 2);
    expect(afterSchedule.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(afterSchedule.costSummary?.incomplete ?? []).not.toContain("no_commercial_rows");
    expect(readAppData().schedules.find((item) => item.procurementId === created.id)?.assumptions?.join(" ") ?? "").toMatch(/не коммерческий ГПР/i);
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    shiftGprStage("u-ruk", schedule.id, schedule.stages[0]!.id, 2);
    const shifted = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(shifted.costSummary?.C0 ?? 0).toBeGreaterThan(200);
    expect(shifted.costSummary?.C0 ?? 0).not.toBeCloseTo(BURENIE_C0, 0);
    expect(shifted.costSummary?.incomplete ?? []).not.toContain("no_commercial_rows");
    expect(shifted.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);

    const { buildCalculationXlsx } = await import("@/server/export");
    const workbook = new (await import("exceljs")).Workbook();
    await workbook.xlsx.load(await buildCalculationXlsx(draft.id) as unknown as import("exceljs").Buffer);
    const names = workbook.worksheets.map((sheet) => sheet.name);
    expect(names).toContain("Ведомость из сметы");
    expect(names).toContain("Справочная переоценка");
    const repriceText = workbook.getWorksheet("Справочная переоценка")?.getSheetValues().flat().join(" ") ?? "";
    expect(repriceText).toContain(REFERENCE_REPRICE_DISCLAIMER);
    expect(repriceText).not.toMatch(/переоценка себестоимости|себестоимость переоценки/i);
  });

  it("keeps the commercial total when a GPR date shift rolls up only the customer schedule", async () => {
    const created = createManualProcurement("u-ruk", { title: "Сдвиг не обнуляет", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const uploaded = await saveUpload("wave1-shift", "smeta.xlsx", Buffer.from("estimate"));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave1-shift",
        orgId: procurement.orgId,
        procurementId: created.id,
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
        estimatePositions: [{
          id: "est-bit",
          code: "ФССЦ-01",
          name: "Долото трехшарошечное",
          unit: "шт",
          quantity: 4,
          rate: 900,
          resourceKind: "material",
          sectionName: "Раздел 1. Бурение",
          workName: "Бурение скважины",
        }],
      });
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "own-labor",
        costRole: "commercial",
        code: "LAB-OWN",
        name: "Плотник",
        unit: "чел.-ч",
        quantity: 2,
        rate: 100,
        rateMissing: false,
      });
      calc.vatPercent = 20;
      return data;
    });
    const params = { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS };
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: params, useResourceScheduleEconomics: true, vatPercent: 20 });
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    const direct = 200;
    const overhead = Math.round(direct * 0.43 * 100) / 100;
    expect(priced.costSummary?.C0).toBeCloseTo(direct + overhead, 2);
    createProcurementSchedule("u-ruk", created.id);
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: params, useResourceScheduleEconomics: true, vatPercent: 20 });
    const scheduled = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(scheduled.costSummary?.C0).toBeCloseTo(direct + overhead, 2);
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    shiftGprStage("u-ruk", schedule.id, schedule.stages[0]!.id, 4);
    const shifted = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(shifted.costSummary?.C0).toBeCloseTo(direct + overhead, 2);
    expect(shifted.costSummary?.C0 ?? 0).not.toBe(0);
    expect(shifted.positions.some((position) => position.costRole === "commercial" && position.name === "Плотник")).toBe(true);
  });

  it("keeps an unlinked other-bucket commercial row in C0, price and the resource slices", async () => {
    const created = createManualProcurement("u-ruk", { title: "Прочая услуга", region: "Ямал", nmck: 100_000 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const uploaded = await saveUpload("wave1-other", "smeta.xlsx", Buffer.from("estimate"));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave1-other",
        orgId: procurement.orgId,
        procurementId: created.id,
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
        estimatePositions: [{
          id: "est-bit",
          code: "ФССЦ-01",
          name: "Долото трехшарошечное",
          unit: "шт",
          quantity: 4,
          rate: 900,
          resourceKind: "material",
          sectionName: "Раздел 1. Бурение",
          workName: "Бурение скважины",
        }],
      });
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "own-other",
        costRole: "commercial",
        code: "SRV-1",
        name: "Прочая услуга",
        unit: "усл",
        quantity: 2,
        rate: 100,
        rateMissing: false,
        resourceKind: "other",
      });
      return data;
    });
    const params = { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS };
    const direct = 200;
    const overhead = Math.round(direct * 0.43 * 100) / 100;
    const cost = Math.round((direct + overhead) * 100) / 100;
    const reserve = Math.round(cost * 0.1 * 100) / 100;
    const profit = Math.round(cost * 0.4 * 100) / 100;
    const price = Math.round((cost + reserve + profit) * 100) / 100;
    const rollupTotal = price;
    createProcurementSchedule("u-ruk", created.id);
    recomputeCalculationCost("u-ruk", draft.id, {
      resourceScheduleParams: params,
      useResourceScheduleEconomics: true,
      vatPercent: 20,
    });
    const scheduled = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(scheduled.costSummary?.C0).toBeCloseTo(cost, 2);
    expect(scheduled.costSummary?.priceExVat).toBeCloseTo(price, 2);
    expect(scheduled.costSummary?.resourceSlices?.direct).toBeCloseTo(direct, 2);
    expect(scheduled.costSummary?.resourceSlices?.total).toBeCloseTo(rollupTotal, 2);
    expect(scheduled.committeeSnapshot?.fullCost).toBeCloseTo(scheduled.costSummary?.C ?? 0, 2);
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    shiftGprStage("u-ruk", schedule.id, schedule.stages[0]!.id, 3);
    const shifted = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(shifted.costSummary?.C0).toBeCloseTo(cost, 2);
    expect(shifted.costSummary?.priceExVat).toBeCloseTo(price, 2);
    expect(shifted.costSummary?.resourceSlices?.direct).toBeCloseTo(direct, 2);
    expect(shifted.costSummary?.resourceSlices?.total).toBeCloseTo(rollupTotal, 2);
    expect(shifted.committeeSnapshot?.fullCost).toBeCloseTo(shifted.costSummary?.C ?? 0, 2);
  });

  it("does not mark a confirmed commercial total incomplete because the customer sheet has no rate", async () => {
    const created = createManualProcurement("u-ruk", { title: "Ведомость не дыра", region: "Ямал", nmck: 1000 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const uploaded = await saveUpload("wave1-gap", "smeta.xlsx", Buffer.from("estimate"));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave1-gap",
        orgId: procurement.orgId,
        procurementId: created.id,
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
        estimatePositions: [{
          id: "est-arm",
          code: "NO-OWN-RATE",
          name: "Арматура",
          unit: "т",
          quantity: 80,
          rate: 75,
          resourceKind: "material",
          sectionName: "Раздел 2. Монтаж",
          workName: "Монтаж конструкций",
        }],
      });
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "own-labor",
        costRole: "commercial",
        code: "LAB-OWN",
        name: "Плотник",
        unit: "чел.-ч",
        quantity: 2,
        rate: 100,
        rateMissing: false,
      });
      return data;
    });
    createProcurementSchedule("u-ruk", created.id);
    recomputeCalculationCost("u-ruk", draft.id, {
      resourceScheduleParams: { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS },
      useResourceScheduleEconomics: true,
      vatPercent: 20,
    });
    const saved = readAppData().calculations.find((item) => item.id === draft.id)!;
    const direct = 200;
    const overhead = Math.round(direct * 0.43 * 100) / 100;
    expect(saved.costSummary?.C0).toBeCloseTo(direct + overhead, 2);
    expect(saved.costSummary?.totalsIncomplete).toBe(false);
    expect(saved.costSummary?.incomplete ?? []).not.toContain("no_commercial_rows");
    expect(saved.costSummary?.incomplete ?? []).not.toContain("rate:Арматура");
    expect(saved.costSummary?.priceIncVat).toBeCloseTo((saved.costSummary?.priceExVat ?? 0) * 1.2, 2);
    expect(saved.committeeSnapshot?.nmckVsCost).toBe("above_cost");
    expect(saved.committeeSnapshot?.fullCost).toBeCloseTo(Math.round((direct + overhead) * 1.1 * 100) / 100, 2);
  });

  it("leaves the commercial draft empty in empty_packages mode and ignores customer-source rows in buckets", async () => {
    const buckets = bucketsFromPositions([
      { id: "s", code: "A", name: "Смета", unit: "м3", quantity: 2, rate: 10, costRole: "customer_source" },
      { id: "c", code: "B", name: "Своя", unit: "м3", quantity: 3, rate: 10, costRole: "commercial" },
    ]);
    expect(buckets.materials + buckets.labor + buckets.equipment + buckets.other).toBe(30);

    const created = createManualProcurement("u-ruk", { title: "Пустые пакеты", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const uploaded = await saveUpload("wave1-empty", "smeta.xlsx", Buffer.from("estimate"));
    mutateAppData((data) => {
      data.organizations.find((item) => item.id === procurement.orgId)!.tenderLogic = { importEstimateRowsMode: "empty_packages" };
      data.documents.unshift({
        id: "doc-wave1-empty",
        orgId: procurement.orgId,
        procurementId: created.id,
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
        estimatePositions: [{ id: "e1", code: "A", name: "Работа", unit: "м", quantity: 4, rate: 50 }],
      });
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const after = readAppData();
    const draft = after.calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    const original = after.calculations.find((item) => item.id === after.procurements.find((row) => row.id === created.id)!.originalCalculationId)!;
    expect(draft.positions).toHaveLength(0);
    expect(original.immutable).toBe(true);
    expect(original.positions).toHaveLength(1);
    expect(after.documents.find((item) => item.id === "doc-wave1-empty")?.estimatePositions).toHaveLength(1);
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true });
    const recomputed = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(recomputed.referenceReprice).toBeUndefined();
    expect(recomputed.costSummary?.totalsIncomplete).toBe(true);
    expect(recomputed.costSummary?.C0).toBe(0);
  });

  it("keeps a legacy seeded total through migration and reading, and does not rewrite the rows on recompute", () => {
    const created = createManualProcurement("u-ruk", { title: "Старый черновик", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions = [{
        id: "legacy-1",
        code: "LAB-1",
        name: "Плотник",
        unit: "чел.-ч",
        quantity: 10,
        rate: 100,
        sourceDocumentId: "doc-legacy",
        sourcePositionId: "legacy-row",
      }];
      calc.costSummary = savedSummary(999);
      calc.dataFlags = ["seeded_from_customer_estimate", "requires_manual_check"];
      calc.participateDecision = "uchastvovat";
      return data;
    });
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '20')").run();
    closeDb();
    ensureReady();
    const migrated = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(migrated.costSummary?.C0).toBe(999);
    expect(migrated.positions[0]?.costRole).toBeUndefined();
    expect(migrated.positions[0]?.rate).toBe(100);
    expect(migrated.dataFlags).toContain("legacy_estimate_seeded_cost");
    expect(readAppData().calculations.find((item) => item.id === draft.id)?.costSummary?.C0).toBe(999);
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true, resourceScheduleParams: { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS } });
    const recomputed = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(recomputed.positions[0]?.costRole).toBeUndefined();
    expect(recomputed.costSummary?.C0 ?? 0).toBeGreaterThan(0);
    expect(recomputed.participateDecision).not.toBe("otkaz");
    expect(recomputed.referenceReprice).toBeUndefined();
  });

  it("returns 403 when createGpr is called without the schedule right", async () => {
    const created = createManualProcurement("u-ruk", { title: "Право на ГПР", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const { POST } = await import("@/app/api/zakupki/route");
    const denied = await POST(new Request("http://local/api/zakupki", {
      method: "POST",
      headers: {
        authorization: `Bearer ${createSession("u-tender")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "createGpr", id: created.id }),
    }));
    expect(denied.status).toBe(403);
    expect(readAppData().procurements.find((item) => item.id === created.id)?.gprId).toBeUndefined();
  });
});
