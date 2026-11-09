/**
 * Unified resource model (t25u): GPR stage resources → draft cost slices V/W/X/Y/Z.
 * Dimensions come from shared resolveResourceDimensions (tree / export / sync).
 */
import { roundMoney } from "@/lib/calc-math";
import {
  inferQuantityBasis,
  resolveResourceDimensions,
} from "@/lib/resource-dimensions";
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
} from "@/lib/types";

export { inferQuantityBasis, resolveResourceDimensions } from "@/lib/resource-dimensions";

export type UnifiedResourceBuild = {
  lines: ResourceScheduleLine[];
  materialsTotal: number;
  skipped: string[];
  incomplete: string[];
  knownDirect: number;
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

function categoryOf(
  kind: GprStageResource["kind"]
): "people" | "equipment" | "material" | null {
  if (kind === "labor") return "people";
  if (kind === "material") return "material";
  if (kind === "equipment" || kind === "bus") return "equipment";
  return null;
}

/**
 * Map stage resources → Excel-style lines via shared dimension resolver.
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

      const resolved = resolveResourceDimensions(r, st, params);
      incomplete.push(...resolved.incomplete);

      if (resolved.basis === "material_qty") {
        if (resolved.amount != null) {
          materialsTotal = roundMoney(materialsTotal + resolved.amount);
          knownDirect = roundMoney(knownDirect + resolved.amount);
        }
        lines.push({
          id: r.id,
          workId: st.id,
          kind: "resource",
          name: r.name,
          category: "material",
          quantity: resolved.sourceQty,
          rate: resolved.rate,
          hoursPerShift: 1,
          shiftsPerDay: 1,
          days: 1,
          tariffBasis: "unspecified",
        });
        continue;
      }

      if (resolved.basis === "uncertain") {
        lines.push({
          id: r.id,
          workId: st.id,
          kind: "resource",
          name: r.name,
          category: cat,
          quantity: resolved.sourceQty,
          rate: resolved.rate,
          hoursPerShift: Number.NaN,
          shiftsPerDay: Number.NaN,
          days: Number.NaN,
          tariffBasis: "unspecified",
        });
        continue;
      }

      const hoursPerShift =
        resolved.basis === "total_hours"
          ? 1
          : (resolved.hoursPerShift ?? Number.NaN);
      const shiftsPerDay =
        resolved.basis === "total_hours"
          ? 1
          : (resolved.shiftsPerDay ?? Number.NaN);
      const days =
        resolved.basis === "total_hours" ? 1 : (resolved.days ?? Number.NaN);

      // For total_hours: quantity on the line IS hours (L), N=O=P=1.
      // For count_per_shift: quantity is L (count); N/O/P from resolved.
      lines.push({
        id: r.id,
        workId: st.id,
        kind: "resource",
        name: r.name,
        category: cat,
        quantity: resolved.sourceQty,
        rate: resolved.rate,
        hoursPerShift,
        shiftsPerDay,
        days,
        tariffBasis:
          r.kind === "bus"
            ? "schedule_fixed"
            : resolved.rate == null
              ? "unspecified"
              : "schedule_fixed",
      });

      if (resolved.amount != null && resolved.hours != null) {
        knownDirect = roundMoney(knownDirect + resolved.amount);
        knownHours = roundMoney(knownHours + resolved.hours);
      }
    }
  }

  return {
    lines,
    materialsTotal,
    skipped,
    incomplete: [...new Set(incomplete)],
    knownDirect,
    knownHours,
  };
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
  const prevByName = new Map<string, CalcPosition[]>();
  for (const position of previous) {
    if (position.code === "НР" || position.code === "СП") continue;
    const key = position.name.trim().toLowerCase();
    prevByName.set(key, [...(prevByName.get(key) ?? []), position]);
  }
  const usedPreviousIds = new Set<string>();
  const out: CalcPosition[] = [];
  let i = 0;
  for (const st of stages.slice().sort((a, b) => a.sequence - b.sequence)) {
    for (const r of st.resources ?? []) {
      if (!categoryOf(r.kind)) continue;
      i += 1;
      const resolved = resolveResourceDimensions(r, st, params);
      const candidates = prevByName.get(r.name.trim().toLowerCase()) ?? [];
      const prev =
        candidates.find(
          (p) => p.sourceResourceId === r.id && !usedPreviousIds.has(p.id)
        ) ??
        candidates.find(
          (p) => !p.sourceResourceId && !usedPreviousIds.has(p.id)
        );
      if (prev) usedPreviousIds.add(prev.id);
      const rateMissing = resolved.rate == null;

      let quantity = resolved.sourceQty;
      let unit = r.unit || (r.kind === "labor" ? "чел" : "ед.");
      if (
        resolved.basis === "count_per_shift" &&
        resolved.hours != null
      ) {
        quantity = resolved.hours;
        unit = r.kind === "labor" ? "н-ч" : "маш-ч";
      } else if (resolved.basis === "total_hours") {
        unit = r.unit || (r.kind === "labor" ? "чел.-ч" : "маш.-ч");
      }

      out.push({
        id: prev?.id ?? `urp-${r.id}`,
        sourceResourceId: r.id,
        code: prev?.code ?? codeForResource(r, i),
        name: r.name,
        unit,
        quantity,
        rate: rateMissing ? 0 : (resolved.rate as number),
        rateMissing,
        normId: prev?.normId,
        priceId: prev?.priceId,
      });
    }
  }
  // Keep cost-draft positions that are not linked to a GPR resource. The
  // customer's immutable estimate is a separate Calculation and never enters
  // this sync. Old generated positions are recognized by their legacy id.
  const manual = previous.filter(
    (position) =>
      position.code !== "НР" &&
      position.code !== "СП" &&
      !position.sourceResourceId &&
      !position.id.startsWith("urp-") &&
      !usedPreviousIds.has(position.id)
  );
  return [...out, ...manual];
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
