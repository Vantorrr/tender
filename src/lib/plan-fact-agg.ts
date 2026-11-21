/**
 * Plan/fact aggregation — daily records are the source of truth for physical fact.
 */
import type { DailyFact, PlanFact, PlanFactEntry } from "@/lib/types";

export function activeDailyFacts(daily: DailyFact[] | undefined): DailyFact[] {
  return (daily ?? []).filter((fact) => !fact.archived);
}

export function sumDailyQty(
  daily: DailyFact[] | undefined,
  opts?: { workName?: string; unit?: string; date?: string; monthPrefix?: string }
): number {
  const list = activeDailyFacts(daily);
  return list.reduce((s, d) => {
    if (opts?.workName && d.workName !== opts.workName) return s;
    if (opts?.unit && d.unit !== opts.unit) return s;
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
  const daily = activeDailyFacts(pf.dailyFacts);
  const workKeysFromDaily = new Set(daily.map((d) => `${d.workName}\u0000${d.unit}`));
  pf.entries = (pf.entries ?? []).map((e) => {
    const key = `${e.workName}\u0000${e.unit}`;
    if (!workKeysFromDaily.has(key)) {
      return {
        ...e,
        contractRemaining: Math.max(0, e.plan - e.fact),
      };
    }
    const fact =
      Math.round(sumDailyQty(daily, { workName: e.workName, unit: e.unit }) * 1000) / 1000;
    return {
      ...e,
      fact,
      contractRemaining: Math.max(0, e.plan - fact),
    };
  });
  // Ensure every daily workName has a table row
  for (const key of workKeysFromDaily) {
    const [name, unit] = key.split("\u0000");
    if (pf.entries.some((e) => e.workName === name && e.unit === unit)) continue;
    const sample = daily.find((d) => d.workName === name && d.unit === unit)!;
    const fact =
      Math.round(sumDailyQty(daily, { workName: name, unit }) * 1000) / 1000;
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
  const list = activeDailyFacts(daily);
  const linked = e.id ? list.filter((fact) => fact.entryId === e.id) : [];
  if (linked.length) {
    return Math.round(linked.reduce((sum, fact) => sum + fact.quantity, 0) * 1000) / 1000;
  }
  const legacy = list.filter((fact) => !fact.entryId && fact.workName === e.workName && fact.unit === e.unit);
  if (legacy.length) {
    return Math.round(sumDailyQty(legacy, { workName: e.workName, unit: e.unit }) * 1000) / 1000;
  }
  return e.fact;
}

export function entryDisplayRemain(
  e: PlanFactEntry,
  daily: DailyFact[] | undefined
): number {
  return Math.max(0, e.plan - entryDisplayFact(e, daily));
}
