/**
 * Arithmetic for draft calculations — always in code, never from LLM prose.
 * Uses versioned directory rates + scenario factors; does not invent norms.
 */

import type { CalcPosition, Calculation } from "@/lib/types";

export const SCENARIO_FACTORS: Record<Calculation["scenario"], number> = {
  bazovyy: 1,
  optimisticheskiy: 0.95,
  pessimisticheskiy: 1.08,
};

export function scenarioFactor(scenario: Calculation["scenario"]): number {
  return SCENARIO_FACTORS[scenario] ?? 1;
}

/** Round money to kopecks (2 decimals), half-up via integer cents. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function positionSum(
  position: Pick<CalcPosition, "quantity" | "rate">,
  factor = 1
): number {
  return roundMoney(position.quantity * position.rate * factor);
}

export function worksSubtotal(
  positions: CalcPosition[],
  factor = 1
): number {
  return roundMoney(
    positions
      .filter((p) => p.code !== "НР" && p.code !== "СП")
      .reduce((s, p) => s + p.quantity * p.rate * factor, 0)
  );
}

/** НР 15% / СП 8% of works — same rules as recalcCalculation (kopeck-rounded). */
export function overheadsFromWorks(works: number): {
  nr: number;
  sp: number;
  total: number;
} {
  const nr = roundMoney(works * 0.15);
  const sp = roundMoney(works * 0.08);
  return { nr, sp, total: roundMoney(works + nr + sp) };
}

/**
 * If source text flags VAT-inclusive amount, derive net (не inventing rates).
 * Returns null when VAT not stated or amount missing → caller writes «нет данных».
 */
export function netExcludingVat(
  amount: number | null | undefined,
  vatPercent: number | null | undefined
): number | null {
  if (amount == null || vatPercent == null) return null;
  if (!(vatPercent > 0) || !(amount >= 0)) return null;
  return roundMoney(amount / (1 + vatPercent / 100));
}

/** Detect unit mismatches among non-НР/СП positions (same code, different unit). */
export function unitConflicts(
  positions: CalcPosition[]
): Array<{ code: string; units: string[] }> {
  const byCode = new Map<string, Set<string>>();
  for (const p of positions) {
    if (p.code === "НР" || p.code === "СП") continue;
    const set = byCode.get(p.code) ?? new Set<string>();
    if (p.unit) set.add(p.unit);
    byCode.set(p.code, set);
  }
  return [...byCode.entries()]
    .filter(([, units]) => units.size > 1)
    .map(([code, units]) => ({ code, units: [...units] }));
}

export function calculationTotals(
  calc: Pick<Calculation, "positions" | "scenarioFactor">
): {
  works: number;
  nr: number;
  sp: number;
  total: number;
  factor: number;
} {
  const factor = calc.scenarioFactor || 1;
  const works = worksSubtotal(calc.positions, factor);
  const { nr, sp, total } = overheadsFromWorks(works);
  return { works, nr, sp, total, factor };
}

/**
 * Line amount for UI/export. Work rows take scenario factor;
 * НР/СП are stored already computed from factored works (see recalcCalculation).
 */
export function positionLineSum(
  position: Pick<CalcPosition, "code" | "quantity" | "rate">,
  factor = 1
): number {
  if (position.code === "НР" || position.code === "СП") {
    return roundMoney(position.quantity * position.rate);
  }
  return positionSum(position, factor);
}

/** Detect duplicate position codes (excluding НР/СП). */
export function duplicateCodes(positions: CalcPosition[]): string[] {
  const seen = new Map<string, number>();
  for (const p of positions) {
    if (p.code === "НР" || p.code === "СП") continue;
    seen.set(p.code, (seen.get(p.code) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([code]) => code);
}

/**
 * Parse RU/EN decimal strings with spaces as thousands separators.
 * Returns null when empty/unparseable — caller must treat as «нет данных».
 */
export function parseDecimal(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const cleaned = text.replace(/\s/g, "").replace(",", ".");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
