/**
 * Per-stage resource rollup for Gantt left pane (люди / техника / стоимость).
 * Cost uses the shared hour formula (Q=L×N×O×P, R=Q×M) — never qty×rate alone.
 */
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  type ResourceScheduleParams,
} from "@/lib/resource-schedule-model";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import type { GprStage, GprStageResource } from "@/lib/types";

export type StageResourceLineCost = {
  resourceId: string;
  kind: GprStageResource["kind"];
  name: string;
  amount: number | null;
  incomplete: string[];
};

export type StageResourceSummary = {
  labor: number;
  equipment: number;
  cost: number | null;
  incomplete: boolean;
  /** Short RU reason when incomplete (e.g. missing tariff). */
  incompleteHint: string | null;
  /** Priced lines that contributed to cost (null amount = skipped). */
  lines: StageResourceLineCost[];
  /** Sum of bus line amounts only (null if no priced bus). */
  busCost: number | null;
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
    return {
      labor,
      equipment,
      cost: null,
      incomplete: false,
      incompleteHint: null,
      lines: [],
      busCost: null,
    };
  }

  const lines: StageResourceLineCost[] = [];
  let cost = 0;
  let incomplete = false;
  let anyAmount = false;
  let missingTariff = false;
  let busCost = 0;
  let anyBus = false;

  for (const r of resources) {
    const dim = resolveResourceDimensions(r, stage, params);
    const line: StageResourceLineCost = {
      resourceId: r.id,
      kind: r.kind,
      name: r.name,
      amount: dim.amount,
      incomplete: dim.incomplete,
    };
    lines.push(line);
    if (dim.incomplete.length > 0 || dim.amount == null) {
      incomplete = true;
      if (dim.incomplete.some((x) => x.startsWith("missing_tariff:"))) {
        missingTariff = true;
      }
      continue;
    }
    cost += dim.amount;
    anyAmount = true;
    if (r.kind === "bus") {
      busCost += dim.amount;
      anyBus = true;
    }
  }

  const incompleteHint = incomplete
    ? missingTariff
      ? "нет тарифа"
      : "неполные данные"
    : null;

  if (!anyAmount) {
    return {
      labor,
      equipment,
      cost: null,
      incomplete: true,
      incompleteHint,
      lines,
      busCost: anyBus ? busCost : null,
    };
  }
  return {
    labor,
    equipment,
    cost,
    incomplete,
    incompleteHint,
    lines,
    busCost: anyBus ? busCost : null,
  };
}
