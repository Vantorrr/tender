/**
 * Wave 5 of the confirmed client rules.
 * Quotes stay a manual choice. The average is a hint, never an automatic pick.
 * A director decision is stored as a decision, not as an automatic refusal.
 * Cash-flow stays empty until the finance rules arrive.
 */
import { roundMoney } from "@/lib/calc-math";
import { formatMoney } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/roles";
import type { CalcPosition, Calculation, Role, SupplierQuote, SupplyRequest, User } from "@/lib/types";

/** A unit rate above this is rejected. It is not a plausible line rate. */
export const MAX_QUOTE_UNIT_PRICE = 1_000_000_000;

export const BDDS_WAITING_STATUS =
  "БДДС пока не рассчитывается — ждём правила распределения платежей и авансов от Андрея / финансового блока";

export type DirectorDecisionChoice = "participate" | "revise_markup" | "decline";

export const DIRECTOR_DECISION_OPTIONS: Array<{ id: DirectorDecisionChoice; label: string }> = [
  { id: "participate", label: "Участвовать по решению директора" },
  { id: "revise_markup", label: "Снизить/пересмотреть наценку или объёмы" },
  { id: "decline", label: "Не участвовать — решение директора" },
];

export interface QuoteHint {
  count: number;
  average: number | null;
  min: number | null;
  max: number | null;
  /** Always names the figure as a hint. Never a selected quote. */
  label: string;
  spreadLabel: string | null;
}

export interface PositionQuoteOffer {
  quoteId: string;
  supplyId: string;
  supplierName: string;
  unitPrice: number;
  materialName: string;
  unit: string;
}

export interface CostDriver {
  id: string;
  name: string;
  amount: number;
  kind: "line" | "package";
}

export interface NmckCostGap {
  triggered: boolean;
  nmck: number | null;
  direct: number | null;
  overhead: number | null;
  contingency: number | null;
  fullCost: number | null;
  officialPrice: number | null;
  deficitRub: number | null;
  deficitPercentOfNmck: number | null;
  topDrivers: CostDriver[];
  headline: string;
}

export interface BddsFrame {
  status: "waiting_rules";
  statusText: string;
  readyInputs: string[];
  missingRules: string[];
  /** No cash-gap figure is invented. */
  cashGaps: null;
  /** No advance or payment schedule is invented. */
  paymentSchedule: null;
  figures: null;
}

export interface ResolvedOwner {
  userId: string;
  role: Role;
  name: string;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

export function quoteTerm(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/^возврат:\s*/iu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function quoteMatchKey(name: string, unit: string): string {
  return `${quoteTerm(name)}|${quoteTerm(unit)}`;
}

/** The stored rate is still the chosen quote, not a later manual edit. */
export function quoteRateMatches(
  rate: number | null | undefined,
  quotePrice: number | null | undefined,
): boolean {
  if (rate == null || quotePrice == null || !Number.isFinite(rate) || !Number.isFinite(quotePrice)) return false;
  return roundMoney(rate) === roundMoney(quotePrice);
}

/**
 * A manual rate edit must drop the quote badge. Reset then keeps the edited
 * rate instead of jumping back to the pre-quote base.
 */
export function positionWithoutStaleQuote<T extends {
  rate: number;
  rateMissing?: boolean;
  priceSource?: "quote" | "manual";
  selectedQuoteId?: string;
  quoteSupplierName?: string;
  quoteUnitPrice?: number;
  baseRate?: number;
}>(previous: T | undefined, next: T): T {
  if (!previous || previous.priceSource !== "quote") return next;
  const sameRate = roundMoney(previous.rate) === roundMoney(next.rate)
    && Boolean(previous.rateMissing) === Boolean(next.rateMissing);
  if (sameRate) return next;
  const { selectedQuoteId: _quote, quoteSupplierName: _name, quoteUnitPrice: _price, priceSource: _source, ...rest } = next;
  return {
    ...rest,
    priceSource: "manual",
    baseRate: next.rateMissing ? previous.baseRate : next.rate,
  } as T;
}

export function quoteUnitPriceError(price: number): string | null {
  if (!Number.isFinite(price)) return "Цена КП должна быть числом";
  if (price < 0) return "Цена КП не может быть отрицательной";
  if (price === 0) return "Цена КП должна быть больше нуля";
  if (price > MAX_QUOTE_UNIT_PRICE) return "Цена КП слишком большая для ставки строки";
  return null;
}

export function isCommercialRateLine(position: Pick<CalcPosition, "costRole" | "isWorkItem" | "code">): boolean {
  if (position.costRole === "customer_source") return false;
  if (position.isWorkItem) return false;
  if (position.code === "НР" || position.code === "СП") return false;
  return true;
}

/** Active suitable quotes only. Order is by supplier name, not by price. */
export function suitableQuotesForPosition(
  position: Pick<CalcPosition, "name" | "unit">,
  supplies: SupplyRequest[],
  procurementId: string,
): PositionQuoteOffer[] {
  const key = quoteMatchKey(position.name, position.unit);
  const offers: PositionQuoteOffer[] = [];
  for (const supply of supplies) {
    if (supply.procurementId !== procurementId) continue;
    if (supply.status === "cancelled") continue;
    if (quoteMatchKey(supply.materialName, supply.unit) !== key) continue;
    for (const quote of supply.quotes ?? []) {
      if (quoteUnitPriceError(quote.unitPrice)) continue;
      offers.push({
        quoteId: quote.id,
        supplyId: supply.id,
        supplierName: quote.supplierName,
        unitPrice: quote.unitPrice,
        materialName: supply.materialName,
        unit: supply.unit,
      });
    }
  }
  return offers.sort((a, b) => a.supplierName.localeCompare(b.supplierName, "ru") || a.quoteId.localeCompare(b.quoteId));
}

export function averageQuoteHint(prices: number[]): QuoteHint {
  const usable = prices.filter((price) => quoteUnitPriceError(price) == null);
  if (!usable.length) {
    return {
      count: 0,
      average: null,
      min: null,
      max: null,
      label: "Нет активных КП — средняя цена не считается",
      spreadLabel: null,
    };
  }
  const sum = usable.reduce((total, price) => total + price, 0);
  const average = roundMoney(sum / usable.length);
  const min = roundMoney(Math.min(...usable));
  const max = roundMoney(Math.max(...usable));
  return {
    count: usable.length,
    average,
    min,
    max,
    label: `Средняя цена по ${usable.length} КП — подсказка`,
    spreadLabel: usable.length >= 2 ? `Разброс ${formatMoney(min)} – ${formatMoney(max)}` : null,
  };
}

export function lineAmount(position: Pick<CalcPosition, "quantity" | "rate" | "rateMissing" | "isWorkItem">): number {
  if (position.isWorkItem || position.rateMissing) return 0;
  if (!Number.isFinite(position.quantity) || !Number.isFinite(position.rate) || position.rate <= 0 || position.quantity === 0) {
    return 0;
  }
  return roundMoney(Math.abs(position.quantity) * position.rate);
}

export function buildNmckCostGap(input: {
  nmck: number | null | undefined;
  direct: number | null | undefined;
  overhead: number | null | undefined;
  contingency: number | null | undefined;
  fullCost: number | null | undefined;
  officialPrice: number | null | undefined;
  lines: Array<Pick<CalcPosition, "id" | "name" | "quantity" | "rate" | "rateMissing" | "isWorkItem" | "costRole" | "code" | "sourceSectionName">>;
}): NmckCostGap {
  const nmck = finiteOrNull(input.nmck);
  const fullCost = finiteOrNull(input.fullCost);
  const triggered = nmck != null && fullCost != null && nmck <= fullCost;
  const deficitRub = triggered ? roundMoney(fullCost - nmck) : null;
  const deficitPercentOfNmck = triggered && nmck > 0 && deficitRub != null
    ? roundMoney((deficitRub / nmck) * 100)
    : null;
  const priced = input.lines
    .filter((line) => isCommercialRateLine(line))
    .map((line) => ({
      id: line.id,
      name: line.name.trim() || "Строка без названия",
      section: line.sourceSectionName?.trim() || "",
      amount: lineAmount(line),
    }))
    .filter((line) => line.amount > 0);
  const grouped = new Map<string, CostDriver>();
  const usePackages = priced.some((line) => line.section);
  for (const line of priced) {
    const id = usePackages ? `pkg:${line.section || "без пакета"}` : line.id;
    const name = usePackages ? (line.section || "Без пакета") : line.name;
    const current = grouped.get(id);
    if (current) current.amount = roundMoney(current.amount + line.amount);
    else grouped.set(id, { id, name, amount: line.amount, kind: usePackages ? "package" : "line" });
  }
  const topDrivers = [...grouped.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "ru")).slice(0, 3);
  return {
    triggered,
    nmck,
    direct: finiteOrNull(input.direct),
    overhead: finiteOrNull(input.overhead),
    contingency: finiteOrNull(input.contingency),
    fullCost,
    officialPrice: finiteOrNull(input.officialPrice),
    deficitRub,
    deficitPercentOfNmck,
    topDrivers,
    headline: triggered ? "Почему не проходим" : "",
  };
}

export function directorDecisionLabel(choice: DirectorDecisionChoice): string {
  return DIRECTOR_DECISION_OPTIONS.find((option) => option.id === choice)?.label ?? choice;
}

export function isDirectorDecisionChoice(value: string): value is DirectorDecisionChoice {
  return DIRECTOR_DECISION_OPTIONS.some((option) => option.id === value);
}

export function buildBddsFrame(input: {
  officialCostReady: boolean;
  gprDatesReady: boolean;
  workPackagesReady: boolean;
}): BddsFrame {
  return {
    status: "waiting_rules",
    statusText: BDDS_WAITING_STATUS,
    readyInputs: [
      input.officialCostReady
        ? "Официальная себестоимость уже есть в расчёте"
        : "Официальная себестоимость ещё не подтверждена",
      input.gprDatesReady
        ? "Сроки ГПР уже заданы"
        : "Сроки ГПР ещё не заданы",
      input.workPackagesReady
        ? "Пакеты работ уже собраны"
        : "Пакеты работ ещё не собраны",
    ],
    missingRules: [
      "Правила распределения платежей",
      "Правила авансов",
      "График оплат от Андрея / финансового блока",
    ],
    cashGaps: null,
    paymentSchedule: null,
    figures: null,
  };
}

export function bddsReadiness(input: {
  calculation: Pick<Calculation, "kind" | "positions" | "costSummary">;
  stages: Array<{ name?: string; start?: string; end?: string }>;
}): { officialCostReady: boolean; gprDatesReady: boolean; workPackagesReady: boolean } {
  const summary = input.calculation.costSummary;
  const officialCostReady = input.calculation.kind !== "customer_original"
    && summary != null
    && Number.isFinite(summary.C)
    && summary.C > 0
    && summary.totalsIncomplete !== true;
  const gprDatesReady = input.stages.some((stage) => Boolean(stage.start && stage.end));
  const workPackagesReady = input.calculation.positions.some((position) => Boolean(position.sourceSectionName?.trim()))
    || input.stages.some((stage) => Boolean(stage.name?.trim()));
  return { officialCostReady, gprDatesReady, workPackagesReady };
}

function activeOrgUsers(users: Array<Pick<User, "id" | "orgId" | "role" | "blocked" | "createdAt" | "name">>, orgId: string) {
  return users.filter((user) => user.orgId === orgId && !user.blocked);
}

/** Tender engineer when the organisation has one. Otherwise the creator. */
export function resolveCalculationOwner(
  users: Array<Pick<User, "id" | "orgId" | "role" | "blocked" | "createdAt" | "name">>,
  orgId: string,
  creatorId: string,
): ResolvedOwner | null {
  const people = activeOrgUsers(users, orgId);
  const engineers = people
    .filter((user) => user.role === "tender")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const creator = people.find((user) => user.id === creatorId);
  const chosen = engineers[0] ?? creator ?? null;
  if (!chosen) return null;
  return { userId: chosen.id, role: chosen.role, name: chosen.name };
}

export function displayedCalculationOwner(
  calculation: Pick<Calculation, "orgId" | "authorId" | "ownerUserId" | "ownerRole">,
  users: Array<Pick<User, "id" | "orgId" | "role" | "blocked" | "createdAt" | "name">>,
): { userId: string; role: Role; name: string; assigned: boolean } | null {
  if (calculation.ownerUserId) {
    const stored = users.find((user) => user.id === calculation.ownerUserId && user.orgId === calculation.orgId);
    if (stored) {
      return {
        userId: stored.id,
        role: stored.role,
        name: stored.name,
        assigned: true,
      };
    }
  }
  const resolved = resolveCalculationOwner(users, calculation.orgId, calculation.authorId);
  if (!resolved) return null;
  return { ...resolved, assigned: false };
}

export function ownerRoleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

/**
 * A quote stays selected while the rate still equals it, even if the supply
 * was cancelled or the name no longer matches the active list.
 */
export function quoteSelectionState(
  position: Pick<CalcPosition, "priceSource" | "selectedQuoteId" | "quoteSupplierName" | "quoteUnitPrice" | "rate">,
  supplies: SupplyRequest[],
): { applied: boolean; quoteId?: string; supplierName?: string } {
  if (position.priceSource !== "quote" || !position.selectedQuoteId) return { applied: false };
  const live = findQuoteOnSupplies(supplies, position.selectedQuoteId);
  const price = live?.quote.unitPrice ?? position.quoteUnitPrice;
  if (!quoteRateMatches(position.rate, price)) return { applied: false };
  return {
    applied: true,
    quoteId: position.selectedQuoteId,
    supplierName: position.quoteSupplierName ?? live?.quote.supplierName,
  };
}

export function findQuoteOnSupplies(
  supplies: SupplyRequest[],
  quoteId: string,
): { supply: SupplyRequest; quote: SupplierQuote } | null {
  for (const supply of supplies) {
    const quote = supply.quotes?.find((item) => item.id === quoteId);
    if (quote) return { supply, quote };
  }
  return null;
}
