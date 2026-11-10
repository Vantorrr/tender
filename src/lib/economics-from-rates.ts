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
  /** Estimated value of fact from immutable customer estimate, not recognized revenue. */
  customerEstimateValue: number | null;
  /** Estimated value of remaining plan from immutable customer estimate. */
  customerEstimateRemainingValue: number | null;
  customerEstimateIncomplete: string[];
  incomplete: string[];
  lines: Array<{
    workName: string;
    quantity: number;
    rate: number | null;
    amount: number | null;
    customerEstimateRate: number | null;
    customerEstimateAmount: number | null;
    customerEstimateRemainingAmount: number | null;
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
      normalized(position.unit) === normalizedUnit &&
      !position.rateMissing
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
  customerEstimatePositions?: CalcPosition[] | null;
  directories: DirectoryVersion[];
}): EconomicsResult {
  const incomplete: string[] = [];
  const customerEstimateIncomplete: string[] = [];
  const lines: EconomicsResult["lines"] = [];
  let autoIncurred = 0;
  let physicalIndex = 0;
  let customerEstimateValue = 0;
  let customerEstimateRemainingValue = 0;
  const hasCustomerEstimate = Boolean(opts.customerEstimatePositions?.length);

  for (const e of opts.entries) {
    const workDaily = (opts.daily ?? []).filter((d) => d.workName === e.workName);
    const fromDaily = workDaily
      .reduce((s, d) => s + d.quantity, 0);
    const qty =
      (opts.daily ?? []).some((d) => d.workName === e.workName)
        ? fromDaily
        : e.fact;
    physicalIndex += qty;
    const hasResourceFacts = workDaily.some((d) => (d.resourceLines?.length ?? 0) > 0);
    let rate = rateForWork(e.workName, e.unit, opts.positions, opts.directories);
    let amount: number | null = null;
    if (hasResourceFacts) {
      // Resource actuals are counted only when every daily entry has complete,
      // stable GPR links and a confirmed draft rate. Never mix them with a
      // work-unit rate: that could double-count labor/materials.
      let resourceAmount = 0;
      let resourceFactsComplete = workDaily.length > 0;
      for (const day of workDaily) {
        const lines = day.resourceLines ?? [];
        if (!lines.length) {
          resourceFactsComplete = false;
          break;
        }
        for (const line of lines) {
          const position = line.sourceResourceId
            ? opts.positions.find((p) => p.sourceResourceId === line.sourceResourceId)
            : undefined;
          if (
            line.factQty == null ||
            !Number.isFinite(line.factQty) ||
            line.factQty < 0 ||
            !position ||
            position.rateMissing ||
            !Number.isFinite(position.rate) ||
            position.rate <= 0
          ) {
            resourceFactsComplete = false;
            continue;
          }
          resourceAmount += line.factQty * position.rate;
        }
      }
      if (resourceFactsComplete) {
        amount = Math.round(resourceAmount * 100) / 100;
        rate = null; // Rate is represented by the linked resource lines.
      } else {
        incomplete.push(`resource_facts:${e.workName}`);
        rate = null;
      }
    }
    const customerEstimateRate = hasCustomerEstimate
      ? rateForWork(e.workName, e.unit, opts.customerEstimatePositions!, [])
      : null;
    const remainingQty = Math.max(0, e.plan - qty);
    const customerEstimateAmount = customerEstimateRate == null
      ? null
      : Math.round(qty * customerEstimateRate * 100) / 100;
    const customerEstimateRemainingAmount = customerEstimateRate == null
      ? null
      : Math.round(remainingQty * customerEstimateRate * 100) / 100;
    if (hasCustomerEstimate) {
      if (customerEstimateRate == null) {
        if (qty > 0 || remainingQty > 0) customerEstimateIncomplete.push(`customer_rate:${e.workName}`);
      } else {
        customerEstimateValue += customerEstimateAmount ?? 0;
        customerEstimateRemainingValue += customerEstimateRemainingAmount ?? 0;
      }
    }
    if (rate == null && amount == null) {
      if (qty > 0 && !hasResourceFacts) incomplete.push(`rate:${e.workName}`);
      lines.push({
        workName: e.workName,
        quantity: qty,
        rate: null,
        amount: null,
        customerEstimateRate,
        customerEstimateAmount,
        customerEstimateRemainingAmount,
      });
    } else {
      const resolvedAmount = amount ?? Math.round(qty * rate! * 100) / 100;
      autoIncurred += resolvedAmount;
      lines.push({
        workName: e.workName,
        quantity: qty,
        rate,
        amount: resolvedAmount,
        customerEstimateRate,
        customerEstimateAmount,
        customerEstimateRemainingAmount,
      });
    }
  }

  if (!hasCustomerEstimate) customerEstimateIncomplete.push("customer_estimate_missing");
  const customerEstimateComplete = hasCustomerEstimate && customerEstimateIncomplete.length === 0;

  return {
    autoIncurred: Math.round(autoIncurred * 100) / 100,
    physicalIndex: Math.round(physicalIndex * 1000) / 1000,
    customerEstimateValue: customerEstimateComplete ? Math.round(customerEstimateValue * 100) / 100 : null,
    customerEstimateRemainingValue: customerEstimateComplete ? Math.round(customerEstimateRemainingValue * 100) / 100 : null,
    customerEstimateIncomplete,
    incomplete,
    lines,
  };
}
