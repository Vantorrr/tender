/**
 * Allocate contract plan volume across GPR calendar days for period slices.
 * Does not invent progress curves — uniform per calendar day covered by any stage.
 */
import type { GprStage } from "@/lib/types";
import { addDaysIso, diffDays } from "@/lib/cost-engine";

export type PlanSliceMode = "day" | "month" | "period" | "cum";

export function gprCoveredDays(stages: GprStage[]): string[] {
  const set = new Set<string>();
  for (const st of stages) {
    if (!st.start || !st.end) continue;
    const len = Math.max(0, diffDays(st.start, st.end));
    for (let i = 0; i <= len; i++) {
      set.add(addDaysIso(st.start, i));
    }
  }
  return [...set].sort();
}

export function allocatePlanForSlice(
  contractPlan: number,
  stages: GprStage[],
  mode: PlanSliceMode,
  asOfDate: string
): number {
  const days = gprCoveredDays(stages);
  if (!Number.isFinite(contractPlan) || contractPlan === 0) return 0;
  if (days.length === 0) {
    // No GPR calendar — fall back to full contract for period/cum only
    return mode === "day" || mode === "month" ? 0 : contractPlan;
  }
  const perDay = contractPlan / days.length;
  const round = (n: number) => Math.round(n * 1000) / 1000;

  if (mode === "day") {
    return days.includes(asOfDate) ? round(perDay) : 0;
  }
  if (mode === "month") {
    const prefix = asOfDate.slice(0, 7);
    const n = days.filter((d) => d.startsWith(prefix)).length;
    return round(perDay * n);
  }
  if (mode === "period") {
    return round(contractPlan);
  }
  // cum: plan accumulated through asOfDate along GPR calendar
  const n = days.filter((d) => d <= asOfDate).length;
  return round(perDay * n);
}

export function totalStageCalendarDays(stages: GprStage[]): number {
  return stages.reduce(
    (s, st) => s + Math.max(1, diffDays(st.start, st.end)),
    0
  );
}
