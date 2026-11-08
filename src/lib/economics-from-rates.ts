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
  const pos = positions.find(
    (p) =>
      p.name === workName ||
      p.name.includes(workName) ||
      workName.includes(p.name)
  );
  if (pos && Number.isFinite(pos.rate) && pos.rate > 0) return pos.rate;

  const rasc = directories.find((d) => d.type === "rascenki" && d.current);
  if (rasc) {
    for (const row of rasc.rows) {
      const name = String(row.work ?? row.name ?? "");
      if (!name) continue;
      if (name === workName || name.includes(workName) || workName.includes(name)) {
        const rate = Number(row.rate ?? row.price ?? 0);
        if (Number.isFinite(rate) && rate > 0) return rate;
      }
    }
  }
  const ceny = directories.find((d) => d.type === "ceny" && d.current);
  if (ceny && /матер|м²|м2|т\b/i.test(unit + workName)) {
    for (const row of ceny.rows) {
      const name = String(row.name ?? "");
      if (name && (name.includes(workName) || workName.includes(name))) {
        const rate = Number(row.price ?? row.rate_1s_kpi10 ?? 0);
        if (Number.isFinite(rate) && rate > 0) return rate;
      }
    }
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
