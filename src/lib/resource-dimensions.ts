/**
 * Single shared dimension resolver for tree / cards / editing / all exports.
 * Explicit quantityBasis always wins. Ambiguous units → incomplete (never silent guess).
 */
import { roundMoney } from "@/lib/calc-math";
import { diffDays } from "@/lib/cost-engine";
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  resourceAmount,
  resourceHours,
  type ResourceScheduleParams,
} from "@/lib/resource-schedule-model";
import type {
  GprStage,
  GprStageResource,
  ResourceQuantityBasis,
} from "@/lib/types";

/** Normative hour units: чел.-ч / маш.-ч / н-ч with dots, spaces, hyphen, middot. */
const HOUR_UNIT_RE =
  /(?:маш|чел|н)\s*[.\u00b7\u2212\u2013\-]*\s*ч|машч|челч|нч|(?:^|[^а-яa-z])час(?:$|[^а-яa-z])/i;

export type ResolvedResourceDims = {
  basis: ResourceQuantityBasis;
  /** L — source quantity as entered (headcount / machines / material qty / hours). */
  sourceQty: number;
  hoursPerShift: number | null;
  shiftsPerDay: number | null;
  days: number | null;
  /** Q hours; null for materials or when incomplete. */
  hours: number | null;
  rate: number | null;
  /** R = Q×M (or qty×rate for materials); null when incomplete. */
  amount: number | null;
  incomplete: string[];
};

export function inferQuantityBasis(
  r: Pick<GprStageResource, "kind" | "unit" | "quantityBasis">
): ResourceQuantityBasis {
  if (r.quantityBasis) return r.quantityBasis;
  if (r.kind === "material") return "material_qty";
  const u = (r.unit || "").trim().toLowerCase();
  if (!u) {
    // Empty unit for labor/equipment/bus is ambiguous — do not invent.
    if (r.kind === "labor" || r.kind === "equipment" || r.kind === "bus") {
      return "uncertain";
    }
    return "uncertain";
  }
  if (HOUR_UNIT_RE.test(u)) return "total_hours";
  // Plain count units (not hour composites)
  if (
    (r.kind === "labor" || r.kind === "equipment" || r.kind === "bus") &&
    /^(чел|ед|маш|шт|авт|компл\.?|ед\.)$/i.test(u)
  ) {
    return "count_per_shift";
  }
  if (
    (r.kind === "labor" || r.kind === "equipment" || r.kind === "bus") &&
    /^(чел|ед|маш|шт|авт)/i.test(u) &&
    !HOUR_UNIT_RE.test(u)
  ) {
    return "count_per_shift";
  }
  return "uncertain";
}

export function stageCalendarDays(st: Pick<GprStage, "start" | "end">): number | null {
  if (!st.start || !st.end) return null;
  const d = diffDays(st.start, st.end);
  if (!Number.isFinite(d) || d < 0) return null;
  return d + 1;
}

function resolveCountDims(
  r: GprStageResource,
  st: Pick<GprStage, "start" | "end" | "hoursPerShift" | "shiftsPerDay">,
  params: ResourceScheduleParams
): {
  hoursPerShift: number | null;
  shiftsPerDay: number | null;
  days: number | null;
  incomplete: string[];
} {
  const incomplete: string[] = [];
  const hoursPerShift =
    r.hoursPerShift ?? st.hoursPerShift ?? params.hoursPerShift ?? null;
  const shiftsPerDay =
    r.shiftsPerDay ??
    st.shiftsPerDay ??
    (r.kind === "labor"
      ? params.personnelShiftsPerDay
      : params.equipmentShiftsPerDay) ??
    null;
  const days = r.days ?? stageCalendarDays(st);
  if (hoursPerShift == null || !Number.isFinite(hoursPerShift)) {
    incomplete.push(`hours_per_shift_unknown:${r.id}`);
  }
  if (shiftsPerDay == null || !Number.isFinite(shiftsPerDay)) {
    incomplete.push(`shifts_per_day_unknown:${r.id}`);
  }
  if (days == null || !Number.isFinite(days)) {
    incomplete.push(`days_unknown:${r.id}`);
  }
  return { hoursPerShift, shiftsPerDay, days, incomplete };
}

/**
 * Resolve Q/R for one stage resource — shared by tree, sync, exports.
 */
export function resolveResourceDimensions(
  r: GprStageResource,
  st: Pick<GprStage, "id" | "start" | "end" | "hoursPerShift" | "shiftsPerDay">,
  params: ResourceScheduleParams = EXCEL_RESOURCE_SCHEDULE_DEFAULTS
): ResolvedResourceDims {
  const basis = inferQuantityBasis(r);
  const rate =
    r.rate == null || !Number.isFinite(r.rate) || r.rate < 0 ? null : r.rate;
  const incomplete: string[] = [];
  if (rate == null) incomplete.push(`missing_tariff:${r.id}`);

  if (basis === "material_qty") {
    const amount =
      rate == null ? null : roundMoney(r.quantity * rate);
    return {
      basis,
      sourceQty: r.quantity,
      hoursPerShift: null,
      shiftsPerDay: null,
      days: null,
      hours: null,
      rate,
      amount,
      incomplete: rate == null ? incomplete : [],
    };
  }

  if (basis === "uncertain") {
    incomplete.push(`unit_basis_uncertain:${r.id}`);
    return {
      basis,
      sourceQty: r.quantity,
      hoursPerShift: null,
      shiftsPerDay: null,
      days: null,
      hours: null,
      rate,
      amount: null,
      incomplete,
    };
  }

  if (basis === "total_hours") {
    // L already hours — do NOT re-multiply by N/O/P.
    const hours = Number.isFinite(r.quantity) ? r.quantity : null;
    const { amount, incomplete: amtInc } = resourceAmount(hours, rate);
    return {
      basis,
      sourceQty: r.quantity,
      hoursPerShift: 1,
      shiftsPerDay: 1,
      days: 1,
      hours,
      rate,
      amount: amtInc.length || hours == null ? null : amount,
      incomplete: [
        ...incomplete,
        ...(hours == null ? [`hours_inputs:${r.id}`] : []),
        ...amtInc.map((a) => `${a}:${r.id}`),
      ].filter((x, i, a) => a.indexOf(x) === i),
    };
  }

  // count_per_shift → Q = L×N×O×P
  const dims = resolveCountDims(r, st, params);
  incomplete.push(...dims.incomplete);
  let hours: number | null = null;
  if (
    dims.hoursPerShift != null &&
    dims.shiftsPerDay != null &&
    dims.days != null
  ) {
    hours = resourceHours({
      quantity: r.quantity,
      hoursPerShift: dims.hoursPerShift,
      shiftsPerDay: dims.shiftsPerDay,
      days: dims.days,
    });
  }
  const { amount, incomplete: amtInc } = resourceAmount(hours, rate);
  for (const a of amtInc) {
    if (a === "hours_inputs") incomplete.push(`hours_inputs:${r.id}`);
    else if (a === "missing_tariff" && !incomplete.includes(`missing_tariff:${r.id}`)) {
      incomplete.push(`missing_tariff:${r.id}`);
    }
  }
  const ok = hours != null && rate != null && amtInc.length === 0;
  return {
    basis,
    sourceQty: r.quantity,
    hoursPerShift: dims.hoursPerShift,
    shiftsPerDay: dims.shiftsPerDay,
    days: dims.days,
    hours,
    rate,
    amount: ok ? amount : null,
    incomplete: [...new Set(incomplete)],
  };
}
