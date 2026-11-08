/**
 * Unified resource model (t25u): GPR stage resources are the draft source of truth.
 * Tree qty/rate edits → positions + cost-engine (V/W/X/Y/Z) + GPR summary + export.
 * Duplicate bus lines are skipped (no double bus/GSM/driver). Missing rate → incomplete,
 * never forced to 0 ₽ in confirmed totals.
 */
import { roundMoney } from "@/lib/calc-math";
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
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

export type UnifiedResourceBuild = {
  lines: ResourceScheduleLine[];
  materialsTotal: number;
  skipped: string[];
  incomplete: string[];
  /** Sum of known leaf R (qty×rate) before OH — tree «известное». */
  knownDirect: number;
};

function categoryOf(
  kind: GprStageResource["kind"]
): "people" | "equipment" | "material" | null {
  if (kind === "labor") return "people";
  if (kind === "material") return "material";
  if (kind === "equipment" || kind === "bus") return "equipment";
  return null;
}

/**
 * Map stage resources → Excel-style lines.
 * Unit-priced resources use N=O=P=1 so Q=qty and R=qty×rate (UI tree identity).
 * At most one bus line is kept (first by stage sequence).
 */
export function stagesToResourceLines(
  stages: GprStage[],
  _params: ResourceScheduleParams = EXCEL_RESOURCE_SCHEDULE_DEFAULTS
): UnifiedResourceBuild {
  void _params;
  const skipped: string[] = [];
  const incomplete: string[] = [];
  const lines: ResourceScheduleLine[] = [];
  let materialsTotal = 0;
  let knownDirect = 0;
  let busTaken = false;

  const sorted = stages.slice().sort((a, b) => a.sequence - b.sequence);
  for (const st of sorted) {
    for (const r of st.resources ?? []) {
      const cat = categoryOf(r.kind);
      if (!cat) {
        skipped.push(`unclassified:${r.id}`);
        continue;
      }
      if (r.kind === "bus") {
        if (busTaken) {
          skipped.push(`duplicate_bus:${r.id}`);
          continue;
        }
        busTaken = true;
      }

      const rate =
        r.rate == null || !Number.isFinite(r.rate) || r.rate < 0
          ? null
          : r.rate;
      if (rate == null) incomplete.push(`missing_tariff:${r.id}`);

      // Unit-priced: Q = L (hoursPerShift=shiftsPerDay=days=1).
      const line: ResourceScheduleLine = {
        id: r.id,
        workId: st.id,
        kind: "resource",
        name: r.name,
        category: cat,
        quantity: r.quantity,
        rate,
        hoursPerShift: 1,
        shiftsPerDay: 1,
        days: 1,
        tariffBasis:
          r.kind === "bus"
            ? "schedule_fixed"
            : rate == null
              ? "unspecified"
              : "schedule_fixed",
      };
      lines.push(line);

      if (rate != null) {
        const amt = roundMoney(r.quantity * rate);
        knownDirect = roundMoney(knownDirect + amt);
        if (cat === "material") {
          materialsTotal = roundMoney(materialsTotal + amt);
        }
      }
    }
  }

  return { lines, materialsTotal, skipped, incomplete, knownDirect };
}

function codeForResource(r: GprStageResource, index: number): string {
  if (r.kind === "labor") return `LAB-${index}`;
  if (r.kind === "material") return `MAT-${index}`;
  if (r.kind === "equipment") return `EQ-${index}`;
  if (r.kind === "bus") return `BUS-${index}`;
  return `RES-${index}`;
}

/** Build draft positions from unified resource lines (deduped). Preserve ids by name+kind. */
export function positionsFromStages(
  stages: GprStage[],
  previous: CalcPosition[] = []
): CalcPosition[] {
  const build = stagesToResourceLines(stages);
  const prevByKey = new Map(
    previous
      .filter((p) => p.code !== "НР" && p.code !== "СП")
      .map((p) => [`${p.name.toLowerCase()}`, p])
  );
  const out: CalcPosition[] = [];
  let i = 0;
  const sorted = stages.slice().sort((a, b) => a.sequence - b.sequence);
  const seenBus = { taken: false };
  for (const st of sorted) {
    for (const r of st.resources ?? []) {
      if (!categoryOf(r.kind)) continue;
      if (r.kind === "bus") {
        if (seenBus.taken) continue;
        seenBus.taken = true;
      }
      i += 1;
      const key = r.name.toLowerCase();
      const prev = prevByKey.get(key);
      const rateMissing =
        r.rate == null || !Number.isFinite(r.rate) || r.rate < 0;
      out.push({
        id: prev?.id ?? `urp-${r.id}`,
        code: prev?.code ?? codeForResource(r, i),
        name: r.name,
        unit: r.unit || (r.kind === "labor" ? "чел" : "ед."),
        quantity: r.quantity,
        // Placeholder 0 only when missing — flagged so totals exclude it.
        rate: rateMissing ? 0 : (r.rate as number),
        rateMissing,
        normId: prev?.normId,
        priceId: prev?.priceId,
      });
    }
  }
  // Drop legacy НР/СП rows — Excel OH/markup live in costSummary slices, not position rows.
  return out;
}

export function applyRollupToCostSummary(
  rollup: ResourceScheduleResult,
  extraIncomplete: string[] = []
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
      hours: roundMoney(rollup.lines.reduce((s, l) => s + l.hours, 0)),
      knownAmount: roundMoney(
        rollup.lines
          .filter((l) => l.incomplete.length === 0)
          .reduce((s, l) => s + l.amount, 0)
      ),
      skipped: extraIncomplete.filter((x) => x.startsWith("duplicate_bus:")),
    },
  };
}

/** Recompute draft calc from linked GPR stages (single source of truth). */
export function syncDraftFromStages(
  calc: Calculation,
  stages: GprStage[]
): {
  calc: Calculation;
  build: UnifiedResourceBuild;
  rollup: ResourceScheduleResult;
} {
  const params = calc.resourceScheduleParams ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
  const build = stagesToResourceLines(stages, params);
  const positions = positionsFromStages(stages, calc.positions);
  const rollup = rollupResourceSchedule({
    params,
    lines: build.lines,
    materialsTotal: build.materialsTotal,
  });
  // materials_external flag is wrong when we supplied materialsTotal from lines
  const incomplete = [
    ...build.incomplete,
    ...build.skipped,
    ...rollup.incomplete.filter((x) => x !== "materials_external_or_missing"),
  ];
  const next: Calculation = {
    ...calc,
    positions,
    resourceScheduleParams: params,
    costSummary: applyRollupToCostSummary(rollup, incomplete),
    dataFlags: [
      ...(calc.dataFlags ?? []).filter(
        (f) => f !== "unified_resource_tree" && f !== "synced_from_gpr_stages"
      ),
      "unified_resource_tree",
      "synced_from_gpr_stages",
    ],
    updatedAt: new Date().toISOString(),
  };
  return { calc: next, build, rollup };
}

export function patchStageResource(
  stages: GprStage[],
  resourceId: string,
  patch: { quantity?: number; rate?: number | null },
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
      };
    });
    return { ...s, resources };
  });
}
