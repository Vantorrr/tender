/**
 * Plan/fact aggregation — daily records are the source of truth for physical fact.
 */
import type { DailyFact, PlanFact, PlanFactEntry } from "@/lib/types";

export function sumDailyQty(
  daily: DailyFact[] | undefined,
  opts?: { workName?: string; date?: string; monthPrefix?: string }
): number {
  const list = daily ?? [];
  return list.reduce((s, d) => {
    if (opts?.workName && d.workName !== opts.workName) return s;
    if (opts?.date && d.date !== opts.date) return s;
    if (opts?.monthPrefix && !d.date.startsWith(opts.monthPrefix)) return s;
    return s + d.quantity;
  }, 0);
}

/**
 * Recompute entry.fact / contractRemaining from dailyFacts (mutates planFact).
 * Daily ledger is source of truth for a workName once any daily row exists for it;
 * otherwise the stored entry.fact (opening / seed) is kept.
 */
export function recomputeEntriesFromDaily(pf: PlanFact): PlanFact {
  const daily = pf.dailyFacts ?? [];
  const namesFromDaily = new Set(daily.map((d) => d.workName));
  pf.entries = (pf.entries ?? []).map((e) => {
    if (!namesFromDaily.has(e.workName)) {
      return {
        ...e,
        contractRemaining: Math.max(0, e.plan - e.fact),
      };
    }
    const fact =
      Math.round(sumDailyQty(daily, { workName: e.workName }) * 1000) / 1000;
    return {
      ...e,
      fact,
      contractRemaining: Math.max(0, e.plan - fact),
    };
  });
  // Ensure every daily workName has a table row
  for (const name of namesFromDaily) {
    if (pf.entries.some((e) => e.workName === name)) continue;
    const sample = daily.find((d) => d.workName === name)!;
    const fact =
      Math.round(sumDailyQty(daily, { workName: name }) * 1000) / 1000;
    pf.entries.push({
      id: `pfe-auto-${name.slice(0, 12)}-${Date.now()}`,
      workName: name,
      unit: sample.unit || "ед",
      plan: 0,
      fact,
      contractRemaining: 0,
    });
  }
  return pf;
}

export function entryDisplayFact(
  e: PlanFactEntry,
  daily: DailyFact[] | undefined
): number {
  const list = daily ?? [];
  if (list.some((d) => d.workName === e.workName)) {
    return Math.round(sumDailyQty(list, { workName: e.workName }) * 1000) / 1000;
  }
  return e.fact;
}

export function entryDisplayRemain(
  e: PlanFactEntry,
  daily: DailyFact[] | undefined
): number {
  return Math.max(0, e.plan - entryDisplayFact(e, daily));
}
