/**
 * Unified resource model (t25u): GPR stage resources → draft cost slices V/W/X/Y/Z.
 *
 * Dimensions: do NOT force N=O=P=1.
 * - count_per_shift → Q = qty × h × shifts × days
 * - total_hours → Q = qty (already hours)
 * - material_qty → R = qty × rate; never in Q-hours
 * - uncertain → incomplete, no invented dims / no silent zero total
 *
 * Buses across stages are summed (never leave-first). Full machine-hour tariff
 * embeds fuel/driver — do not discard buses to avoid double-count.
 */
import { roundMoney } from "@/lib/calc-math";
import { diffDays } from "@/lib/cost-engine";
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  resourceAmount,
  resourceHours,
  rollupResourceSchedule,
  type ResourceScheduleLine,
  type ResourceScheduleParams,
  type ResourceScheduleResult,
} from "@/lib/resource-schedule-model";
import type {
  CalcPosition,
  Calculation,
  CostSummarySnapshot,
  GprStage,
  GprStageResource,
  ResourceQuantityBasis,
} from "@/lib/types";

export type UnifiedResourceBuild = {
  lines: ResourceScheduleLine[];
  materialsTotal: number;
  skipped: string[];
  incomplete: string[];
  knownDirect: number;
  /** Q-hours from non-material lines with known hour inputs only. */
  knownHours: number;
};

export function isResourceLinkedDraft(calc: Calculation): boolean {
  if (calc.immutable || calc.kind === "customer_original") return false;
  if (calc.kind !== "resource_draft" && calc.kind != null) return false;
  const flags = calc.dataFlags ?? [];
  return (
    Boolean(calc.resourceScheduleParams) ||
    flags.includes("unified_resource_tree") ||
    flags.includes("t25u_test_fixture") ||
    flags.includes("synced_from_gpr_stages")
  );
}

export function inferQuantityBasis(
  r: GprStageResource
): ResourceQuantityBasis {
  if (r.quantityBasis) return r.quantityBasis;
  if (r.kind === "material") return "material_qty";
  const u = (r.unit || "").toLowerCase();
  if (/маш-?ч|н-?ч|чел-?ч|час/.test(u)) return "total_hours";
  if (r.kind === "labor" || r.kind === "equipment" || r.kind === "bus") {
    if (/чел|ед|маш|шт|авт/.test(u) || !u) return "count_per_shift";
  }
  return "uncertain";
}

function categoryOf(
  kind: GprStageResource["kind"]
): "people" | "equipment" | "material" | null {
  if (kind === "labor") return "people";
  if (kind === "material") return "material";
  if (kind === "equipment" || kind === "bus") return "equipment";
  return null;
}

function stageCalendarDays(st: GprStage): number | null {
  if (!st.start || !st.end) return null;
  const d = diffDays(st.start, st.end);
  if (!Number.isFinite(d) || d < 0) return null;
  return d + 1;
}

function resolveCountDims(
  r: GprStageResource,
  st: GprStage,
  params: ResourceScheduleParams
): {
  hoursPerShift: number | null;
  shiftsPerDay: number | null;
  days: number | null;
  incomplete: string[];
} {
  const incomplete: string[] = [];
  const hoursPerShift =
    r.hoursPerShift ??
    st.hoursPerShift ??
    params.hoursPerShift ??
    null;
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
 * Map stage resources → Excel-style lines with real dimensions.
 * Materials never contribute to Q-hours. Distinct buses are all kept and summed.
 */
export function stagesToResourceLines(
  stages: GprStage[],
  params: ResourceScheduleParams = EXCEL_RESOURCE_SCHEDULE_DEFAULTS
): UnifiedResourceBuild {
  const skipped: string[] = [];
  const incomplete: string[] = [];
  const lines: ResourceScheduleLine[] = [];
  let materialsTotal = 0;
  let knownDirect = 0;
  let knownHours = 0;

  const sorted = stages.slice().sort((a, b) => a.sequence - b.sequence);
  for (const st of sorted) {
    for (const r of st.resources ?? []) {
      const cat = categoryOf(r.kind);
      if (!cat) {
        skipped.push(`unclassified:${r.id}`);
        continue;
      }

      const rate =
        r.rate == null || !Number.isFinite(r.rate) || r.rate < 0
          ? null
          : r.rate;
      if (rate == null) incomplete.push(`missing_tariff:${r.id}`);

      const basis = inferQuantityBasis(r);
      let hoursPerShift = 1;
      let shiftsPerDay = 1;
      let days = 1;
      let lineHours: number | null = null;

      if (basis === "material_qty") {
        // Materials: R = qty × rate; Q-hours not applicable.
        if (rate != null) {
          const amt = roundMoney(r.quantity * rate);
          materialsTotal = roundMoney(materialsTotal + amt);
          knownDirect = roundMoney(knownDirect + amt);
        }
        // Represent as qty with identity dims so rollup line R matches qty×rate,
        // but hours are excluded from knownHours below via category filter.
        lines.push({
          id: r.id,
          workId: st.id,
          kind: "resource",
          name: r.name,
          category: "material",
          quantity: r.quantity,
          rate,
          hoursPerShift: 1,
          shiftsPerDay: 1,
          days: 1,
          tariffBasis: "unspecified",
        });
        continue;
      }

      if (basis === "uncertain") {
        incomplete.push(`unit_basis_uncertain:${r.id}`);
        lines.push({
          id: r.id,
          workId: st.id,
          kind: "resource",
          name: r.name,
          category: cat,
          quantity: r.quantity,
          rate,
          // Non-finite dims → resourceHours returns null → incomplete, not invented 1s
          hoursPerShift: Number.NaN,
          shiftsPerDay: Number.NaN,
          days: Number.NaN,
          tariffBasis: "unspecified",
        });
        continue;
      }

      if (basis === "total_hours") {
        // L already hours — identity factors are definitional, not invented schedule.
        hoursPerShift = 1;
        shiftsPerDay = 1;
        days = 1;
        lineHours = resourceHours({
          quantity: r.quantity,
          hoursPerShift,
          shiftsPerDay,
          days,
        });
      } else {
        // count_per_shift
        const dims = resolveCountDims(r, st, params);
        incomplete.push(...dims.incomplete);
        if (
          dims.hoursPerShift == null ||
          dims.shiftsPerDay == null ||
          dims.days == null
        ) {
          hoursPerShift = Number.NaN;
          shiftsPerDay = Number.NaN;
          days = Number.NaN;
          lineHours = null;
        } else {
          hoursPerShift = dims.hoursPerShift;
          shiftsPerDay = dims.shiftsPerDay;
          days = dims.days;
          lineHours = resourceHours({
            quantity: r.quantity,
            hoursPerShift,
            shiftsPerDay,
            days,
          });
        }
      }

      const { amount, incomplete: amtInc } = resourceAmount(lineHours, rate);
      for (const a of amtInc) {
        if (a === "hours_inputs") incomplete.push(`hours_inputs:${r.id}`);
      }

      lines.push({
        id: r.id,
        workId: st.id,
        kind: "resource",
        name: r.name,
        category: cat,
        quantity: r.quantity,
        rate,
        hoursPerShift,
        shiftsPerDay,
        days,
        tariffBasis:
          r.kind === "bus"
            ? "schedule_fixed"
            : rate == null
              ? "unspecified"
              : "schedule_fixed",
      });

      if (lineHours != null && rate != null && amtInc.length === 0) {
        knownDirect = roundMoney(knownDirect + amount);
        knownHours = roundMoney(knownHours + lineHours);
      }
    }
  }

  return { lines, materialsTotal, skipped, incomplete, knownDirect, knownHours };
}

function codeForResource(r: GprStageResource, index: number): string {
  if (r.kind === "labor") return `LAB-${index}`;
  if (r.kind === "material") return `MAT-${index}`;
  if (r.kind === "equipment") return `EQ-${index}`;
  if (r.kind === "bus") return `BUS-${index}`;
  return `RES-${index}`;
}

/** Build draft positions from stage resources (all buses kept). */
export function positionsFromStages(
  stages: GprStage[],
  previous: CalcPosition[] = [],
  params: ResourceScheduleParams = EXCEL_RESOURCE_SCHEDULE_DEFAULTS
): CalcPosition[] {
  const prevByName = new Map(
    previous
      .filter((p) => p.code !== "НР" && p.code !== "СП")
      .map((p) => [p.name.toLowerCase(), p])
  );
  const out: CalcPosition[] = [];
  let i = 0;
  for (const st of stages.slice().sort((a, b) => a.sequence - b.sequence)) {
    for (const r of st.resources ?? []) {
      if (!categoryOf(r.kind)) continue;
      i += 1;
      const basis = inferQuantityBasis(r);
      const prev = prevByName.get(r.name.toLowerCase());
      const rateMissing =
        r.rate == null || !Number.isFinite(r.rate) || r.rate < 0;

      let quantity = r.quantity;
      let unit = r.unit || (r.kind === "labor" ? "чел" : "ед.");
      if (basis === "count_per_shift") {
        const dims = resolveCountDims(r, st, params);
        if (
          dims.hoursPerShift != null &&
          dims.shiftsPerDay != null &&
          dims.days != null
        ) {
          const q = resourceHours({
            quantity: r.quantity,
            hoursPerShift: dims.hoursPerShift,
            shiftsPerDay: dims.shiftsPerDay,
            days: dims.days,
          });
          if (q != null) {
            quantity = q;
            unit = r.kind === "labor" ? "н-ч" : "маш-ч";
          }
        }
      }

      out.push({
        id: prev?.id ?? `urp-${r.id}`,
        code: prev?.code ?? codeForResource(r, i),
        name: r.name,
        unit,
        quantity,
        rate: rateMissing ? 0 : (r.rate as number),
        rateMissing,
        normId: prev?.normId,
        priceId: prev?.priceId,
      });
    }
  }
  return out;
}

export function applyRollupToCostSummary(
  rollup: ResourceScheduleResult,
  extraIncomplete: string[] = [],
  knownHours = 0
): CostSummarySnapshot {
  const incomplete = [...new Set([...rollup.incomplete, ...extraIncomplete])];
  const totalsIncomplete = incomplete.length > 0;
  return {
    C0: rollup.costWithOh,
    C: rollup.costWithOh,
    reserve: 0,
    profit: rollup.profit,
    priceExVat: rollup.total,
    vatAmount: null,
    priceIncVat: null,
    method: "cost-engine:markup+resource-schedule-excel+unified-tree",
    incomplete,
    totalsIncomplete,
    at: new Date().toISOString(),
    resourceSlices: {
      materials: rollup.materials,
      labor: rollup.labor,
      equipment: rollup.equipment,
      direct: rollup.direct,
      overhead: rollup.overhead,
      costWithOh: rollup.costWithOh,
      profit: rollup.profit,
      total: rollup.total,
      hours: knownHours,
      knownAmount: roundMoney(
        rollup.lines
          .filter((l) => l.incomplete.length === 0)
          .reduce((s, l) => s + l.amount, 0)
      ),
      partial: totalsIncomplete,
      skipped: extraIncomplete.filter(
        (x) =>
          x.startsWith("unit_basis_uncertain:") ||
          x.startsWith("hours_inputs:")
      ),
    },
  };
}

/**
 * Recompute resource-linked draft from GPR stages.
 * Does NOT replace positions unless replacePositions=true (explicit linked draft).
 */
export function syncDraftFromStages(
  calc: Calculation,
  stages: GprStage[],
  opts?: { replacePositions?: boolean }
): {
  calc: Calculation;
  build: UnifiedResourceBuild;
  rollup: ResourceScheduleResult;
} {
  const params = calc.resourceScheduleParams ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
  const build = stagesToResourceLines(stages, params);
  const replacePositions =
    opts?.replacePositions ?? isResourceLinkedDraft(calc);
  const positions = replacePositions
    ? positionsFromStages(stages, calc.positions, params)
    : calc.positions;
  const rollup = rollupResourceSchedule({
    params,
    lines: build.lines,
    materialsTotal: build.materialsTotal,
  });
  const incomplete = [
    ...build.incomplete,
    ...build.skipped,
    ...rollup.incomplete.filter((x) => x !== "materials_external_or_missing"),
  ];
  // Recompute knownHours excluding material lines
  const knownHours = roundMoney(
    build.lines
      .filter((l) => l.category !== "material")
      .reduce((s, l) => {
        const h = resourceHours(l);
        const { incomplete: inc } = resourceAmount(h, l.rate);
        if (h == null || inc.length) return s;
        return s + h;
      }, 0)
  );
  const next: Calculation = {
    ...calc,
    positions,
    resourceScheduleParams: params,
    costSummary: applyRollupToCostSummary(rollup, incomplete, knownHours),
    dataFlags: replacePositions
      ? [
          ...(calc.dataFlags ?? []).filter(
            (f) =>
              f !== "unified_resource_tree" && f !== "synced_from_gpr_stages"
          ),
          "unified_resource_tree",
          "synced_from_gpr_stages",
        ]
      : calc.dataFlags,
    updatedAt: new Date().toISOString(),
  };
  return { calc: next, build, rollup };
}

export function patchStageResource(
  stages: GprStage[],
  resourceId: string,
  patch: {
    quantity?: number;
    rate?: number | null;
    hoursPerShift?: number | null;
    shiftsPerDay?: number | null;
    days?: number | null;
  },
  stageId?: string
): GprStage[] {
  return stages.map((s) => {
    if (stageId && s.id !== stageId) return s;
    const resources = (s.resources ?? []).map((r) => {
      if (r.id !== resourceId) return r;
      return {
        ...r,
        quantity: patch.quantity ?? r.quantity,
        rate: patch.rate !== undefined ? patch.rate : r.rate,
        hoursPerShift:
          patch.hoursPerShift !== undefined
            ? patch.hoursPerShift
            : r.hoursPerShift,
        shiftsPerDay:
          patch.shiftsPerDay !== undefined
            ? patch.shiftsPerDay
            : r.shiftsPerDay,
        days: patch.days !== undefined ? patch.days : r.days,
      };
    });
    return { ...s, resources };
  });
}
