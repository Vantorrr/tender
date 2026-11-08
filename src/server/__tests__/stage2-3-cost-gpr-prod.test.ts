import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, readAppData } from "@/server/db";
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
import "./setup";

describe("stage2 cost engine + gantt", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("schema is 9 with calendar on schedules", () => {
    const data = readAppData();
    const g = data.schedules[0];
    expect(g.calendar?.hoursPerShift).toBeTruthy();
    expect(g.stages[0]?.resources?.length).toBeGreaterThan(0);
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
    expect(after.entries.find((e) => e.workName === workName)!.fact).toBe(
      (before.entries.find((e) => e.workName === workName)?.fact ?? 0) + 5
    );
    expect(after.pnl?.cashIn).toBe(cashIn);
    expect(after.pnl?.earnedValue).toBeGreaterThan(before.pnl?.earnedValue ?? 0);
    // baseline unchanged
    expect(after.baselineEntries).toEqual(before.baselineEntries);
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
