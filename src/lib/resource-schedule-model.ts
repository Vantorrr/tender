/**
 * Flexible resource-schedule cost model aligned with Excel «Ресурсный_график»
 * semantics (locators B4–B9, Q=L*N*O*P, R=Q*M, V/W/X/Y/Z).
 *
 * Does NOT hardcode road-project totals. Missing rates → incomplete, amount 0
 * (same as Excel K4 warning), never invented tariffs.
 */
import { roundMoney } from "@/lib/calc-math";

/** Params = Ресурсный_график!B4:B9 */
export type ResourceScheduleParams = {
  /** B4 — руб./чел.-ч */
  personHourRate: number;
  /** B5 */
  personnelShiftsPerDay: number;
  /** B6 */
  hoursPerShift: number;
  /** B7 */
  equipmentShiftsPerDay: number;
  /** B8 — НР as fraction of directs */
  overheadRate: number;
  /**
   * B9 — markup on cost-with-OH (X), NOT margin of revenue.
   * Excel H5: «Себестоимость с НР × 40%».
   */
  profitMarkupOnCostWithOh: number;
};

export const EXCEL_RESOURCE_SCHEDULE_DEFAULTS: ResourceScheduleParams = {
  personHourRate: 1400,
  personnelShiftsPerDay: 2,
  hoursPerShift: 11,
  equipmentShiftsPerDay: 1,
  overheadRate: 0.43,
  profitMarkupOnCostWithOh: 0.4,
};

export type ResourceLineCategory = "people" | "equipment" | "material";

/**
 * Tariff provenance — do not silently pick one when several bases exist
 * (e.g. schedule M17=2650 vs Тарифы!AH21≈3438.89).
 */
export type TariffBasis =
  | "schedule_fixed"
  | "tariffs_sheet_full"
  | "person_hour_param"
  | "unspecified";

export type ResourceScheduleLine = {
  id: string;
  workId: string;
  kind: "work" | "resource";
  name: string;
  category?: ResourceLineCategory;
  /** L */
  quantity: number;
  /** M — null = нет тарифа (как K4→0 в итоге + incomplete) */
  rate: number | null;
  tariffBasis?: TariffBasis;
  /** N */
  hoursPerShift: number;
  /** O */
  shiftsPerDay: number;
  /** P — participation days (ordinal schedule days, not calendar dates) */
  days: number;
};

export type ResourceWorkRollup = {
  workId: string;
  materials: number;
  labor: number;
  equipment: number;
  direct: number;
  overhead: number;
  costWithOh: number;
  profit: number;
  total: number;
  incomplete: string[];
};

export type ResourceScheduleResult = {
  params: ResourceScheduleParams;
  /** S — materials total (project input; may come from external book cache) */
  materials: number;
  /** T */
  labor: number;
  /** U */
  equipment: number;
  /** V = S+T+U */
  direct: number;
  /** W = V * B8 */
  overhead: number;
  /** X = V+W  (себестоимость с НР; без общего резерва непредвиденных) */
  costWithOh: number;
  /** Y = X * B9 */
  profit: number;
  /** Z = X+Y */
  total: number;
  lines: Array<{
    id: string;
    workId: string;
    /** Q */
    hours: number;
    /** R */
    amount: number;
    incomplete: string[];
  }>;
  byWork: ResourceWorkRollup[];
  incomplete: string[];
  flags: string[];
};

/** Q = L * N * O * P when all numeric (Excel IF(ISNUMBER…)). */
export function resourceHours(line: {
  quantity: number;
  hoursPerShift: number;
  shiftsPerDay: number;
  days: number;
}): number | null {
  const { quantity, hoursPerShift, shiftsPerDay, days } = line;
  if (
    ![quantity, hoursPerShift, shiftsPerDay, days].every(
      (n) => Number.isFinite(n) && n >= 0
    )
  ) {
    return null;
  }
  return quantity * hoursPerShift * shiftsPerDay * days;
}

/** R = Q * M when rate confirmed. */
export function resourceAmount(
  hours: number | null,
  rate: number | null
): { amount: number; incomplete: string[] } {
  if (hours == null) return { amount: 0, incomplete: ["hours_inputs"] };
  if (rate == null || !Number.isFinite(rate) || rate < 0) {
    return { amount: 0, incomplete: ["missing_tariff"] };
  }
  return { amount: roundMoney(hours * rate), incomplete: [] };
}

/**
 * Machine-hour full tariff (Excel bus/equipment): hours×rate.
 * Full rate already includes amort/GSM/FOT/TO/(embedded OH policy) —
 * do NOT add driver or fuel on top.
 */
export function machineHourFullTariffCost(input: {
  quantity: number;
  ratePerMachineHour: number;
  hoursPerShift: number;
  shiftsPerDay: number;
  days: number;
}): { hours: number; amount: number; flags: string[] } {
  const hours =
    resourceHours({
      quantity: input.quantity,
      hoursPerShift: input.hoursPerShift,
      shiftsPerDay: input.shiftsPerDay,
      days: input.days,
    }) ?? 0;
  return {
    hours,
    amount: roundMoney(hours * input.ratePerMachineHour),
    flags: [
      "full_machine_hour_tariff",
      "no_extra_fuel_or_driver_on_top",
      "fuel_basis_liters_per_hour_in_tariffs_sheet",
    ],
  };
}

export function rollupResourceSchedule(opts: {
  params: ResourceScheduleParams;
  lines: ResourceScheduleLine[];
  /** External/project materials total (S). */
  materialsTotal?: number;
  /** Optional per-work materials map. */
  materialsByWork?: Record<string, number>;
}): ResourceScheduleResult {
  const flags: string[] = [
    "resource_schedule_excel_semantics",
    "profit_is_markup_on_cost_with_oh",
    "no_contingency_reserve_in_sheet",
  ];
  const incomplete: string[] = [];
  const lineOut: ResourceScheduleResult["lines"] = [];
  const workIds = new Set<string>();

  let labor = 0;
  let equipment = 0;

  for (const line of opts.lines) {
    if (line.kind !== "resource") continue;
    workIds.add(line.workId);
    const hours = resourceHours(line);
    const { amount, incomplete: inc } = resourceAmount(hours, line.rate);
    const lineInc = inc.map((i) => `${i}:${line.id}`);
    if (line.rate == null) incomplete.push(`missing_tariff:${line.id}`);
    lineOut.push({
      id: line.id,
      workId: line.workId,
      hours: hours ?? 0,
      amount,
      incomplete: lineInc,
    });
    if (line.category === "people") labor = roundMoney(labor + amount);
    else if (line.category === "equipment")
      equipment = roundMoney(equipment + amount);
    else if (line.category === "material") {
      // materials usually via S; if line-level, still track
      labor = labor; // no-op keep structure
    }

    if (
      line.tariffBasis === "schedule_fixed" ||
      line.tariffBasis === "tariffs_sheet_full"
    ) {
      flags.push(`tariff_basis:${line.id}:${line.tariffBasis}`);
    }
  }

  const materials = roundMoney(
    opts.materialsTotal ??
      Object.values(opts.materialsByWork ?? {}).reduce((s, n) => s + n, 0)
  );
  if (opts.materialsTotal == null && !opts.materialsByWork) {
    incomplete.push("materials_external_or_missing");
  }

  const direct = roundMoney(materials + labor + equipment);
  const overhead = roundMoney(direct * opts.params.overheadRate);
  const costWithOh = roundMoney(direct + overhead);
  const profit = roundMoney(
    costWithOh * opts.params.profitMarkupOnCostWithOh
  );
  const total = roundMoney(costWithOh + profit);

  const byWork: ResourceWorkRollup[] = [...workIds].map((workId) => {
    const wLines = lineOut.filter((l) => l.workId === workId);
    const wLabor = roundMoney(
      opts.lines
        .filter(
          (l) =>
            l.workId === workId &&
            l.kind === "resource" &&
            l.category === "people"
        )
        .reduce((s, l) => {
          const h = resourceHours(l);
          return s + resourceAmount(h, l.rate).amount;
        }, 0)
    );
    const wEq = roundMoney(
      opts.lines
        .filter(
          (l) =>
            l.workId === workId &&
            l.kind === "resource" &&
            l.category === "equipment"
        )
        .reduce((s, l) => {
          const h = resourceHours(l);
          return s + resourceAmount(h, l.rate).amount;
        }, 0)
    );
    const wMat = roundMoney(opts.materialsByWork?.[workId] ?? 0);
    const wDirect = roundMoney(wMat + wLabor + wEq);
    const wOh = roundMoney(wDirect * opts.params.overheadRate);
    const wX = roundMoney(wDirect + wOh);
    const wY = roundMoney(wX * opts.params.profitMarkupOnCostWithOh);
    return {
      workId,
      materials: wMat,
      labor: wLabor,
      equipment: wEq,
      direct: wDirect,
      overhead: wOh,
      costWithOh: wX,
      profit: wY,
      total: roundMoney(wX + wY),
      incomplete: wLines.flatMap((l) => l.incomplete),
    };
  });

  return {
    params: opts.params,
    materials,
    labor,
    equipment,
    direct,
    overhead,
    costWithOh,
    profit,
    total,
    lines: lineOut,
    byWork,
    incomplete: [...new Set(incomplete)],
    flags: [...new Set(flags)],
  };
}

/**
 * Map schedule rollup → cost-engine inputs (Excel sheet has no separate
 * contingency reserve; vacation reserve ≠ project contingency).
 */
export function costEngineInputFromResourceSchedule(
  result: ResourceScheduleResult,
  opts?: {
    northernKnown?: number;
    contingencyReserve?: number;
    vatPercent?: number | null;
  }
): {
  directLabor: number;
  directMaterials: number;
  directEquipment: number;
  directSubcontract: number;
  logisticsIncludingBus: number;
  siteOverhead: number;
  officeOverhead: number;
  reserve: number;
  profitMethod: "markup";
  profitRate: number;
  includeReserveInPriceBase: boolean;
  note: string;
} {
  // Equipment bucket includes bus machine-hours when modeled as equipment lines.
  return {
    directLabor: result.labor,
    directMaterials: result.materials,
    directEquipment: result.equipment,
    directSubcontract: 0,
    logisticsIncludingBus: 0,
    // Combined OH as siteOverhead; office=0 unless split confirmed.
    siteOverhead: result.overhead,
    officeOverhead: 0,
    reserve: opts?.contingencyReserve ?? 0,
    profitMethod: "markup",
    profitRate: result.params.profitMarkupOnCostWithOh,
    // Excel marks up X (cost with OH) before adding contingency; contingency
    // absent on sheet → default not in price base until confirmed.
    includeReserveInPriceBase: false,
    note: "excel_resource_schedule: OH on D; profit markup on D+OH; no contingency on sheet",
  };
}
