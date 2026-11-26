/**
 * Official commercial price for a new tender draft.
 * Overhead and profit stay on C0. Contingency is added after that markup,
 * so the default price is C0 × 1.50, not C0 × 1.54.
 * The reference reprice does not call this.
 */
import { roundMoney } from "@/lib/calc-math";

/** 10% of direct costs plus overhead. Not a Document 1 reserve. */
export const DEFAULT_CONTINGENCY_RATE = 0.1;

export type EconomicsLineKey = "overhead" | "reserve" | "profit";
export type EconomicsLineMode = "rate" | "amount";

export interface EconomicsLineOverride {
  mode: EconomicsLineMode;
  /** Fraction (0.43) or rubles, depending on mode. */
  value: number;
}

export interface EconomicsManual {
  overhead?: EconomicsLineOverride;
  reserve?: EconomicsLineOverride;
  profit?: EconomicsLineOverride;
}

export function sanitizeEconomicsOverride(
  value: EconomicsLineOverride | null | undefined,
): EconomicsLineOverride | null | undefined {
  if (value == null) return value;
  if (value.mode !== "rate" && value.mode !== "amount") return undefined;
  if (!Number.isFinite(value.value) || value.value < 0) return undefined;
  return {
    mode: value.mode,
    value: value.mode === "amount" ? roundMoney(value.value) : value.value,
  };
}

/**
 * Post-step on an official resource-schedule total.
 * C0 and profit coming in are the formula result (markup base excludes reserve).
 * A manual line replaces that result and is listed in manualLines.
 */
export function applyClientCommercialFormula(input: {
  C0: number;
  profit: number;
  direct: number | null;
  overhead: number | null;
  formulaProfitRate: number;
  vatPercent: number | null;
  manual?: EconomicsManual | null;
}): {
  C0: number;
  direct: number | null;
  overhead: number | null;
  reserve: number;
  C: number;
  profit: number;
  priceExVat: number;
  vatAmount: number | null;
  priceIncVat: number | null;
  manualLines: EconomicsLineKey[];
} {
  const manual = input.manual ?? {};
  const manualLines: EconomicsLineKey[] = [];
  let C0 = roundMoney(input.C0);
  let overhead = input.overhead == null ? null : roundMoney(input.overhead);
  const direct = input.direct == null ? null : roundMoney(input.direct);

  if (manual.overhead && overhead != null) {
    const next = manual.overhead.mode === "amount"
      ? roundMoney(Math.max(0, manual.overhead.value))
      : direct == null
        ? null
        : roundMoney(Math.max(0, direct * manual.overhead.value));
    if (next != null) {
      C0 = roundMoney(C0 + roundMoney(next - overhead));
      overhead = next;
      manualLines.push("overhead");
    }
  }

  let profit = roundMoney(input.profit);
  if (manual.profit?.mode === "amount") {
    profit = roundMoney(Math.max(0, manual.profit.value));
    manualLines.push("profit");
  } else if (manual.profit?.mode === "rate") {
    profit = roundMoney(Math.max(0, C0 * manual.profit.value));
    manualLines.push("profit");
  } else if (manualLines.includes("overhead")) {
    profit = roundMoney(Math.max(0, C0 * input.formulaProfitRate));
  }

  let reserve: number;
  if (manual.reserve?.mode === "amount") {
    reserve = roundMoney(Math.max(0, manual.reserve.value));
    manualLines.push("reserve");
  } else if (manual.reserve?.mode === "rate") {
    reserve = roundMoney(Math.max(0, C0 * manual.reserve.value));
    manualLines.push("reserve");
  } else {
    reserve = roundMoney(Math.max(0, C0 * DEFAULT_CONTINGENCY_RATE));
  }

  const C = roundMoney(C0 + reserve);
  const priceExVat = roundMoney(C + profit);
  const vatAmount = input.vatPercent == null
    ? null
    : roundMoney(priceExVat * (input.vatPercent / 100));
  const priceIncVat = vatAmount == null ? null : roundMoney(priceExVat + vatAmount);
  return {
    C0,
    direct,
    overhead,
    reserve,
    C,
    profit,
    priceExVat,
    vatAmount,
    priceIncVat,
    manualLines,
  };
}
