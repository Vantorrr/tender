import type { GprStage } from "@/lib/types";

/**
 * The chart reports which rows are visible and in what order.
 * Dates and dependencies always come from the live schedule, so a shift
 * updates the table even when the set of ids did not change.
 */
export function linkedWorkRows(stages: GprStage[], visibleIds: string[] | null): GprStage[] {
  if (!visibleIds) return [...stages].sort((left, right) => left.sequence - right.sequence);
  const live = new Map(stages.map((stage) => [stage.id, stage]));
  return visibleIds.flatMap((id) => {
    const stage = live.get(id);
    return stage ? [stage] : [];
  });
}
