/**
 * Economics from physical volumes × confirmed rates only.
 * Never invents rates; missing rate → incomplete, not 0 ₽ revenue/cost.
 */
import type {
  CalcPosition,
  DailyFact,
  DirectoryVersion,
  PlanFactEntry,
} from "@/lib/types";

export type EconomicsResult = {
  /** Sum of qty×rate where rate confirmed. */
  autoIncurred: number;
  /** Physical quantity index (not money). */
  physicalIndex: number;
  incomplete: string[];
  lines: Array<{
    workName: string;
    quantity: number;
    rate: number | null;
    amount: number | null;
  }>;
};

function rateForWork(
  workName: string,
  unit: string,
  positions: CalcPosition[],
  directories: DirectoryVersion[]
): number | null {
  const normalized = (text: string) =>
    text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
  const normalizedName = normalized(workName);
  const normalizedUnit = normalized(unit);
  const resolveUniqueRate = (rates: number[]) => {
    const confirmed = [...new Set(rates.filter((rate) => Number.isFinite(rate) && rate > 0))];
    return confirmed.length === 1 ? confirmed[0] : null;
  };

  // A substring can match an unrelated estimate line (for example, "Монтаж"
  // may occur in several scopes). Only apply a rate when both work and unit
  // identify one unambiguous value; otherwise keep the money figure incomplete.
  const positionRates = positions
    .filter((position) =>
      normalized(position.name) === normalizedName &&
      normalized(position.unit) === normalizedUnit
    )
    .map((position) => position.rate);
  const distinctPositionRates = [...new Set(positionRates.filter((rate) => Number.isFinite(rate) && rate > 0))];
  if (distinctPositionRates.length > 1) return null;
  const positionRate = resolveUniqueRate(positionRates);
  if (positionRate != null) return positionRate;

  const rasc = directories.find((d) => d.type === "rascenki" && d.current);
  if (rasc) {
    const rates: number[] = [];
    for (const row of rasc.rows) {
      const name = String(row.work ?? row.name ?? "");
      const rowUnit = String(row.unit ?? row.ed ?? "");
      if (!name || normalized(name) !== normalizedName) continue;
      if (rowUnit && normalized(rowUnit) !== normalizedUnit) continue;
      rates.push(Number(row.rate ?? row.price ?? 0));
    }
    const rate = resolveUniqueRate(rates);
    if (rate != null) return rate;
  }
  const ceny = directories.find((d) => d.type === "ceny" && d.current);
  if (ceny && /матер|м²|м2|т\b/i.test(unit + workName)) {
    const rates: number[] = [];
    for (const row of ceny.rows) {
      const name = String(row.name ?? "");
      const rowUnit = String(row.unit ?? row.ed ?? "");
      if (!name || normalized(name) !== normalizedName) continue;
      if (rowUnit && normalized(rowUnit) !== normalizedUnit) continue;
      rates.push(Number(row.price ?? row.rate_1s_kpi10 ?? 0));
    }
    const rate = resolveUniqueRate(rates);
    if (rate != null) return rate;
  }
  return null;
}

/** Aggregate daily facts (or entry facts) × confirmed rates. */
export function economicsFromVolumes(opts: {
  entries: PlanFactEntry[];
  daily?: DailyFact[];
  positions: CalcPosition[];
  directories: DirectoryVersion[];
}): EconomicsResult {
  const incomplete: string[] = [];
  const lines: EconomicsResult["lines"] = [];
  let autoIncurred = 0;
  let physicalIndex = 0;

  for (const e of opts.entries) {
    const fromDaily = (opts.daily ?? [])
      .filter((d) => d.workName === e.workName)
      .reduce((s, d) => s + d.quantity, 0);
    const qty =
      (opts.daily ?? []).some((d) => d.workName === e.workName)
        ? fromDaily
        : e.fact;
    physicalIndex += qty;
    const rate = rateForWork(e.workName, e.unit, opts.positions, opts.directories);
    if (rate == null) {
      if (qty > 0) incomplete.push(`rate:${e.workName}`);
      lines.push({ workName: e.workName, quantity: qty, rate: null, amount: null });
    } else {
      const amount = Math.round(qty * rate * 100) / 100;
      autoIncurred += amount;
      lines.push({ workName: e.workName, quantity: qty, rate, amount });
    }
  }

  return {
    autoIncurred: Math.round(autoIncurred * 100) / 100,
    physicalIndex: Math.round(physicalIndex * 1000) / 1000,
    incomplete,
    lines,
  };
}
