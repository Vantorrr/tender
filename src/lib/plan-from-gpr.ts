/**
 * Allocate contract / stage plan volumes across GPR calendar for period slices.
 * Prefer per-stage planVolume when present; uniform fallback only when no stage volumes.
 */
import type { GprStage } from "@/lib/types";
import { addDaysIso, diffDays } from "@/lib/cost-engine";

export type PlanSliceMode = "day" | "month" | "period" | "cum";

/** Match production work to explicitly linked GPR stages; only a single-work plan may use unlinked stages. */
export function stagesForWork(
  workNames: string[],
  stages: GprStage[],
  workName: string
): GprStage[] {
  const key = workName.trim();
  if (!key) return [];
  const linked = stages.filter((stage) => stage.workName?.trim() === key);
  if (linked.length) return linked;
  const hasMultipleWorks = new Set(workNames.map((name) => name.trim()).filter(Boolean)).size > 1;
  return !hasMultipleWorks && stages.every((stage) => !stage.workName?.trim())
    ? stages
    : [];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function stageDayList(st: GprStage): string[] {
  if (!st.start || !st.end) return [];
  const len = Math.max(0, diffDays(st.start, st.end));
  const out: string[] = [];
  for (let i = 0; i <= len; i++) out.push(addDaysIso(st.start, i));
  return out;
}

export function gprCoveredDays(stages: GprStage[]): string[] {
  const set = new Set<string>();
  for (const st of stages) {
    for (const d of stageDayList(st)) set.add(d);
  }
  return [...set].sort();
}

/** Stages that have an explicit confirmed plan volume (>0). */
export function stagesWithVolumes(stages: GprStage[]): GprStage[] {
  return stages.filter(
    (s) => s.planVolume != null && Number.isFinite(s.planVolume) && s.planVolume > 0
  );
}

/**
 * Build per-day plan contribution from stages.
 * If any stage has planVolume — distribute each stage's volume over its own days.
 * Else distribute contractPlan uniformly over all covered days (fallback).
 */
export function dailyPlanMap(
  stages: GprStage[],
  contractPlan: number
): Map<string, number> {
  const map = new Map<string, number>();
  const withVol = stagesWithVolumes(stages);
  if (withVol.length > 0) {
    for (const st of withVol) {
      const days = stageDayList(st);
      if (days.length === 0) continue;
      const per = (st.planVolume as number) / days.length;
      for (const d of days) {
        map.set(d, (map.get(d) ?? 0) + per);
      }
    }
    return map;
  }
  const days = gprCoveredDays(stages);
  if (days.length === 0 || !Number.isFinite(contractPlan) || contractPlan === 0) {
    return map;
  }
  const per = contractPlan / days.length;
  for (const d of days) map.set(d, per);
  return map;
}

export function allocatePlanForSlice(
  contractPlan: number,
  stages: GprStage[],
  mode: PlanSliceMode,
  asOfDate: string
): { plan: number; source: "stage_volumes" | "uniform_fallback" | "none" } {
  const withVol = stagesWithVolumes(stages);
  const source =
    withVol.length > 0
      ? "stage_volumes"
      : gprCoveredDays(stages).length > 0
        ? "uniform_fallback"
        : "none";

  if (source === "none") {
    if (mode === "day" || mode === "month") return { plan: 0, source };
    return {
      plan: Number.isFinite(contractPlan) ? contractPlan : 0,
      source,
    };
  }

  const daily = dailyPlanMap(stages, contractPlan);
  const sumDays = (pred: (d: string) => boolean) => {
    let s = 0;
    for (const [d, v] of daily) {
      if (pred(d)) s += v;
    }
    return round(s);
  };

  if (mode === "day") {
    return { plan: round(daily.get(asOfDate) ?? 0), source };
  }
  if (mode === "month") {
    const prefix = asOfDate.slice(0, 7);
    return { plan: sumDays((d) => d.startsWith(prefix)), source };
  }
  if (mode === "period") {
    return { plan: sumDays(() => true), source };
  }
  // cum through asOfDate
  return { plan: sumDays((d) => d <= asOfDate), source };
}

export function totalStageCalendarDays(stages: GprStage[]): number {
  return stages.reduce(
    (s, st) => s + Math.max(1, diffDays(st.start, st.end) + 1),
    0
  );
}
