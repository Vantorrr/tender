/**
 * Deterministic cost / schedule engine (calculation-prompt-ru).
 * No Excel guessing, no invented northern coefficients, no double margins.
 */

import { roundMoney } from "@/lib/calc-math";
import type { CalcPosition, GprStage } from "@/lib/types";

export type ProfitMethod = "markup" | "margin";

export interface NorthernInputs {
  /** Explicit confirmed applicability only — never a universal coefficient. */
  applicable: boolean;
  confirmedItems: Array<{
    id: string;
    name: string;
    status: "known" | "clarify" | "scenario";
    amount: number | null;
    basis: string;
  }>;
  /** Free-form confirmed rate inputs (not invented). */
  notes: string[];
}

export interface BusRouteInput {
  people: number;
  seats: number;
  distanceKmOneWay: number;
  roundTrip: boolean;
  idleKm: number;
  fuelPer100Km: number;
  fuelPricePerLiter: number;
  driverShiftCost: number;
  /** If true, driver cost already in tariff — do not add again. */
  driverIncludedInTariff: boolean;
  tariffPerShift: number | null;
  ownershipMode: "rent" | "own" | "none";
  days: number;
}

export interface CostEngineInput {
  directLabor: number;
  directMaterials: number;
  directEquipment: number;
  directSubcontract: number;
  logisticsIncludingBus: number;
  siteOverhead: number;
  officeOverhead: number;
  /** Reserve R — separate from C0. */
  reserve: number;
  profitMethod: ProfitMethod;
  /** markup u as fraction, OR margin m as fraction of revenue (0<=m<1). Never both. */
  profitRate: number;
  /** Include reserve in price base C. */
  includeReserveInPriceBase: boolean;
  vatPercent: number | null;
  northern: NorthernInputs;
}

export interface CostEngineResult {
  direct: {
    labor: number;
    materials: number;
    equipment: number;
    subcontract: number;
    logistics: number;
    northernKnown: number;
    D: number;
  };
  siteOverhead: number;
  officeOverhead: number;
  C0: number;
  reserve: number;
  C: number;
  profitMethod: ProfitMethod;
  profitRate: number;
  profit: number;
  priceExVat: number;
  vatPercent: number | null;
  vatAmount: number | null;
  priceIncVat: number | null;
  flags: string[];
  incomplete: string[];
}

export function laborHours(quantity: number, normHoursPerUnit: number): number {
  return quantity * normHoursPerUnit;
}

export function shiftsNeeded(
  hours: number,
  crewSize: number,
  hoursPerShift: number,
  utilization = 1
): number {
  const power = crewSize * hoursPerShift * utilization;
  if (!(power > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil(hours / power);
}

export function busCost(input: BusRouteInput): {
  tripsPerDay: number;
  buses: number;
  distanceKmPerDay: number;
  fuelLiters: number;
  fuelCost: number;
  driverCost: number;
  tariffCost: number;
  total: number;
  flags: string[];
} {
  const flags: string[] = [];
  const seats = Math.max(1, input.seats);
  const tripsPerDay = Math.ceil(Math.max(0, input.people) / seats);
  const buses = Math.max(1, Math.ceil(input.people / seats));
  const leg = input.roundTrip
    ? input.distanceKmOneWay * 2
    : input.distanceKmOneWay;
  const distanceKmPerDay = tripsPerDay * leg + input.idleKm;
  const fuelLiters =
    (distanceKmPerDay * input.fuelPer100Km) / 100 * Math.max(0, input.days);
  const fuelCost = roundMoney(fuelLiters * input.fuelPricePerLiter);
  let driverCost = 0;
  if (!input.driverIncludedInTariff) {
    driverCost = roundMoney(input.driverShiftCost * input.days * buses);
  } else {
    flags.push("driver_included_in_tariff");
  }
  let tariffCost = 0;
  if (input.ownershipMode === "rent" && input.tariffPerShift != null) {
    tariffCost = roundMoney(input.tariffPerShift * input.days * buses);
    if (!input.driverIncludedInTariff && input.driverShiftCost > 0) {
      flags.push("check_rent_tariff_does_not_already_include_driver");
    }
  }
  if (input.ownershipMode === "own" && input.tariffPerShift != null) {
    flags.push("own_mode_uses_ownership_cost_not_full_rent");
    tariffCost = roundMoney(input.tariffPerShift * input.days * buses);
  }
  const total = roundMoney(fuelCost + driverCost + tariffCost);
  return {
    tripsPerDay,
    buses,
    distanceKmPerDay,
    fuelLiters: roundMoney(fuelLiters),
    fuelCost,
    driverCost,
    tariffCost,
    total,
    flags,
  };
}

export function runCostEngine(input: CostEngineInput): CostEngineResult {
  const flags: string[] = [];
  const incomplete: string[] = [];

  let northernKnown = 0;
  for (const item of input.northern.confirmedItems) {
    if (item.status === "known" && item.amount != null) {
      northernKnown = roundMoney(northernKnown + item.amount);
    } else if (item.status === "clarify") {
      incomplete.push(`north:${item.id}:${item.name}`);
    } else if (item.status === "scenario") {
      flags.push(`north_scenario:${item.id}`);
    }
  }
  if (input.northern.applicable === false && northernKnown > 0) {
    flags.push("northern_marked_not_applicable_but_amounts_present");
  }

  const D = roundMoney(
    input.directLabor +
      input.directMaterials +
      input.directEquipment +
      input.directSubcontract +
      input.logisticsIncludingBus +
      northernKnown
  );
  const C0 = roundMoney(D + input.siteOverhead + input.officeOverhead);
  const C = roundMoney(C0 + input.reserve);
  const priceBase = input.includeReserveInPriceBase ? C : C0;

  let profit = 0;
  let priceExVat = 0;
  if (input.profitMethod === "markup") {
    profit = roundMoney(priceBase * input.profitRate);
    priceExVat = roundMoney(priceBase + profit);
  } else {
    if (!(input.profitRate >= 0 && input.profitRate < 1)) {
      incomplete.push("margin_rate_must_be_in_[0,1)");
      priceExVat = priceBase;
      profit = 0;
    } else {
      priceExVat = roundMoney(priceBase / (1 - input.profitRate));
      profit = roundMoney(priceExVat - priceBase);
    }
  }
  flags.push(`profit_method:${input.profitMethod}`);
  flags.push("no_dual_markup_and_margin");

  let vatAmount: number | null = null;
  let priceIncVat: number | null = null;
  if (input.vatPercent == null) {
    incomplete.push("vat_percent");
  } else {
    vatAmount = roundMoney(priceExVat * (input.vatPercent / 100));
    priceIncVat = roundMoney(priceExVat + vatAmount);
  }

  return {
    direct: {
      labor: roundMoney(input.directLabor),
      materials: roundMoney(input.directMaterials),
      equipment: roundMoney(input.directEquipment),
      subcontract: roundMoney(input.directSubcontract),
      logistics: roundMoney(input.logisticsIncludingBus),
      northernKnown,
      D,
    },
    siteOverhead: roundMoney(input.siteOverhead),
    officeOverhead: roundMoney(input.officeOverhead),
    C0,
    reserve: roundMoney(input.reserve),
    C,
    profitMethod: input.profitMethod,
    profitRate: input.profitRate,
    profit,
    priceExVat,
    vatPercent: input.vatPercent,
    vatAmount,
    priceIncVat,
    flags,
    incomplete,
  };
}

/** Split calc positions into cost buckets without double-counting НР/СП rows. */
export function bucketsFromPositions(
  positions: CalcPosition[],
  factor = 1
): {
  labor: number;
  materials: number;
  equipment: number;
  other: number;
  /** True when at least one material-classified position exists. */
  hasMaterialPositions: boolean;
  /** True when materials bucket is arithmetically 0 because there are no material lines (not a confirmed 0 ₽ price). */
  materialsUnpriced: boolean;
} {
  let labor = 0;
  let materials = 0;
  let equipment = 0;
  let other = 0;
  let hasMaterialPositions = false;
  for (const p of positions) {
    if (p.code === "НР" || p.code === "СП") continue;
    const sum = p.quantity * p.rate * factor;
    const hay = `${p.code} ${p.name} ${p.unit}`.toLowerCase();
    if (/н-ч|чел|труд|зарп|свар|монтажн/.test(hay)) labor += sum;
    else if (/матер|м²|м2|т\b|сэндвич|бетон|арматур/.test(hay)) {
      hasMaterialPositions = true;
      materials += sum;
    } else if (/маш|техник|jcb|экскав|кран|атс|дсм/.test(hay))
      equipment += sum;
    else other += sum;
  }
  return {
    labor: roundMoney(labor),
    materials: roundMoney(materials),
    equipment: roundMoney(equipment),
    other: roundMoney(other),
    hasMaterialPositions,
    materialsUnpriced: !hasMaterialPositions,
  };
}

export function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  const ms =
    new Date(`${b}T12:00:00Z`).getTime() -
    new Date(`${a}T12:00:00Z`).getTime();
  return Math.round(ms / 86400000);
}

/**
 * Shift a stage by deltaDays; optionally cascade dependents (FS).
 * Does not invent durations — keeps stage length unless resizeDays set.
 */
export function shiftStages(
  stages: GprStage[],
  stageId: string,
  deltaDays: number,
  opts?: { cascade?: boolean; resizeDays?: number | null }
): { stages: GprStage[]; conflicts: string[] } {
  const cascade = opts?.cascade ?? true;
  const conflicts: string[] = [];
  const byId = new Map(stages.map((s) => [s.id, { ...s }]));
  const target = byId.get(stageId);
  if (!target) return { stages, conflicts: ["stage_not_found"] };

  const len = Math.max(1, diffDays(target.start, target.end));
  const newStart = addDaysIso(target.start, deltaDays);
  const newEnd =
    opts?.resizeDays != null
      ? addDaysIso(newStart, Math.max(1, opts.resizeDays))
      : addDaysIso(newStart, len);
  target.start = newStart;
  target.end = newEnd;
  byId.set(stageId, target);

  if (cascade) {
    const queue = [stageId];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const parent = byId.get(id)!;
      for (const s of byId.values()) {
        if (s.dependsOn !== id) continue;
        const childLen = Math.max(1, diffDays(s.start, s.end));
        // FS: child starts day after parent ends
        const desiredStart = addDaysIso(parent.end, 1);
        if (s.start < desiredStart) {
          s.start = desiredStart;
          s.end = addDaysIso(desiredStart, childLen);
          byId.set(s.id, s);
        }
        queue.push(s.id);
      }
    }
  }

  // conflict: dependent starts before predecessor ends
  for (const s of byId.values()) {
    if (!s.dependsOn) continue;
    const pred = byId.get(s.dependsOn);
    if (pred && s.start <= pred.end) {
      conflicts.push(
        `${s.id} starts ${s.start} before/on predecessor ${pred.id} end ${pred.end}`
      );
    }
  }

  return {
    stages: [...byId.values()].sort((a, b) => a.sequence - b.sequence),
    conflicts,
  };
}

export function workingDaysBetween(
  start: string,
  end: string,
  weekendDays: number[] = [0, 6]
): number {
  let n = 0;
  let cur = start;
  const last = end;
  while (cur <= last) {
    const dow = new Date(`${cur}T12:00:00Z`).getUTCDay();
    if (!weekendDays.includes(dow)) n += 1;
    cur = addDaysIso(cur, 1);
  }
  return n;
}
