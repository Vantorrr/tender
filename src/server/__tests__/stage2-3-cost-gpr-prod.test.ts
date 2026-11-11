import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import {
  addDailyProductionFact,
  recomputeCalculationCost,
  sendProcurementToCalculation,
  shiftGprStage,
  transferProcurementToProduction,
} from "@/server/repo";
import {
  busCost,
  laborHours,
  runCostEngine,
  shiftStages,
  shiftsNeeded,
} from "@/lib/cost-engine";
import { parseDateRu, formatDate } from "@/lib/format";
import { T25U_TEST } from "@/lib/t25u-test-fixture";
import { totalStageCalendarDays } from "@/lib/plan-from-gpr";
import {
  entryDisplayFact,
  entryDisplayRemain,
  recomputeEntriesFromDaily,
} from "@/lib/plan-fact-agg";
import { forecastWorkCompletion } from "@/lib/production-forecast";
import "./setup";

describe("stage2 cost engine + gantt", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("schema is 12 with calendar and stage-named multi-kind resources", () => {
    const data = readAppData();
    const g = data.schedules[0];
    expect(g.calendar?.hoursPerShift).toBeTruthy();
    expect(g.stages[0]?.resources?.length).toBeGreaterThan(1);
    // Resources are stage-linked names, not identical anonymous kit
    const names = new Set(
      g.stages.flatMap((s) => (s.resources ?? []).map((r) => r.name))
    );
    expect([...names].some((n) => n.includes("·"))).toBe(true);
    expect(data.supplyRequests).toBeTruthy();
  });

  it("allocatePlanForSlice prefers stage volumes over uniform", async () => {
    const { allocatePlanForSlice } = await import("@/lib/plan-from-gpr");
    const uniform = [
      {
        id: "a",
        name: "A",
        start: "2026-11-01",
        end: "2026-11-10",
        sequence: 1,
      },
    ];
    const u = allocatePlanForSlice(100, uniform, "day", "2026-11-05");
    expect(u.source).toBe("uniform_fallback");
    expect(u.plan).toBeGreaterThan(0);
    expect(u.plan).toBeLessThan(100);

    const staged = [
      {
        id: "a",
        name: "A",
        start: "2026-11-01",
        end: "2026-11-05",
        sequence: 1,
        planVolume: 80,
      },
      {
        id: "b",
        name: "B",
        start: "2026-11-06",
        end: "2026-11-10",
        sequence: 2,
        planVolume: 20,
      },
    ];
    const dayA = allocatePlanForSlice(100, staged, "day", "2026-11-02");
    const dayB = allocatePlanForSlice(100, staged, "day", "2026-11-08");
    expect(dayA.source).toBe("stage_volumes");
    expect(dayA.plan).toBeGreaterThan(dayB.plan);
    const period = allocatePlanForSlice(100, staged, "period", "2026-11-05");
    expect(period.plan).toBe(100);
  });

  it("materialsUnpriced when calc has no material positions", async () => {
    const { bucketsFromPositions } = await import("@/lib/cost-engine");
    const b = bucketsFromPositions([
      {
        id: "1",
        code: "ТР",
        name: "Монтажные работы",
        unit: "н-ч",
        quantity: 10,
        rate: 100,
      },
    ]);
    expect(b.materials).toBe(0);
    expect(b.materialsUnpriced).toBe(true);
    expect(b.hasMaterialPositions).toBe(false);
  });

  it("RU date parse/format is DD.MM.YYYY (not US MM/DD)", () => {
    expect(parseDateRu("08.11.2026")).toBe("2026-11-08");
    expect(parseDateRu("08/11/2026")).toBe("2026-11-08"); // DD/MM
    expect(formatDate("2026-11-08")).toBe("08.11.2026");
    expect(parseDateRu("2026-11-08")).toBe("2026-11-08");
    expect(parseDateRu("32.13.2026")).toBeNull();
  });

  it("plan-fact-agg: display fact follows daily ledger", () => {
    const pf = {
      id: "pf-x",
      orgId: "o",
      objectId: "o1",
      title: "t",
      status: "v_rabote" as const,
      updatedAt: "",
      entries: [
        {
          id: "e1",
          workName: "Общий объём",
          unit: "%",
          plan: 100,
          fact: 0,
          contractRemaining: 100,
        },
      ],
      dailyFacts: [
        {
          id: "d1",
          date: "2026-11-08",
          workName: "Общий объём",
          unit: "%",
          quantity: 1,
          photos: [],
          authorId: "u",
          at: "",
        },
        {
          id: "d2",
          date: "2026-11-08",
          workName: "Общий объём",
          unit: "%",
          quantity: 1,
          photos: [],
          authorId: "u",
          at: "",
        },
      ],
    };
    recomputeEntriesFromDaily(pf);
    expect(pf.entries[0].fact).toBe(2);
    expect(pf.entries[0].contractRemaining).toBe(98);
    expect(entryDisplayFact(pf.entries[0], pf.dailyFacts)).toBe(2);
    expect(entryDisplayRemain(pf.entries[0], pf.dailyFacts)).toBe(98);
  });

  it("production forecast waits for three report days and counts GPR working days", () => {
    const entry = { id: "work", workName: "Монтаж", unit: "м", plan: 20, fact: 0 };
    const dailyFacts = [
      ["2026-11-02", 4],
      ["2026-11-03", 4],
      ["2026-11-04", 4],
    ].map(([date, quantity], index) => ({
      id: `df-${index}`,
      date: String(date),
      workName: "Монтаж",
      unit: "м",
      quantity: Number(quantity),
      photos: [],
      authorId: "u-ruk",
      at: `${date}T12:00:00.000Z`,
    }));
    const insufficient = forecastWorkCompletion({
      entry,
      dailyFacts: dailyFacts.slice(0, 2),
      asOfDate: "2026-11-04",
      plannedFinish: "2026-11-05",
    });
    expect(insufficient.status).toBe("insufficient_data");
    const forecast = forecastWorkCompletion({
      entry,
      dailyFacts,
      asOfDate: "2026-11-04",
      plannedFinish: "2026-11-05",
    });
    expect(forecast).toMatchObject({
      status: "forecast",
      observedDays: 3,
      averagePerWorkday: 4,
      projectedFinish: "2026-11-06",
      varianceWorkdays: 1,
    });
  });

  it("labor/shifts and bus cost are deterministic; no dual profit", () => {
    expect(laborHours(100, 1.5)).toBe(150);
    expect(shiftsNeeded(150, 5, 8, 1)).toBe(4);
    const bus = busCost({
      people: 20,
      seats: 8,
      distanceKmOneWay: 30,
      roundTrip: true,
      idleKm: 5,
      fuelPer100Km: 25,
      fuelPricePerLiter: 70,
      driverShiftCost: 5000,
      driverIncludedInTariff: true,
      tariffPerShift: 12000,
      ownershipMode: "rent",
      days: 10,
    });
    expect(bus.tripsPerDay).toBe(3);
    expect(bus.driverCost).toBe(0);
    expect(bus.flags).toContain("driver_included_in_tariff");

    const eng = runCostEngine({
      directLabor: 1000,
      directMaterials: 2000,
      directEquipment: 500,
      directSubcontract: 0,
      logisticsIncludingBus: bus.total,
      siteOverhead: 150,
      officeOverhead: 50,
      reserve: 100,
      profitMethod: "markup",
      profitRate: 0.1,
      includeReserveInPriceBase: true,
      vatPercent: 20,
      northern: {
        applicable: true,
        confirmedItems: [
          {
            id: "n1",
            name: "Вахта (подтверждено)",
            status: "known",
            amount: 300,
            basis: "КП поставщика",
          },
          {
            id: "n2",
            name: "Неизвестный северный коэфф",
            status: "clarify",
            amount: null,
            basis: "нужно от Егора",
          },
        ],
        notes: [],
      },
    });
    expect(eng.direct.D).toBe(1000 + 2000 + 500 + 0 + bus.total + 300);
    expect(eng.C0).toBe(eng.direct.D + 150 + 50);
    expect(eng.C).toBe(eng.C0 + 100);
    expect(eng.profit).toBe(Math.round(eng.C * 0.1 * 100) / 100);
    expect(eng.flags).toContain("no_dual_markup_and_margin");
    expect(eng.incomplete).toContain("north:n2:Неизвестный северный коэфф");
    expect(JSON.stringify(eng)).not.toMatch(/97%/);
  });

  it("shiftStages cascades FS and reports conflicts when disabled", () => {
    const stages = [
      {
        id: "a",
        name: "A",
        start: "2026-12-01",
        end: "2026-12-10",
        sequence: 1,
      },
      {
        id: "b",
        name: "B",
        start: "2026-12-11",
        end: "2026-12-20",
        sequence: 2,
        dependsOn: "a",
        dependencyType: "FS" as const,
      },
    ];
    const moved = shiftStages(stages, "a", 5, { cascade: true });
    expect(moved.stages.find((s) => s.id === "a")!.start).toBe("2026-12-06");
    expect(moved.stages.find((s) => s.id === "b")!.start >= "2026-12-16").toBe(
      true
    );
  });

  it("calendar resize treats both endpoints as work days and cascades resource days", () => {
    const stages = [
      {
        id: "single",
        name: "Однодневный этап",
        start: "2026-12-01",
        end: "2026-12-01",
        sequence: 1,
        resources: [{ id: "bus", kind: "bus" as const, name: "Автобус", quantity: 1, unit: "ед", rate: 100, days: 1 }],
      },
      {
        id: "next",
        name: "Следующий этап",
        start: "2026-12-02",
        end: "2026-12-02",
        sequence: 2,
        dependsOn: "single",
        dependencyType: "FS" as const,
      },
    ];
    expect(totalStageCalendarDays(stages)).toBe(2);

    const resized = shiftStages(stages, "single", 0, { resizeDays: 3 });
    const first = resized.stages.find((stage) => stage.id === "single")!;
    const next = resized.stages.find((stage) => stage.id === "next")!;
    expect(first.end).toBe("2026-12-03");
    expect(first.resources?.[0].days).toBe(1); // pure date function leaves explicit resource input untouched
    expect(next.start).toBe("2026-12-04");
    expect(next.end).toBe("2026-12-04");
    expect(totalStageCalendarDays([first])).toBe(3);
  });

  it("cascades FS, SS, FF and SF links with lag without changing child duration", () => {
    const relations = [
      { type: "FS" as const, lag: 1, childStart: "2026-12-03", expected: "2026-12-09" },
      { type: "SS" as const, lag: 2, childStart: "2026-12-03", expected: "2026-12-08" },
      { type: "FF" as const, lag: 2, childStart: "2026-12-03", expected: "2026-12-08" },
      { type: "SF" as const, lag: 2, childStart: "2026-12-03", expected: "2026-12-07" },
    ];
    for (const relation of relations) {
      const stages = [
        { id: "parent", name: "Предшественник", start: "2026-12-01", end: "2026-12-02", sequence: 1 },
        {
          id: "child",
          name: "Последователь",
          start: relation.childStart,
          end: "2026-12-04",
          sequence: 2,
          dependsOn: "parent",
          dependencyType: relation.type,
          lagDays: relation.lag,
        },
      ];

      const result = shiftStages(stages, "parent", 5, { cascade: true });
      const child = result.stages.find((stage) => stage.id === "child")!;
      expect(child.start, relation.type).toBe(relation.expected);
      expect(totalStageCalendarDays([child]), relation.type).toBe(2);
      expect(result.conflicts, relation.type).toEqual([]);
    }
  });

  it("shiftGprStage persists via repo", () => {
    const g = readAppData().schedules[0];
    const stage = g.stages[0];
    const before = stage.start;
    shiftGprStage("u-smet", g.id, stage.id, 2);
    const after = readAppData().schedules.find((s) => s.id === g.id)!;
    expect(after.stages.find((s) => s.id === stage.id)!.start > before).toBe(
      true
    );
    expect(after.version).toBeGreaterThan(g.version);
  });

  it("resizing a one-day stage updates linked resource participation days", () => {
    const schedule = readAppData().schedules[0];
    const stage = schedule.stages[0];
    mutateAppData((data) => {
      const current = data.schedules.find((item) => item.id === schedule.id)!;
      current.stages = current.stages.map((item) => item.id !== stage.id ? item : {
        ...item,
        start: "2026-12-01",
        end: "2026-12-01",
        resources: (item.resources ?? []).map((resource) => resource.kind === "material" ? resource : { ...resource, days: 1 }),
      });
      return data;
    });

    shiftGprStage("u-smet", schedule.id, stage.id, 0, { resizeDays: 2 });
    const resized = readAppData().schedules.find((item) => item.id === schedule.id)!.stages.find((item) => item.id === stage.id)!;
    expect(resized.end).toBe("2026-12-02");
    for (const resource of resized.resources ?? []) {
      if (resource.kind !== "material") expect(resource.days).toBe(2);
    }
    expect(totalStageCalendarDays([resized])).toBe(2);
  });

  it("calendar edits recalculate resource days using the project's working week", () => {
    const schedule = readAppData().schedules[0];
    const stage = schedule.stages[0];
    mutateAppData((data) => {
      const current = data.schedules.find((item) => item.id === schedule.id)!;
      current.calendar = { weekendDays: [0, 6], hoursPerShift: 8, shiftsPerDay: 1, timezone: "Europe/Moscow" };
      current.stages = current.stages.map((item) => item.id !== stage.id ? item : {
        ...item,
        start: "2026-12-04", // Friday
        end: "2026-12-06", // Sunday: three calendar days, one working day
        resources: [{
          id: "qa-bus-weekend-calendar",
          kind: "bus" as const,
          name: "QA shuttle bus",
          quantity: 1,
          unit: "bus",
          rate: 100,
          days: 1,
        }],
      });
      return data;
    });

    shiftGprStage("u-smet", schedule.id, stage.id, 0, { resizeDays: 4 });
    const resized = readAppData().schedules.find((item) => item.id === schedule.id)!.stages.find((item) => item.id === stage.id)!;
    expect(resized.end).toBe("2026-12-07");
    expect(resized.resources?.[0].days).toBe(2); // Friday + Monday, weekend excluded
  });

  it("recomputeCalculationCost writes summary without inventing VAT", () => {
    sendProcurementToCalculation("u-smet", "p-norilsk-1");
    const draft = readAppData().procurements.find((p) => p.id === "p-norilsk-1")!
      .calculationId!;
    recomputeCalculationCost("u-smet", draft, {
      vatPercent: null,
      northern: {
        applicable: true,
        confirmedItems: [],
        notes: ["нет подтверждённых северных ставок"],
      },
      busRoutes: [
        {
          people: 12,
          seats: 20,
          distanceKmOneWay: 40,
          roundTrip: true,
          idleKm: 0,
          fuelPer100Km: 20,
          fuelPricePerLiter: 65,
          driverShiftCost: 4000,
          driverIncludedInTariff: false,
          tariffPerShift: null,
          ownershipMode: "none",
          days: 5,
        },
      ],
    });
    const calc = readAppData().calculations.find((c) => c.id === draft)!;
    expect(calc.costSummary?.incomplete).toContain("vat_percent");
    expect(calc.costSummary?.method).toMatch(/cost-engine/);
    expect(calc.dataFlags).toContain("cost_engine_v1");
  });
});

describe("stage3 won→production + daily fact + baseline", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("transfer keeps same procurement id and freezes baseline", () => {
    const id = "p-1";
    transferProcurementToProduction("u-ruk", id);
    const data = readAppData();
    const p = data.procurements.find((x) => x.id === id)!;
    expect(p.lifecycle).toBe("production");
    expect(p.wonAt).toBeTruthy();
    // no duplicate procurement with same number
    expect(
      data.procurements.filter((x) => x.number === p.number).length
    ).toBe(1);
    const pf = data.planFacts.find((x) => x.id === p.planFactId)!;
    expect(pf.baselineEntries?.length).toBeGreaterThan(0);
    expect(pf.baselineAt).toBeTruthy();
    expect(pf.pnl?.notes.some((n) => /≠|не платёж|платёж/i.test(n))).toBe(
      true
    );
  });

  it("does not invent a 100% production task when physical estimate volumes are missing", () => {
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.lifecycle = "won";
      procurement.originalCalculationId = undefined;
      const plan = data.planFacts.find((item) => item.id === procurement.planFactId)!;
      plan.entries = [{ id: "legacy", workName: "Общий объём", unit: "%", plan: 100, fact: 0 }];
      plan.baselineEntries = undefined;
      plan.dailyFacts = [];
      return data;
    });
    transferProcurementToProduction("u-ruk", "p-2");
    const data = readAppData();
    const procurement = data.procurements.find((item) => item.id === "p-2")!;
    const plan = data.planFacts.find((item) => item.id === procurement.planFactId)!;
    expect(plan.entries).toEqual([]);
    expect(plan.baselineEntries).toEqual([]);
  });

  it("seeds production plan from customer estimate physical positions only", () => {
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.lifecycle = "won";
      const template = data.calculations[0];
      const originalId = "calc-customer-plan-test";
      procurement.originalCalculationId = originalId;
      const plan = data.planFacts.find((item) => item.id === procurement.planFactId)!;
      plan.entries = [{ id: "legacy", workName: "Общий объём", unit: "%", plan: 100, fact: 0 }];
      plan.baselineEntries = undefined;
      plan.dailyFacts = [];
      data.calculations.push({
        ...structuredClone(template),
        id: originalId,
        procurementId: procurement.id,
        kind: "customer_original",
        immutable: true,
        positions: [
          { id: "a", code: "01", name: "Монтаж труб", unit: "м", quantity: 25, rate: 10 },
          { id: "b", code: "02", name: "Монтаж труб", unit: "м", quantity: 5, rate: 10 },
          { id: "c", code: "НР", name: "Накладные расходы", unit: "руб", quantity: 100, rate: 1 },
        ],
      });
      return data;
    });
    transferProcurementToProduction("u-ruk", "p-2");
    const data = readAppData();
    const procurement = data.procurements.find((item) => item.id === "p-2")!;
    const plan = data.planFacts.find((item) => item.id === procurement.planFactId)!;
    expect(plan.entries).toMatchObject([
      { workName: "Монтаж труб", unit: "м", plan: 30, fact: 0, contractRemaining: 30 },
    ]);
    expect(plan.baselineEntries).toEqual(plan.entries);
  });

  it("daily fact updates physical totals without touching cash", () => {
    transferProcurementToProduction("u-ruk", "p-1");
    const pfId = readAppData().procurements.find((p) => p.id === "p-1")!
      .planFactId!;
    const before = readAppData().planFacts.find((p) => p.id === pfId)!;
    const cashIn = before.pnl?.cashIn ?? 0;
    const workName = "Демонтаж перегородок";
    const unit = "м²";
    addDailyProductionFact("u-obj", pfId, {
      date: "2026-12-01",
      workName,
      unit,
      quantity: 5,
      photos: [
        {
          id: "ph-1",
          fileName: "day1.jpg",
          at: new Date().toISOString(),
          caption: "факт дня",
        },
      ],
    });
    const after = readAppData().planFacts.find((p) => p.id === pfId)!;
    expect(after.dailyFacts?.length).toBe(1);
    expect(after.dailyFacts![0].photos[0].fileName).toBe("day1.jpg");
    // Once daily ledger exists for the work, fact = sum(daily), not seed+delta
    expect(after.entries.find((e) => e.workName === workName)!.fact).toBe(5);
    expect(after.pnl?.cashIn).toBe(cashIn);
    expect(after.pnl?.earnedValue).toBe(
      after.entries.reduce((s, e) => s + e.fact, 0)
    );
    // baseline unchanged
    expect(after.baselineEntries).toEqual(before.baselineEntries);
  });

  it("values completed and remaining production by the immutable customer estimate", () => {
    const before = readAppData();
    const original = before.calculations.find(
      (item) => item.id === T25U_TEST.originalCalculationId
    )!;
    mutateAppData((data) => {
      const estimate = data.calculations.find((item) => item.id === original.id)!;
      estimate.positions.push({
        id: "t25u-estimate-work-value",
        code: "WORK-1",
        name: T25U_TEST.workName,
        unit: "м²",
        quantity: 420,
        rate: 800,
      });
      return data;
    });
    const cashBefore = readAppData().planFacts.find(
      (item) => item.id === T25U_TEST.planFactId
    )!.pnl?.cashIn ?? 0;

    addDailyProductionFact("u-obj", T25U_TEST.planFactId, {
      date: "2026-11-08",
      workName: T25U_TEST.workName,
      unit: "м²",
      quantity: 2,
      photos: [],
    });

    const after = readAppData().planFacts.find(
      (item) => item.id === T25U_TEST.planFactId
    )!;
    expect(after.pnl?.valueOfFactByCustomerEstimate).toBe(1600);
    expect(after.pnl?.remainingValueByCustomerEstimate).toBe(334400);
    expect(after.pnl?.recognizedRevenue).toBeNull();
    expect(after.pnl?.cashIn).toBe(cashBefore);
  });

  it("daily fact matches by workName when unit mismatches (UI bug regression)", () => {
    transferProcurementToProduction("u-ruk", "p-1");
    const pfId = readAppData().procurements.find((p) => p.id === "p-1")!
      .planFactId!;
    const workName = "Демонтаж перегородок";
    // Isolate ledger for this work (shared DB across tests in file)
    mutateAppData((data) => {
      const pf = data.planFacts.find((p) => p.id === pfId)!;
      pf.dailyFacts = (pf.dailyFacts ?? []).filter(
        (d) => d.workName !== workName
      );
      const row = pf.entries.find((e) => e.workName === workName)!;
      row.fact = 0;
      row.contractRemaining = row.plan;
      return data;
    });
    const before = readAppData().planFacts.find((p) => p.id === pfId)!;
    const entryUnit = before.entries.find((e) => e.workName === workName)!.unit;
    addDailyProductionFact("u-obj", pfId, {
      date: "2026-12-03",
      workName,
      unit: "ед", // wrong unit from UI
      quantity: 1,
      photos: [],
    });
    addDailyProductionFact("u-obj", pfId, {
      date: "2026-12-03",
      workName,
      unit: "ед",
      quantity: 1,
      photos: [],
    });
    const after = readAppData().planFacts.find((p) => p.id === pfId)!;
    const row = after.entries.find((e) => e.workName === workName)!;
    expect(row.unit).toBe(entryUnit);
    expect(row.fact).toBe(2);
    expect(row.contractRemaining).toBe(Math.max(0, row.plan - row.fact));
    expect(after.pnl?.earnedValue).toBe(
      after.entries.reduce((s, e) => s + e.fact, 0)
    );
  });

  it("two daily ×1 on Общий объём keep fact/remain/variance consistent after reload", () => {
    // New plan/fact with plan=100 (same shape as won→prod without prior pf)
    transferProcurementToProduction("u-ruk", "p-2");
    const pfId = readAppData().procurements.find((p) => p.id === "p-2")!
      .planFactId!;
    // Force the rejection shape: Общий объём plan 100 fact 0
    mutateAppData((data) => {
      const pf = data.planFacts.find((p) => p.id === pfId)!;
      pf.entries = [
        {
          id: "pfe-reject",
          workName: "Общий объём",
          unit: "%",
          plan: 100,
          fact: 0,
          contractRemaining: 100,
        },
      ];
      pf.baselineEntries = structuredClone(pf.entries);
      pf.dailyFacts = [];
      return data;
    });
    const workName = "Общий объём";
    addDailyProductionFact("u-obj", pfId, {
      date: "2026-11-08",
      workName,
      unit: "ед",
      quantity: 1,
      photos: [],
    });
    addDailyProductionFact("u-obj", pfId, {
      date: "2026-11-08",
      workName,
      unit: "ед",
      quantity: 1,
      photos: [],
    });
    // Simulate save+reload
    const after = readAppData().planFacts.find((p) => p.id === pfId)!;
    const row = after.entries.find((e) => e.workName === workName)!;
    const daySum = (after.dailyFacts ?? [])
      .filter((d) => d.date === "2026-11-08" && d.workName === workName)
      .reduce((s, d) => s + d.quantity, 0);
    expect(daySum).toBe(2);
    expect(row.fact).toBe(2);
    expect(row.contractRemaining).toBe(98);
    expect(row.unit).toBe("%");
    const basePlan = after.baselineEntries?.find(
      (b) => b.workName === workName
    )?.plan;
    expect(row.fact - (basePlan ?? row.plan)).toBe(-98);
  });

  it("second transfer is idempotent (no duplicate project)", () => {
    transferProcurementToProduction("u-ruk", "p-2");
    const n1 = readAppData().procurements.length;
    transferProcurementToProduction("u-ruk", "p-2");
    const n2 = readAppData().procurements.length;
    expect(n2).toBe(n1);
    expect(
      readAppData().procurements.find((p) => p.id === "p-2")!.lifecycle
    ).toBe("production");
  });
});
