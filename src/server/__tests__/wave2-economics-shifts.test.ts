import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { roundMoney } from "@/lib/calc-math";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import {
  DEFAULT_TENDER_LOGIC_SETTINGS,
  DOC1_7PLUS1_SHIFT_PROFILE,
  SHIFT_PROFILE_OPTIONS,
  nmckAtOrBelowCostWarning,
  resolveTenderLogicSettings,
} from "@/lib/tender-logic-settings";
import { closeDb, ensureReady, getDb, mutateAppData, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import {
  createManualProcurement,
  createProcurementSchedule,
  recomputeCalculationCost,
  sendProcurementToCalculation,
} from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import "./setup";

const BURENIE_C0 = 280939759.9;
const BURENIE_PRICE = 393315663.86;

function attachEstimate(procurementId: string, orgId: string, id: string) {
  return saveUpload(`wave2-${id}`, "smeta.xlsx", Buffer.from("estimate")).then((uploaded) => {
    mutateAppData((data) => {
      data.documents.unshift({
        id: `doc-${id}`,
        orgId,
        procurementId,
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
          id: `est-${id}`,
          code: "MAT-OWN",
          name: "Бетон",
          unit: "м3",
          quantity: 10,
          rate: 100,
          resourceKind: "material",
        }],
      });
      return data;
    });
  });
}

describe("wave 2 client economics and shifts", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("prices a new official draft as C0 × 1.50 and keeps a manual line across recalculation", async () => {
    const created = createManualProcurement("u-ruk", { title: "Формула клиента", region: "Ямал", nmck: 5_000_000 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    await attachEstimate(created.id, procurement.orgId, "formula");
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "own-concrete",
        costRole: "commercial",
        code: "MAT-OWN",
        name: "Бетон товарный",
        unit: "м3",
        quantity: 10,
        rate: 100,
        rateMissing: false,
        resourceKind: "material",
      });
      calc.participateDecision = "uchastvovat";
      return data;
    });
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true, vatPercent: 20 });
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    const direct = 1000;
    const overhead = roundMoney(direct * 0.43);
    const C0 = roundMoney(direct + overhead);
    const reserve = roundMoney(C0 * 0.1);
    const profit = roundMoney(C0 * 0.4);
    const fullCost = roundMoney(C0 + reserve);
    const price = roundMoney(fullCost + profit);
    expect(priced.costSummary?.overhead).toBeCloseTo(overhead, 2);
    expect(priced.costSummary?.C0).toBeCloseTo(C0, 2);
    expect(priced.costSummary?.reserve).toBeCloseTo(reserve, 2);
    expect(priced.costSummary?.C).toBeCloseTo(fullCost, 2);
    expect(priced.costSummary?.profit).toBeCloseTo(profit, 2);
    expect(priced.costSummary?.priceExVat).toBeCloseTo(price, 2);
    expect(priced.costSummary?.priceExVat).toBeCloseTo(C0 * 1.5, 2);
    expect(priced.costSummary?.priceExVat).not.toBeCloseTo(C0 * 1.54, 2);
    expect(priced.costSummary?.manualLines ?? []).toEqual([]);
    expect(priced.committeeSnapshot?.fullCost).toBeCloseTo(fullCost, 2);
    expect(priced.participateDecision).toBe("uchastvovat");

    recomputeCalculationCost("u-ruk", draft.id, {
      useResourceScheduleEconomics: true,
      economicsManual: { overhead: { mode: "amount", value: 100 } },
    });
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true });
    const overheadHeld = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(overheadHeld.costSummary?.manualLines).toContain("overhead");
    expect(overheadHeld.costSummary?.overhead).toBe(100);
    expect(overheadHeld.costSummary?.C0).toBeCloseTo(roundMoney(direct + 100), 2);
    expect(overheadHeld.economicsManual?.overhead).toEqual({ mode: "amount", value: 100 });

    recomputeCalculationCost("u-ruk", draft.id, {
      useResourceScheduleEconomics: true,
      economicsManual: { reserve: { mode: "amount", value: 50 } },
    });
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true });
    const reserveHeld = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(reserveHeld.costSummary?.manualLines).toEqual(expect.arrayContaining(["overhead", "reserve"]));
    expect(reserveHeld.costSummary?.reserve).toBe(50);
    expect(reserveHeld.costSummary?.overhead).toBe(100);

    recomputeCalculationCost("u-ruk", draft.id, {
      useResourceScheduleEconomics: true,
      economicsManual: { profit: { mode: "amount", value: 70 } },
    });
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true });
    const profitHeld = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(profitHeld.costSummary?.manualLines).toEqual(expect.arrayContaining(["overhead", "reserve", "profit"]));
    expect(profitHeld.costSummary?.profit).toBe(70);
    expect(profitHeld.costSummary?.reserve).toBe(50);
    expect(profitHeld.costSummary?.overhead).toBe(100);
    expect(profitHeld.costSummary?.priceExVat).toBeCloseTo(roundMoney((profitHeld.costSummary?.C ?? 0) + 70), 2);

    recomputeCalculationCost("u-ruk", draft.id, {
      useResourceScheduleEconomics: true,
      economicsManual: { overhead: null, reserve: null, profit: null },
    });
    const reset = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(reset.costSummary?.manualLines ?? []).toEqual([]);
    expect(reset.economicsManual?.overhead).toBeUndefined();
    expect(reset.costSummary?.C0).toBeCloseTo(C0, 2);
    expect(reset.costSummary?.reserve).toBeCloseTo(reserve, 2);
    expect(reset.costSummary?.profit).toBeCloseTo(profit, 2);
    expect(reset.costSummary?.priceExVat).toBeCloseTo(price, 2);
  });

  it("uses 2×11 without weekends for a new calculation and does not rewrite a saved profile", async () => {
    expect(DEFAULT_TENDER_LOGIC_SETTINGS.shiftProfile).toBe("client_2x11_no_weekends");
    expect(DOC1_7PLUS1_SHIFT_PROFILE.appliesToSavedResourceScheduleParams).toBe(false);
    expect(SHIFT_PROFILE_OPTIONS.map((option) => option.id)).toEqual([
      "client_2x11_no_weekends",
      "excel_current",
      "doc1_7plus1",
    ]);
    expect(EXCEL_RESOURCE_SCHEDULE_DEFAULTS.equipmentShiftsPerDay).toBe(1);
    expect(EXCEL_RESOURCE_SCHEDULE_DEFAULTS.personHourRate).toBe(1400);

    const created = createManualProcurement("u-ruk", { title: "Новый профиль", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    await attachEstimate(created.id, procurement.orgId, "shifts");
    sendProcurementToCalculation("u-ruk", created.id);
    createProcurementSchedule("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    expect(draft.resourceScheduleParams).toMatchObject({
      personHourRate: 1400,
      personnelShiftsPerDay: 2,
      equipmentShiftsPerDay: 2,
      hoursPerShift: 11,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    });
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    expect(schedule.calendar?.weekendDays).toEqual([]);
    const equipment = resolveResourceDimensions(
      { id: "eq-1", kind: "equipment", name: "Кран", unit: "маш", quantity: 1, rate: 100, quantityBasis: "count_per_shift" },
      { id: "stage-1", start: "2026-11-02", end: "2026-11-02" },
      draft.resourceScheduleParams,
    );
    expect(equipment.basis).toBe("count_per_shift");
    expect(equipment.shiftsPerDay).toBe(2);
    expect(equipment.hoursPerShift).toBe(11);
    expect(equipment.hours).toBe(22);
    const pinned = resolveResourceDimensions(
      { id: "eq-2", kind: "equipment", name: "Бульдозер", unit: "маш", quantity: 1, rate: 100, quantityBasis: "count_per_shift", shiftsPerDay: 1 },
      { id: "stage-1", start: "2026-11-02", end: "2026-11-02" },
      draft.resourceScheduleParams,
    );
    expect(pinned.shiftsPerDay).toBe(1);

    const saved = {
      ...draft.resourceScheduleParams!,
      equipmentShiftsPerDay: 1,
      personHourRate: 1400,
    };
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.resourceScheduleParams = saved;
      const row = data.schedules.find((item) => item.id === schedule.id)!;
      row.calendar = { weekendDays: [0, 6], hoursPerShift: 8, shiftsPerDay: 1, timezone: "Asia/Krasnoyarsk" };
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    createProcurementSchedule("u-ruk", created.id);
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '20')").run();
    closeDb();
    ensureReady();
    const kept = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(kept.resourceScheduleParams).toMatchObject({
      personHourRate: 1400,
      equipmentShiftsPerDay: 1,
      personnelShiftsPerDay: 2,
      hoursPerShift: 11,
    });
    expect(readAppData().schedules.find((item) => item.id === schedule.id)?.calendar?.weekendDays).toEqual([0, 6]);
  });

  it("keeps excel and 7+1 as options and does not make 7+1 the default", async () => {
    expect(resolveTenderLogicSettings({ tenderLogic: { shiftProfile: "excel_current" } }).shiftProfile).toBe("excel_current");
    expect(resolveTenderLogicSettings({ tenderLogic: { shiftProfile: "doc1_7plus1" } }).shiftProfile).toBe("doc1_7plus1");

    const excel = createManualProcurement("u-ruk", { title: "Профиль Excel", region: "Ямал" });
    const excelProcurement = readAppData().procurements.find((item) => item.id === excel.id)!;
    mutateAppData((data) => {
      data.organizations.find((item) => item.id === excelProcurement.orgId)!.tenderLogic = { shiftProfile: "excel_current" };
      return data;
    });
    await attachEstimate(excel.id, excelProcurement.orgId, "excel");
    sendProcurementToCalculation("u-ruk", excel.id);
    createProcurementSchedule("u-ruk", excel.id);
    const excelDraft = readAppData().calculations.find((item) => item.procurementId === excel.id && item.kind === "resource_draft")!;
    expect(excelDraft.resourceScheduleParams?.equipmentShiftsPerDay).toBe(1);
    expect(excelDraft.resourceScheduleParams?.personHourRate).toBe(1400);
    expect(readAppData().schedules.find((item) => item.procurementId === excel.id)?.calendar?.weekendDays ?? [0, 6]).toEqual([0, 6]);

    mutateAppData((data) => {
      data.organizations.find((item) => item.id === excelProcurement.orgId)!.tenderLogic = { shiftProfile: "doc1_7plus1" };
      return data;
    });
    const seven = createManualProcurement("u-ruk", { title: "Профиль 7+1", region: "Ямал" });
    const sevenProcurement = readAppData().procurements.find((item) => item.id === seven.id)!;
    await attachEstimate(seven.id, sevenProcurement.orgId, "seven");
    sendProcurementToCalculation("u-ruk", seven.id);
    const sevenDraft = readAppData().calculations.find((item) => item.procurementId === seven.id && item.kind === "resource_draft")!;
    expect(sevenDraft.resourceScheduleParams).toMatchObject({
      personHourRate: 1400,
      personnelShiftsPerDay: 2,
      equipmentShiftsPerDay: 1,
      hoursPerShift: 11,
    });
    expect(readAppData().organizations.find((item) => item.id === sevenProcurement.orgId)?.tenderLogic?.shiftProfile).toBe("doc1_7plus1");
    expect(DEFAULT_TENDER_LOGIC_SETTINGS.shiftProfile).not.toBe("doc1_7plus1");
  });

  it("keeps a legacy draft's saved params and total through migration", () => {
    const created = createManualProcurement("u-ruk", { title: "Старый профиль", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.resourceScheduleParams = {
        ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
        equipmentShiftsPerDay: 1,
        personHourRate: 1400,
      };
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
      calc.dataFlags = ["seeded_from_customer_estimate"];
      calc.participateDecision = "uchastvovat";
      return data;
    });
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '20')").run();
    closeDb();
    ensureReady();
    const migrated = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(migrated.costSummary?.C0).toBe(999);
    expect(migrated.resourceScheduleParams).toMatchObject({
      personHourRate: 1400,
      equipmentShiftsPerDay: 1,
    });
    expect(migrated.participateDecision).toBe("uchastvovat");
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true });
    const recomputed = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(recomputed.resourceScheduleParams?.equipmentShiftsPerDay).toBe(1);
    expect(recomputed.resourceScheduleParams?.personHourRate).toBe(1400);
    expect(recomputed.participateDecision).toBe("uchastvovat");
  });

  it("holds the drilling reference reprice and does not refuse participation when NMCK is at or below full cost", async () => {
    const filePath = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    const parsed = await parseGrandBuffer(fs.readFileSync(filePath));
    const created = createManualProcurement("u-ruk", { title: "Бурение волна 2", region: "Ямал", nmck: 10 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      const org = data.organizations.find((item) => item.id === procurement.orgId)!;
      org.tenderLogic = { ...(org.tenderLogic ?? {}), shiftProfile: "client_2x11_no_weekends" };
      return data;
    });
    const uploaded = await saveUpload("wave2-burenie", "ls-02-02-01-burenie.xlsx", fs.readFileSync(filePath));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave2-burenie",
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
          id: `bur2-${index + 1}`,
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
    expect(draft.resourceScheduleParams?.equipmentShiftsPerDay).toBe(2);
    const savedParams = { ...draft.resourceScheduleParams! };
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(priced.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(priced.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);
    expect(priced.referenceReprice?.method ?? "").toContain("reference-reprice-not-cost");
    expect(priced.referenceReprice?.method ?? "").not.toMatch(/^себестоимость/i);
    expect(priced.resourceScheduleParams?.equipmentShiftsPerDay).toBe(2);
    expect(priced.resourceScheduleParams?.personHourRate).toBe(1400);

    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "commercial-wave2",
        costRole: "commercial",
        code: "LAB-OWN",
        name: "Плотник",
        unit: "чел.-ч",
        quantity: 2,
        rate: 100,
        rateMissing: false,
      });
      calc.participateDecision = "na_rassmotrenii";
      return data;
    });
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    const withCommercial = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(withCommercial.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(withCommercial.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);
    const officialC0 = withCommercial.costSummary?.C0 ?? 0;
    expect(withCommercial.costSummary?.reserve).toBeCloseTo(roundMoney(officialC0 * 0.1), 2);
    expect(withCommercial.costSummary?.profit).toBeCloseTo(roundMoney(officialC0 * 0.4), 2);
    expect(withCommercial.costSummary?.C).toBeCloseTo(roundMoney(officialC0 + (withCommercial.costSummary?.reserve ?? 0)), 2);
    expect(withCommercial.costSummary?.priceExVat).toBeCloseTo(
      roundMoney((withCommercial.costSummary?.C ?? 0) + (withCommercial.costSummary?.profit ?? 0)),
      2,
    );
    expect(Math.abs((withCommercial.costSummary?.priceExVat ?? 0) / officialC0 - 1.5)).toBeLessThan(0.001);
    expect(Math.abs((withCommercial.costSummary?.priceExVat ?? 0) / officialC0 - 1.54)).toBeGreaterThan(0.02);
    expect(withCommercial.participateDecision).toBe("na_rassmotrenii");
    expect(withCommercial.participateDecision).not.toBe("otkaz");
    expect(withCommercial.committeeSnapshot).toMatchObject({
      nmck: 10,
      nmckVsCost: "at_or_below_cost",
    });
    expect(withCommercial.committeeSnapshot?.fullCost).toBeCloseTo(withCommercial.costSummary?.C ?? 0, 2);
    expect(nmckAtOrBelowCostWarning("warn")).toMatch(/директор/);
    expect(nmckAtOrBelowCostWarning("warn")).toMatch(/не ставится/i);
  });
});
