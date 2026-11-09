import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { busCost } from "@/lib/cost-engine";
import {
  machineHourFullTariffCost,
  resourceHours,
  rollupResourceSchedule,
  type ResourceScheduleLine,
} from "@/lib/resource-schedule-model";

const fixture = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      "fixtures/resource-schedule/anon-mobilization.json"
    ),
    "utf8"
  )
) as {
  params: {
    personHourRate: number;
    personnelShiftsPerDay: number;
    hoursPerShift: number;
    equipmentShiftsPerDay: number;
    overheadRate: number;
    profitMarkupOnCostWithOh: number;
  };
  materialsTotal: number;
  lines: ResourceScheduleLine[];
  expected: {
    labor: number;
    equipment: number;
    materials: number;
    direct: number;
    overhead: number;
    costWithOh: number;
    profit: number;
    total: number;
    busHours: number;
    busAmount: number;
    missingTariffIncomplete: boolean;
  };
  tariffBasisAmbiguity: {
    schedule_fixed_example: number;
    tariffs_sheet_full_example_cache: number;
  };
};

describe("resource-schedule Excel semantics (anonymized fixture)", () => {
  it("Q=L*N*O*P and R=Q*M for people and full-tariff bus", () => {
    const bus = fixture.lines.find((l) => l.id === "r-bus")!;
    const hours = resourceHours(bus);
    expect(hours).toBe(66);
    const mh = machineHourFullTariffCost({
      quantity: bus.quantity,
      ratePerMachineHour: bus.rate as number,
      hoursPerShift: bus.hoursPerShift,
      shiftsPerDay: bus.shiftsPerDay,
      days: bus.days,
    });
    expect(mh.hours).toBe(fixture.expected.busHours);
    expect(mh.amount).toBe(fixture.expected.busAmount);
    expect(mh.flags).toContain("no_extra_fuel_or_driver_on_top");
  });

  it("rollups match V/W/X/Y/Z with OH 43% and profit markup 40% on cost-with-OH", () => {
    const result = rollupResourceSchedule({
      params: fixture.params,
      lines: fixture.lines,
      materialsTotal: fixture.materialsTotal,
    });
    expect(result.labor).toBe(fixture.expected.labor);
    expect(result.equipment).toBe(fixture.expected.equipment);
    expect(result.direct).toBe(fixture.expected.direct);
    expect(result.overhead).toBe(fixture.expected.overhead);
    expect(result.costWithOh).toBe(fixture.expected.costWithOh);
    expect(result.profit).toBeCloseTo(fixture.expected.profit, 5);
    expect(result.total).toBeCloseTo(fixture.expected.total, 5);
    expect(result.incomplete.some((i) => i.startsWith("missing_tariff"))).toBe(
      true
    );
  });

  it("busCost machine_hour_full_tariff does not stack fuel/driver", () => {
    const b = busCost({
      people: 40,
      seats: 20,
      distanceKmOneWay: 35,
      roundTrip: true,
      idleKm: 0,
      fuelPer100Km: 30,
      fuelLitersPerHour: 6.1,
      fuelPricePerLiter: 100,
      driverShiftCost: 5000,
      driverIncludedInTariff: true,
      tariffPerMachineHour: 2650,
      tariffPerShift: null,
      tariffBasis: "schedule_fixed",
      ownershipMode: "own",
      days: 3,
      hoursPerShift: 11,
      shiftsPerDay: 1,
      quantity: 2,
      costingMode: "machine_hour_full_tariff",
    });
    expect(b.fuelCost).toBe(0);
    expect(b.driverCost).toBe(0);
    expect(b.total).toBe(174900);
    expect(b.flags).toContain("no_extra_fuel_or_driver_on_top");
    expect(b.flags).toContain("tariff_basis:schedule_fixed");
  });

  it("does not equate schedule_fixed and tariffs_sheet_full bases", () => {
    expect(fixture.tariffBasisAmbiguity.schedule_fixed_example).toBe(2650);
    expect(
      fixture.tariffBasisAmbiguity.tariffs_sheet_full_example_cache
    ).toBeCloseTo(3438.887869, 5);
    expect(fixture.tariffBasisAmbiguity.schedule_fixed_example).not.toBe(
      fixture.tariffBasisAmbiguity.tariffs_sheet_full_example_cache
    );
  });
});
