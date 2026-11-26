import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { roundMoney } from "@/lib/calc-math";
import { applyClientCommercialFormula } from "@/lib/client-economics";
import type { GprSchedule } from "@/lib/types";
import { closeDb, ensureReady, getDb, mutateAppData, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import {
  applyScheduleAcceleration,
  createManualProcurement,
  createProcurementSchedule,
  recomputeCalculationCost,
  sendProcurementToCalculation,
  updateSchedule,
  updateVorVolume,
} from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import "./setup";

const BURENIE_C0 = 280939759.9;
const BURENIE_PRICE = 393315663.86;

describe("wave 4 commercial packages", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("builds a new GPR from an 11-hour output norm, two shifts and no weekends, without slicing the TZ", () => {
    const created = createManualProcurement("u-ruk", { title: "Выработка грунта", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions = [{
        id: "earth-work",
        costRole: "customer_source",
        code: "ФЕР-1",
        name: "Разработка грунта экскаватором в отвал, Экскаватор Komatsu 220, Песок, супесь, суглинок лёгкий (влажный), грунт растительного слоя, торф",
        unit: "1000 м3",
        quantity: 20000,
        rate: 0,
        rateMissing: true,
        isWorkItem: true,
        sourceSectionName: "Земляные работы",
        sourceWorkName: "Разработка грунта экскаватором в отвал, Экскаватор Komatsu 220, Песок, супесь, суглинок лёгкий (влажный), грунт растительного слоя, торф",
      }, {
        id: "gesn-hours",
        costRole: "customer_source",
        code: "ГЭСН 01-01-001",
        name: "Машинист экскаватора",
        unit: "маш.-ч",
        quantity: 88,
        rate: 0,
        rateMissing: true,
        resourceKind: "equipment",
        sourceSectionName: "Земляные работы",
        sourceWorkName: "Разработка грунта экскаватором в отвал, Экскаватор Komatsu 220, Песок, супесь, суглинок лёгкий (влажный), грунт растительного слоя, торф",
      }];
      data.documents.unshift({
        id: "doc-tz-window",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "ТЗ",
        fileName: "tz.txt",
        fileType: "other",
        category: "tz",
        status: "gotovo",
        versions: [],
        analyticalNote: "Начало работ 01.12.2026, окончание работ 30.12.2026.",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
      });
      return data;
    });
    createProcurementSchedule("u-ruk", created.id);
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    expect(schedule.calendar?.weekendDays).toEqual([]);
    expect(schedule.calendar?.shiftsPerDay).toBe(2);
    expect(schedule.calendar?.hoursPerShift).toBe(11);
    expect(schedule.deadline).toEqual({ start: "2026-12-01", end: "2026-12-30" });
    const stage = schedule.stages[0]!;
    expect(stage.durationBasis).toBe("output_shift");
    expect(stage.durationDays).toBe(10);
    expect(stage.durationShifts).toBe(2);
    expect(stage.start).toBe("2026-12-01");
    expect(stage.end).toBe("2026-12-10");
    expect(stage.end).not.toBe("2026-12-30");
    expect(stage.gesnHoursHint).toBe(88);
    expect(stage.benchmarkSource).toMatch(/смена 11 ч/);
    expect(stage.benchmarkSource).toMatch(/Komatsu 220/);
    expect(schedule.assumptions?.join(" ")).toMatch(/не делится поровну/);
    expect(schedule.assumptions?.join(" ")).toMatch(/Часы ГЭСН остаются в подсказке/);
    expect(schedule.assumptions?.join(" ")).toMatch(/не коммерческий ГПР/i);

    const pinned = {
      personHourRate: 1400,
      personnelShiftsPerDay: 2,
      hoursPerShift: 11,
      equipmentShiftsPerDay: 1,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
      districtCoefficient: 1.8,
      northernPayrollShare: 0.8,
    };
    const savedStages = JSON.stringify(schedule.stages);
    mutateAppData((data) => {
      const row = data.schedules.find((item) => item.id === schedule.id)!;
      row.calendar = { weekendDays: [0, 6], hoursPerShift: 8, shiftsPerDay: 1, timezone: "Asia/Krasnoyarsk" };
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.resourceScheduleParams = pinned;
      return data;
    });
    createProcurementSchedule("u-ruk", created.id);
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '21')").run();
    closeDb();
    ensureReady();
    const kept = readAppData();
    const keptSchedule = kept.schedules.find((item) => item.id === schedule.id)!;
    const keptCalc = kept.calculations.find((item) => item.id === draft.id)!;
    expect(keptSchedule.calendar?.weekendDays).toEqual([0, 6]);
    expect(keptSchedule.calendar?.shiftsPerDay).toBe(1);
    expect(JSON.stringify(keptSchedule.stages)).toBe(savedStages);
    expect(keptCalc.resourceScheduleParams).toEqual(pinned);
  });

  it("recalculates the official price when a shift or a mechanism removes the overrun and keeps a manual line", () => {
    const created = createManualProcurement("u-ruk", { title: "Рычаг срока", region: "Ямал", nmck: 5_000_000 });
    sendProcurementToCalculation("u-ruk", created.id);
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    const schedule: GprSchedule = {
      id: "g-lever",
      orgId: procurement.orgId,
      procurementId: created.id,
      calculationId: draft.id,
      title: "ГПР рычаг",
      status: "v_rabote",
      version: 1,
      authorId: "u-ruk",
      updatedAt: new Date().toISOString(),
      calendar: { weekendDays: [], hoursPerShift: 11, shiftsPerDay: 1, timezone: "Asia/Krasnoyarsk" },
      deadline: { start: "2026-12-01", end: "2026-12-05" },
      stages: [{
        id: "st-lever",
        name: "Разработка грунта",
        workName: "Разработка грунта",
        start: "2026-12-01",
        end: "2026-12-10",
        sequence: 1,
        crewSize: 0,
        durationBasis: "output_shift",
        durationDays: 10,
        formulaVolume: 100,
        outputPerShift11h: 10,
        statedLinks: 1,
        statedShifts: 1,
        mechanismCount: 1,
        durationShifts: 1,
        gesnHoursHint: 88,
        planVolume: 100,
        planUnit: "1000 м3",
      }],
    };
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "vor-concrete",
        code: "ВОР",
        costRole: "commercial",
        name: "Бетон товарный",
        unit: "м3",
        quantity: 10,
        rate: 100,
        rateMissing: false,
        volumeStatus: "unconfirmed",
        sourceWorkName: "Бетон товарный",
      });
      calc.economicsManual = { overhead: { mode: "amount", value: 100 } };
      calc.resourceScheduleParams = {
        personHourRate: 1400,
        personnelShiftsPerDay: 2,
        hoursPerShift: 11,
        equipmentShiftsPerDay: 1,
        overheadRate: 0.43,
        profitMarkupOnCostWithOh: 0.4,
        districtCoefficient: 1.8,
        northernPayrollShare: 0.8,
      };
      data.schedules.unshift(schedule);
      const row = data.procurements.find((item) => item.id === created.id)!;
      row.gprId = schedule.id;
      return data;
    });
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true });
    applyScheduleAcceleration("u-ruk", schedule.id, "shift");
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    const moved = readAppData().schedules.find((item) => item.id === schedule.id)!;
    expect(moved.calendar?.shiftsPerDay).toBe(2);
    expect(moved.calendar?.weekendDays).toEqual([]);
    expect(moved.stages[0]?.durationDays).toBe(5);
    expect(moved.stages[0]?.end).toBe("2026-12-05");
    expect(moved.stages[0]?.gesnHoursHint).toBe(88);
    expect(priced.resourceScheduleParams?.equipmentShiftsPerDay).toBe(2);
    expect(priced.resourceScheduleParams).toMatchObject({
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
      hoursPerShift: 11,
      personHourRate: 1400,
    });
    expect(priced.resourceScheduleParams?.profitMarkupOnCostWithOh).toBe(0.4);
    expect(priced.costSummary?.manualLines).toContain("overhead");
    expect(priced.costSummary?.overhead).toBe(100);
    const expected = applyClientCommercialFormula({
      C0: roundMoney((priced.costSummary?.direct ?? 0) + 100),
      profit: roundMoney((priced.costSummary?.direct ?? 0) + 100) * 0.4,
      direct: priced.costSummary?.direct ?? null,
      overhead: priced.costSummary?.overhead ?? null,
      formulaProfitRate: 0.4,
      vatPercent: null,
      manual: priced.economicsManual,
    });
    expect(priced.costSummary?.reserve).toBeCloseTo(expected.reserve, 2);
    expect(priced.costSummary?.profit).toBeCloseTo(expected.profit, 2);
    expect(priced.costSummary?.priceExVat).toBeCloseTo(expected.priceExVat, 2);
    expect(priced.costSummary?.priceExVat).toBeCloseTo((priced.costSummary?.C0 ?? 0) * 1.5, 2);
    expect(priced.costSummary?.method ?? "").not.toMatch(/^себестоимость/i);
    expect(() => applyScheduleAcceleration("u-ruk", schedule.id, "shift")).toThrow(/Смен уже две|укладывается/);

    mutateAppData((data) => {
      const row = data.schedules.find((item) => item.id === schedule.id)!;
      row.deadline = { start: "2026-12-01", end: "2026-12-02" };
      row.stages[0] = {
        ...row.stages[0]!,
        durationShifts: 2,
        mechanismCount: 1,
        formulaVolume: 100,
        outputPerShift11h: 10,
        durationDays: 5,
        start: "2026-12-01",
        end: "2026-12-05",
        resources: [{
          id: "eq-lever",
          kind: "equipment",
          name: "Экскаватор",
          unit: "маш",
          quantity: 1,
          rate: 100,
          quantityBasis: "count_per_shift",
          hoursPerShift: 11,
        }],
      };
      return data;
    });
    applyScheduleAcceleration("u-ruk", schedule.id, "mechanism");
    const faster = readAppData().schedules.find((item) => item.id === schedule.id)!;
    const afterMachine = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(faster.stages[0]?.mechanismCount).toBe(2);
    expect(faster.stages[0]?.durationDays).toBe(2.5);
    expect(faster.stages[0]?.resources?.[0]?.quantity).toBe(2);
    expect(afterMachine.costSummary?.overhead).toBe(100);
    expect(afterMachine.costSummary?.manualLines).toContain("overhead");
    expect(afterMachine.resourceScheduleParams?.equipmentShiftsPerDay).toBe(2);
    expect(afterMachine.costSummary?.priceExVat).toBeGreaterThan(0);
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true });
    expect(readAppData().calculations.find((item) => item.id === draft.id)?.costSummary?.priceExVat)
      .toBe(afterMachine.costSummary?.priceExVat);
  });

  it("edits a VOR volume, keeps it unconfirmed, and recalculates duration and price", () => {
    const created = createManualProcurement("u-ruk", { title: "Правка ВОР", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "vor-soil",
        code: "ВОР",
        costRole: "commercial",
        name: "Бетон товарный",
        unit: "м3",
        quantity: 10,
        rate: 100,
        rateMissing: false,
        volumeStatus: "confirmed",
        sourceWorkName: "Бетон товарный",
      });
      calc.economicsManual = { overhead: { mode: "amount", value: 50 } };
      data.schedules.unshift({
        id: "g-vor",
        orgId: procurement.orgId,
        procurementId: created.id,
        calculationId: draft.id,
        title: "ГПР ВОР",
        status: "v_rabote",
        version: 1,
        authorId: "u-ruk",
        updatedAt: new Date().toISOString(),
        calendar: { weekendDays: [], hoursPerShift: 11, shiftsPerDay: 2, timezone: "Asia/Krasnoyarsk" },
        deadline: { start: "2026-12-01", end: "2026-12-20" },
        stages: [{
          id: "st-vor",
          name: "Бетон товарный",
          workName: "Бетон товарный",
          start: "2026-12-01",
          end: "2026-12-10",
          sequence: 1,
          crewSize: 0,
          durationBasis: "output_shift",
          durationDays: 10,
          formulaVolume: 10,
          outputPerShift11h: 0.5,
          statedLinks: 1,
          statedShifts: 1,
          mechanismCount: 1,
          durationShifts: 2,
          planVolume: 10,
          planUnit: "1000 м3",
          gesnHoursHint: 88,
        }],
      });
      return data;
    });
    updateVorVolume("u-ruk", draft.id, "vor-soil", { volume: 20 });
    const edited = readAppData().calculations.find((item) => item.id === draft.id)!;
    const schedule = readAppData().schedules.find((item) => item.id === "g-vor")!;
    const row = edited.positions.find((position) => position.id === "vor-soil")!;
    expect(row.quantity).toBe(20);
    expect(row.volumeStatus).toBe("unconfirmed");
    expect(schedule.stages[0]?.durationDays).toBe(20);
    expect(schedule.stages[0]?.end).toBe("2026-12-20");
    expect(schedule.stages[0]?.gesnHoursHint).toBe(88);
    expect(edited.costSummary?.overhead).toBe(50);
    expect(edited.costSummary?.manualLines).toContain("overhead");
    const direct = 20 * 100;
    const C0 = roundMoney(direct + 50);
    expect(edited.costSummary?.C0).toBeCloseTo(C0, 2);
    expect(edited.costSummary?.reserve).toBeCloseTo(roundMoney(C0 * 0.1), 2);
    expect(edited.costSummary?.profit).toBeCloseTo(roundMoney(C0 * 0.4), 2);
    expect(edited.costSummary?.priceExVat).toBeCloseTo(roundMoney(C0 * 1.5), 2);
    updateVorVolume("u-ruk", draft.id, "vor-soil", { status: "confirmed" });
    expect(readAppData().calculations.find((item) => item.id === draft.id)?.positions.find((position) => position.id === "vor-soil")?.volumeStatus).toBe("confirmed");
    expect(readAppData().calculations.find((item) => item.id === draft.id)?.positions.find((position) => position.id === "vor-soil")?.quantity).toBe(20);
  });

  it("keeps the drilling reference reprice stable and unsigned as cost", async () => {
    const filePath = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    const parsed = await parseGrandBuffer(fs.readFileSync(filePath));
    const created = createManualProcurement("u-ruk", { title: "Бурение инвариант", region: "Ямал", nmck: 10 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const uploaded = await saveUpload("wave4-burenie", "ls-02-02-01-burenie.xlsx", fs.readFileSync(filePath));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave4-burenie",
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
          id: `bur4-${index + 1}`,
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
    const savedParams = { ...draft.resourceScheduleParams! };
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(priced.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(priced.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);
    expect(priced.referenceReprice?.method ?? "").toContain("reference-reprice-not-cost");
    expect(priced.referenceReprice?.method ?? "").not.toMatch(/себестоимость/i);
    const first = priced.referenceReprice?.priceExVat;
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    expect(readAppData().calculations.find((item) => item.id === draft.id)?.referenceReprice?.priceExVat).toBe(first);
    expect(readAppData().calculations.find((item) => item.id === draft.id)?.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
  });

  it("does not write another organization's shifts and rejects a volume that would freeze the calendar", () => {
    const created = createManualProcurement("u-ruk", { title: "Чужой рычаг", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    const params = {
      personHourRate: 1400,
      personnelShiftsPerDay: 2,
      hoursPerShift: 11,
      equipmentShiftsPerDay: 1,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    };
    mutateAppData((data) => {
      data.calculations.unshift({
        id: "c-beta-foreign",
        orgId: "org-beta",
        procurementId: "p-beta-missing",
        title: "Чужой расчёт",
        status: "v_rabote",
        positions: [],
        assumptions: [],
        scenario: "bazovyy",
        scenarioFactor: 1,
        participateDecision: null,
        directoryVersionId: "dir-rascenki-1",
        version: 1,
        authorId: "u-beta-tender",
        updatedAt: new Date().toISOString(),
        kind: "resource_draft",
        resourceScheduleParams: { ...params, equipmentShiftsPerDay: 1 },
      });
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.positions.push({
        id: "vor-soil",
        code: "ВОР",
        costRole: "commercial",
        name: "Бетон товарный",
        unit: "м3",
        quantity: 10,
        rate: 100,
        rateMissing: false,
        volumeStatus: "unconfirmed",
      });
      calc.resourceScheduleParams = params;
      data.schedules.unshift({
        id: "g-foreign-lever",
        orgId: procurement.orgId,
        procurementId: created.id,
        calculationId: "c-beta-foreign",
        title: "ГПР с чужой ссылкой",
        status: "v_rabote",
        version: 1,
        authorId: "u-ruk",
        updatedAt: new Date().toISOString(),
        calendar: { weekendDays: [], hoursPerShift: 11, shiftsPerDay: 1, timezone: "Asia/Krasnoyarsk" },
        deadline: { start: "2026-12-01", end: "2026-12-05" },
        stages: [{
          id: "st-foreign",
          name: "Разработка грунта",
          workName: "Разработка грунта",
          start: "2026-12-01",
          end: "2026-12-10",
          sequence: 1,
          crewSize: 0,
          durationBasis: "output_shift",
          durationDays: 10,
          formulaVolume: 100,
          outputPerShift11h: 10,
          statedLinks: 1,
          statedShifts: 1,
          mechanismCount: 1,
          durationShifts: 1,
        }],
      });
      return data;
    });
    expect(() => applyScheduleAcceleration("u-ruk", "g-foreign-lever", "shift")).toThrow(/другой организации/);
    expect(() => applyScheduleAcceleration("u-super", "g-foreign-lever", "shift")).toThrow(/другой организации/);
    expect(readAppData().calculations.find((item) => item.id === "c-beta-foreign")!.resourceScheduleParams!.equipmentShiftsPerDay).toBe(1);
    expect(readAppData().schedules.find((item) => item.id === "g-foreign-lever")!.stages[0]!.end).toBe("2026-12-10");
    expect(readAppData().schedules.find((item) => item.id === "g-foreign-lever")!.calendar!.shiftsPerDay).toBe(1);
    updateSchedule("u-ruk", "g-foreign-lever", { calculationId: draft.id });
    expect(readAppData().schedules.find((item) => item.id === "g-foreign-lever")!.calculationId).toBe("c-beta-foreign");
    expect(() => updateVorVolume("u-ruk", draft.id, "vor-soil", { volume: 1e15 })).toThrow(/объём/i);
    expect(readAppData().calculations.find((item) => item.id === draft.id)!.positions.find((position) => position.id === "vor-soil")!.quantity).toBe(10);
  });
});
