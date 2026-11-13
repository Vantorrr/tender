/**
 * Per-stage resource rollup for Gantt left pane (люди / техника / стоимость).
 * Cost uses the shared hour formula (Q=L×N×O×P, R=Q×M) — never qty×rate alone.
 */
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  type ResourceScheduleParams,
} from "@/lib/resource-schedule-model";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import type { GprStage } from "@/lib/types";

export type StageResourceSummary = {
  labor: number;
  equipment: number;
  cost: number | null;
  incomplete: boolean;
};

export function stageResourceSummary(
  stage: GprStage,
  params: ResourceScheduleParams = EXCEL_RESOURCE_SCHEDULE_DEFAULTS
): StageResourceSummary {
  const resources = stage.resources ?? [];
  const labor = resources
    .filter((r) => r.kind === "labor")
    .reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
  const equipment = resources
    .filter((r) => r.kind === "equipment" || r.kind === "bus")
    .reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);

  if (resources.length === 0) {
    return { labor, equipment, cost: null, incomplete: false };
  }

  let cost = 0;
  let incomplete = false;
  let anyAmount = false;
  for (const r of resources) {
    const dim = resolveResourceDimensions(r, stage, params);
    if (dim.incomplete.length > 0 || dim.amount == null) {
      incomplete = true;
      continue;
    }
    cost += dim.amount;
    anyAmount = true;
  }

  if (!anyAmount) {
    return { labor, equipment, cost: null, incomplete: true };
  }
  return { labor, equipment, cost, incomplete };
}
