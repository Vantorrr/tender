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
import {
  entryDisplayFact,
  entryDisplayRemain,
  recomputeEntriesFromDaily,
} from "@/lib/plan-fact-agg";
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

  it("allocatePlanForSlice uses GPR calendar, not fact−100%", async () => {
    const { allocatePlanForSlice } = await import("@/lib/plan-from-gpr");
    const stages = [
      {
        id: "a",
        name: "A",
        start: "2026-11-01",
        end: "2026-11-10",
        sequence: 1,
      },
    ];
    const plan = 100;
    const day = allocatePlanForSlice(plan, stages, "day", "2026-11-05");
    const month = allocatePlanForSlice(plan, stages, "month", "2026-11-05");
    const cum = allocatePlanForSlice(plan, stages, "cum", "2026-11-05");
    expect(day).toBeGreaterThan(0);
    expect(day).toBeLessThan(plan);
    expect(month).toBe(plan); // all days in November span
    expect(cum).toBeGreaterThan(0);
    expect(cum).toBeLessThanOrEqual(plan);
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
