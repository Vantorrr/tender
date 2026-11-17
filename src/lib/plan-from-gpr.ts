/**
 * Allocate contract / stage plan volumes across GPR calendar for period slices.
 * Prefer per-stage planVolume when present; uniform fallback only when no stage volumes.
 */
import type { CalcPosition, GprStage, PlanFactEntry, WorkCalendar } from "@/lib/types";
import { addDaysIso, diffDays } from "@/lib/cost-engine";

export type PlanSliceMode = "day" | "month" | "period" | "cum";

function normalizedLabel(value?: string): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sourceStageMatches(position: CalcPosition, stage: GprStage): boolean {
  const source = normalizedLabel(position.sourceStageName);
  if (!source) return false;
  return [stage.name, stage.workName, ...(stage.workNames ?? [])]
    .map(normalizedLabel)
    .some((label) => label && (label === source || (Math.min(label.length, source.length) >= 32 && (label.startsWith(source) || source.startsWith(label)))));
}

/** Link estimate work rows to their GPR phase and expose them in production plan/fact. */
export function linkEstimateWorksToStages(stages: GprStage[], positions: CalcPosition[]): GprStage[] {
  return stages.map((stage) => {
    const derived = positions
      .filter((position) => position.isWorkItem && sourceStageMatches(position, stage))
      .map((position) => position.name.trim())
      .filter(Boolean);
    if (!derived.length) return stage;
    const names = [...new Set([...(stage.workNames ?? []), ...derived])];
    return { ...stage, workNames: names };
  });
}

/** Physical work plan for production, sourced from quantity-bearing estimate work rows. */
export function productionEntriesFromGpr(stages: GprStage[], positions: CalcPosition[]): PlanFactEntry[] {
  const grouped = new Map<string, { workName: string; unit: string; plan: number }>();
  const represented = new Set<string>();
  for (const position of positions) {
    if (!position.isWorkItem || !Number.isFinite(position.quantity) || position.quantity <= 0 || !position.name.trim() || !position.unit.trim()) continue;
    const stage = stages.find((item) => sourceStageMatches(position, item));
    if (!stage) continue;
    const key = `${position.name.trim().toLocaleLowerCase("ru-RU")}\u0000${position.unit.trim().toLocaleLowerCase("ru-RU")}`;
    const row = grouped.get(key) ?? { workName: position.name.trim(), unit: position.unit.trim(), plan: 0 };
    row.plan += position.quantity;
    grouped.set(key, row);
    represented.add(stage.id);
  }
  // Keep explicit manually entered stage volumes when no estimate work rows were parsed.
  for (const stage of stages) {
    if (represented.has(stage.id) || !Number.isFinite(stage.planVolume) || (stage.planVolume ?? 0) <= 0 || !stage.planUnit?.trim()) continue;
    const linked = stage.workName?.trim() || ((stage.workNames ?? []).length === 1 ? stage.workNames![0].trim() : "") || ((stage.workNames ?? []).length === 0 ? stage.name.trim() : "");
    if (!linked) continue;
    const key = `${linked.toLocaleLowerCase("ru-RU")}\u0000${stage.planUnit.trim().toLocaleLowerCase("ru-RU")}`;
    const row = grouped.get(key) ?? { workName: linked, unit: stage.planUnit.trim(), plan: 0 };
    row.plan += stage.planVolume!;
    grouped.set(key, row);
  }
  return [...grouped.values()].map((row, index) => ({
    id: `pfe-gpr-auto-${index + 1}`,
    workName: row.workName,
    unit: row.unit,
    plan: Math.round(row.plan * 1000) / 1000,
    fact: 0,
    contractRemaining: Math.round(row.plan * 1000) / 1000,
  }));
}

/** Match production work to explicitly linked GPR stages; only a single-work plan may use unlinked stages. */
export function stagesForWork(
  workNames: string[],
  stages: GprStage[],
  workName: string
): GprStage[] {
  const key = workName.trim();
  if (!key) return [];
  const linked = stages.filter((stage) =>
    (stage.workNames?.length ? stage.workNames : [stage.workName])
      .some((name) => name?.trim() === key) ||
    (!stage.workName && !stage.workNames?.length && stage.planVolume != null &&
      Boolean(stage.planUnit?.trim()) && stage.name.trim() === key)
  );
  if (linked.length) return linked;
  const hasMultipleWorks = new Set(workNames.map((name) => name.trim()).filter(Boolean)).size > 1;
  return !hasMultipleWorks && stages.every((stage) => !(stage.workNames?.length || stage.workName?.trim()))
    ? stages
    : [];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

type CalendarWorkdays = Pick<WorkCalendar, "weekendDays">;

function isWorkingDay(day: string, calendar?: CalendarWorkdays): boolean {
  if (!calendar) return true;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return !calendar.weekendDays.includes(weekday);
}

export function stageDayList(st: GprStage, calendar?: CalendarWorkdays): string[] {
  if (!st.start || !st.end) return [];
  const len = Math.max(0, diffDays(st.start, st.end));
  const out: string[] = [];
  for (let i = 0; i <= len; i++) {
    const day = addDaysIso(st.start, i);
    if (isWorkingDay(day, calendar)) out.push(day);
  }
  return out;
}

export function gprCoveredDays(stages: GprStage[], calendar?: CalendarWorkdays): string[] {
  const set = new Set<string>();
  for (const st of stages) {
    for (const d of stageDayList(st, calendar)) set.add(d);
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
  contractPlan: number,
  calendar?: CalendarWorkdays
): Map<string, number> {
  const map = new Map<string, number>();
  const withVol = stagesWithVolumes(stages);
  if (withVol.length > 0) {
    for (const st of withVol) {
      const days = stageDayList(st, calendar);
      if (days.length === 0) continue;
      const per = (st.planVolume as number) / days.length;
      for (const d of days) {
        map.set(d, (map.get(d) ?? 0) + per);
      }
    }
    return map;
  }
  const days = gprCoveredDays(stages, calendar);
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
  asOfDate: string,
  calendar?: CalendarWorkdays
): { plan: number; source: "stage_volumes" | "uniform_fallback" | "none" } {
  const withVol = stagesWithVolumes(stages);
  const hasWorkingDays = gprCoveredDays(stages, calendar).length > 0;
  const source = !hasWorkingDays
    ? "none"
    : withVol.length > 0
      ? "stage_volumes"
      : "uniform_fallback";

  if (source === "none") {
    if (calendar || mode === "day" || mode === "month") return { plan: 0, source };
    return {
      plan: Number.isFinite(contractPlan) ? contractPlan : 0,
      source,
    };
  }

  const daily = dailyPlanMap(stages, contractPlan, calendar);
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
