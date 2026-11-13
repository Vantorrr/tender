import type { DailyFact, PlanFactEntry } from "@/lib/types";

export interface WorkForecast {
  status: "insufficient_data" | "complete" | "forecast";
  observedDays: number;
  averagePerWorkday: number | null;
  projectedFinish: string | null;
  plannedFinish: string | null;
  varianceWorkdays: number | null;
}

function isoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWorkday(date: Date, weekendDays: Set<number>): boolean {
  return !weekendDays.has(date.getUTCDay());
}

function workdaysBetween(start: Date, end: Date, weekendDays: Set<number>): number {
  if (start.getTime() === end.getTime()) return 0;
  const direction = start < end ? 1 : -1;
  const cursor = new Date(start);
  let count = 0;
  while (cursor.getTime() !== end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + direction);
    if (isWorkday(cursor, weekendDays)) count += direction;
  }
  return count;
}

function addWorkdays(start: Date, count: number, weekendDays: Set<number>): Date {
  const cursor = new Date(start);
  let added = 0;
  while (added < count) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWorkday(cursor, weekendDays)) added += 1;
  }
  return cursor;
}

/**
 * Pace-based completion estimate. It is deliberately withheld until there are
 * three distinct report dates and is an operational estimate, not a promise.
 */
export function forecastWorkCompletion(input: {
  entry: PlanFactEntry;
  dailyFacts: DailyFact[];
  asOfDate: string;
  plannedFinish?: string;
  weekendDays?: number[];
}): WorkForecast {
  const weekendDays = new Set(input.weekendDays ?? [0, 6]);
  const asOf = isoDate(input.asOfDate);
  const plannedFinish = input.plannedFinish && isoDate(input.plannedFinish)
    ? input.plannedFinish
    : null;
  const facts = input.dailyFacts.filter((fact) =>
    fact.workName === input.entry.workName &&
    fact.unit === input.entry.unit &&
    fact.quantity > 0 &&
    isoDate(fact.date) !== null &&
    fact.date <= input.asOfDate
  );
  const observedDays = new Set(facts.map((fact) => fact.date)).size;
  const remaining = Math.max(0, input.entry.plan - facts.reduce((sum, fact) => sum + fact.quantity, 0));
  if (remaining === 0 && observedDays > 0) {
    return { status: "complete", observedDays, averagePerWorkday: null, projectedFinish: input.asOfDate, plannedFinish, varianceWorkdays: plannedFinish && asOf ? workdaysBetween(isoDate(plannedFinish)!, asOf, weekendDays) : null };
  }
  if (!asOf || observedDays < 3 || remaining <= 0) {
    return { status: "insufficient_data", observedDays, averagePerWorkday: null, projectedFinish: null, plannedFinish, varianceWorkdays: null };
  }
  const firstFact = facts.map((fact) => isoDate(fact.date)!).sort((a, b) => a.getTime() - b.getTime())[0];
  const elapsedWorkdays = workdaysBetween(firstFact, asOf, weekendDays) + (isWorkday(firstFact, weekendDays) ? 1 : 0);
  if (elapsedWorkdays <= 0) {
    return { status: "insufficient_data", observedDays, averagePerWorkday: null, projectedFinish: null, plannedFinish, varianceWorkdays: null };
  }
  const completed = facts.reduce((sum, fact) => sum + fact.quantity, 0);
  const averagePerWorkday = completed / elapsedWorkdays;
  if (!Number.isFinite(averagePerWorkday) || averagePerWorkday <= 0) {
    return { status: "insufficient_data", observedDays, averagePerWorkday: null, projectedFinish: null, plannedFinish, varianceWorkdays: null };
  }
  const projected = addWorkdays(asOf, Math.ceil(remaining / averagePerWorkday), weekendDays);
  return {
    status: "forecast",
    observedDays,
    averagePerWorkday,
    projectedFinish: dateKey(projected),
    plannedFinish,
    varianceWorkdays: plannedFinish ? workdaysBetween(isoDate(plannedFinish)!, projected, weekendDays) : null,
  };
}
