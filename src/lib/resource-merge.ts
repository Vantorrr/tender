import { roundMoney } from "@/lib/calc-math";
import type { GprStageResource } from "@/lib/types";

type MergeableLeaf = {
  id: string;
  kind: string;
  name: string;
  unit: string;
  quantity: number;
  hoursQ?: number | null;
  amount?: number | null;
  rate?: number | null;
  /** Signed return from the estimate. The quantity column stays non-negative. */
  difference?: number | null;
  incomplete: string[];
  memberIds?: string[];
};

function norm(value: string) {
  return value
    .replace(/^возврат:\s*/iu, "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLaborHourUnit(unit: string): boolean {
  const value = norm(unit).replace(/\s+/gu, "");
  return /^(?:ч|час|часа|часов|чел\.?-?ч|челч)$/u.test(value);
}

export function laborDisplayUnit(kind: string, unit: string): string {
  return kind === "labor" && isLaborHourUnit(unit) ? "чел.-ч" : unit;
}

/** Integer crew only when the hours divide cleanly by the known shift. */
export function laborHeadcount(hours: number, hoursPerShift?: number | null, days?: number | null): number | null {
  if (hoursPerShift == null || days == null || hoursPerShift <= 0 || days <= 0) return null;
  const people = hours / (hoursPerShift * days);
  const rounded = Math.round(people);
  if (rounded < 1 || Math.abs(people - rounded) > 0.05) return null;
  return rounded;
}

function resourceIdentity(kind: string, name: string, unit: string) {
  return `${kind}|${norm(name)}|${norm(laborDisplayUnit(kind, unit))}`;
}

/** Rates within 1% are the same tariff for display. A missing rate only matches a missing rate. */
export function ratesWithinOnePercent(left: number | null | undefined, right: number | null | undefined): boolean {
  const leftMissing = left == null || !Number.isFinite(left);
  const rightMissing = right == null || !Number.isFinite(right);
  if (leftMissing || rightMissing) return leftMissing && rightMissing;
  const scale = Math.max(Math.abs(left), Math.abs(right));
  if (scale === 0) return true;
  return Math.abs(left - right) / scale < 0.01;
}

export function weightedRate(rows: Array<{ quantity: number; rate: number | null | undefined }>): number | null {
  let quantity = 0;
  let money = 0;
  for (const row of rows) {
    if (row.rate == null || !Number.isFinite(row.rate)) continue;
    const qty = Number(row.quantity) || 0;
    quantity += qty;
    money += qty * row.rate;
  }
  if (quantity === 0) return rows.find((row) => row.rate != null && Number.isFinite(row.rate))?.rate ?? null;
  return money / quantity;
}

/**
 * Identical resources inside one stage become one row.
 * Negative estimate lines (возврат / исключение) are netted into that row.
 * A negative remainder is shown as «Возврат», not as a separate resource with a minus.
 */
export function mergeEstimateLeaves<T extends MergeableLeaf>(leaves: T[]): T[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const leaf of leaves) {
    const identity = resourceIdentity(leaf.kind, leaf.name, leaf.unit);
    const existing = [...groups.entries()].find(([key, list]) => key.startsWith(`${identity}|`) && ratesWithinOnePercent(list[0]?.rate, leaf.rate));
    if (!existing) {
      const key = `${identity}|${order.length}`;
      groups.set(key, [leaf]);
      order.push(key);
    } else {
      existing[1].push(leaf);
    }
  }

  const merged: T[] = [];
  for (const key of order) {
    const list = groups.get(key)!;
    const baseName = list[0].name.replace(/^возврат:\s*/iu, "").trim();
    const quantity = list.reduce((sum, leaf) => {
      const value = Number(leaf.quantity) || 0;
      const credit = /^возврат:/iu.test(leaf.name) || (leaf.difference != null && leaf.difference < 0);
      return sum + (credit ? -Math.abs(value) : value);
    }, 0);
    const hoursKnown = list.some((leaf) => leaf.hoursQ != null);
    const hours = hoursKnown
      ? list.reduce((sum, leaf) => sum + (leaf.hoursQ ?? 0), 0)
      : null;
    const amounts = list.map((leaf) => leaf.amount).filter((amount): amount is number => amount != null);
    const amount = amounts.length === list.length && amounts.length > 0
      ? roundMoney(amounts.reduce((sum, value) => sum + value, 0))
      : amounts.length === 1 && list.length === 1
        ? amounts[0]
        : list.length > 1 && amounts.length > 0 && amounts.length === list.filter((leaf) => leaf.amount != null).length
          ? roundMoney(amounts.reduce((sum, value) => sum + value, 0))
          : list.every((leaf) => leaf.amount == null)
            ? null
            : roundMoney(amounts.reduce((sum, value) => sum + value, 0));
    if (Math.abs(quantity) < 1e-9 && (amount == null || Math.abs(amount) < 0.005)) continue;
    const isReturn = quantity < 0 || (Math.abs(quantity) < 1e-9 && (amount ?? 0) < 0);
    const incomplete = [...new Set(list.flatMap((leaf) => leaf.incomplete))];
    merged.push({
      ...list[0],
      name: isReturn ? `Возврат: ${baseName}` : baseName,
      unit: laborDisplayUnit(list[0].kind, list[0].unit),
      quantity: Math.abs(quantity),
      difference: isReturn ? -Math.abs(quantity) : null,
      hoursQ: hours == null ? null : Math.abs(hours),
      amount,
      rate: weightedRate(list.map((leaf) => ({ quantity: Math.abs(Number(leaf.quantity) || 0), rate: leaf.rate }))),
      incomplete,
      memberIds: list.flatMap((leaf) => leaf.memberIds?.length ? leaf.memberIds : [leaf.id]),
    });
  }
  return merged;
}

/**
 * The screen shows a return as a positive quantity. The stored rows keep the minus
 * so the credit is not turned into an extra charge.
 */
export function patchMergedPositions<T extends { id: string; quantity: number }>(
  positions: T[],
  leaf: { positionId?: string; memberIds?: string[]; name: string; difference?: number | null },
  shownQuantity: number,
): T[] {
  const ids = new Set(leaf.memberIds?.length ? leaf.memberIds : leaf.positionId ? [leaf.positionId] : []);
  const members = positions.filter((position) => ids.has(position.id));
  if (!members.length) return positions;
  const signedNet = members.reduce((sum, position) => sum + (Number(position.quantity) || 0), 0);
  const isReturn = (leaf.difference != null && leaf.difference < 0) || /^возврат:/iu.test(leaf.name) || signedNet < 0;
  const target = isReturn ? -Math.abs(shownQuantity) : shownQuantity;
  return positions.map((position) => {
    if (!ids.has(position.id)) return position;
    const index = members.findIndex((member) => member.id === position.id);
    const quantity = Math.abs(signedNet) < 1e-9
      ? (index === 0 ? target : 0)
      : position.quantity * (target / signedNet);
    return { ...position, quantity };
  });
}

/**
 * Apply an edit to every source row of a merged line.
 * A return stays negative, and rows keep their own hours and days
 * unless the user changed that field.
 */
export function patchMergedResources(
  members: GprStageResource[],
  leaf: { name: string },
  patch: {
    name?: string;
    unit?: string;
    quantity?: number;
    rate?: number | null;
    hoursPerShift?: number | null;
    shiftsPerDay?: number | null;
    days?: number | null;
    kind?: GprStageResource["kind"];
    quantityBasis?: GprStageResource["quantityBasis"] | null;
  },
): GprStageResource[] {
  const signedNet = members.reduce((sum, item) => {
    const value = Number(item.quantity) || 0;
    return sum + (/^возврат:/iu.test(item.name) ? -Math.abs(value) : value);
  }, 0);
  const isReturn = /^возврат:/iu.test(leaf.name) || signedNet < 0;
  const target = patch.quantity === undefined ? null : isReturn ? Math.abs(patch.quantity) : patch.quantity;
  return members.map((member, index) => {
    const share = Math.abs(Number(member.quantity) || 0);
    const quantity = target == null
      ? member.quantity
      : Math.abs(signedNet) < 1e-9
        ? (index === 0 ? target : 0)
        : share * (target / Math.abs(signedNet));
    return {
      ...member,
      name: patch.name ?? (target != null && isReturn ? `Возврат: ${member.name.replace(/^возврат:\s*/iu, "")}` : member.name),
      unit: patch.unit ?? member.unit,
      kind: patch.kind ?? member.kind,
      quantity,
      rate: patch.rate === undefined ? member.rate : patch.rate,
      hoursPerShift: patch.hoursPerShift === undefined ? member.hoursPerShift : patch.hoursPerShift,
      shiftsPerDay: patch.shiftsPerDay === undefined ? member.shiftsPerDay : patch.shiftsPerDay,
      days: patch.days === undefined ? member.days : patch.days,
      quantityBasis: patch.quantityBasis === undefined ? member.quantityBasis : patch.quantityBasis ?? undefined,
    };
  });
}

/** Same netting for resources stored on a GPR stage. */
export function mergeStageResources(resources: GprStageResource[]): GprStageResource[] {
  const order: string[] = [];
  const groups = new Map<string, GprStageResource[]>();
  for (const resource of resources) {
    const key = `${resourceIdentity(resource.kind, resource.name, resource.unit)}|${resource.rate == null ? "none" : String(resource.rate)}`;
    const list = groups.get(key);
    if (!list) {
      groups.set(key, [resource]);
      order.push(key);
    } else list.push(resource);
  }
  const merged: GprStageResource[] = [];
  for (const key of order) {
    const list = groups.get(key)!;
    const quantity = list.reduce((sum, resource) => {
      const value = Number(resource.quantity) || 0;
      return sum + (/^возврат:/iu.test(resource.name) ? -Math.abs(value) : value);
    }, 0);
    if (Math.abs(quantity) < 1e-9) continue;
    const baseName = list[0].name.replace(/^возврат:\s*/iu, "").trim();
    const rates = [...new Set(list.map((resource) => resource.rate).filter((rate): rate is number => rate != null))];
    merged.push({
      ...list[0],
      name: quantity < 0 ? `Возврат: ${baseName}` : baseName,
      unit: laborDisplayUnit(list[0].kind, list[0].unit),
      quantity: Math.abs(quantity),
      rate: rates.length === 1 ? rates[0] : list[0].rate,
    });
  }
  return merged;
}

/** One summed line per work type. Identical lines keep their own work. */
export function mergeLeavesByWork<T extends MergeableLeaf & { workKey?: string }>(leaves: T[]): T[] {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const leaf of leaves) {
    const key = leaf.workKey ?? "";
    const list = buckets.get(key);
    if (!list) {
      buckets.set(key, [leaf]);
      order.push(key);
    } else list.push(leaf);
  }
  return order.flatMap((key) => mergeEstimateLeaves(buckets.get(key) ?? []));
}

export type GroupedResourceLine = {
  id: string;
  ids: string[];
  name: string;
  unit: string;
  quantity: number;
  rate: number | null;
  workName: string;
  people: number | null;
};

/** Display grouping. Does not change stored rows or the cost total. */
export function groupCalculationResources(rows: Array<{
  id: string;
  name: string;
  unit: string;
  quantity: number;
  rate: number | null;
  workName?: string;
  kind?: string;
  hoursPerShift?: number | null;
  days?: number | null;
}>): GroupedResourceLine[] {
  const order: string[] = [];
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const kind = row.kind ?? (isLaborHourUnit(row.unit) ? "labor" : "other");
    const identity = resourceIdentity(kind, row.name, row.unit);
    const existing = [...groups.entries()].find(([key, list]) => key.startsWith(`${identity}|`) && ratesWithinOnePercent(list[0]?.rate, row.rate));
    if (!existing) {
      const key = `${identity}|${order.length}`;
      groups.set(key, [row]);
      order.push(key);
    } else existing[1].push(row);
  }
  return order.map((key) => {
    const list = groups.get(key)!;
    const quantity = list.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
    const kind = list[0].kind ?? (isLaborHourUnit(list[0].unit) ? "labor" : "other");
    const shifts = [...new Set(list.map((row) => row.hoursPerShift ?? null))];
    const days = [...new Set(list.map((row) => row.days ?? null))];
    const works = [...new Set(list.map((row) => row.workName?.trim()).filter(Boolean))];
    return {
      id: list[0].id,
      ids: list.map((row) => row.id),
      name: list[0].name.replace(/^возврат:\s*/iu, "").trim(),
      unit: laborDisplayUnit(kind, list[0].unit),
      quantity,
      rate: weightedRate(list),
      workName: works.length === 1 ? works[0]! : "",
      people: laborHeadcount(quantity, shifts.length === 1 ? shifts[0] : null, days.length === 1 ? days[0] : null),
    };
  });
}

/**
 * A grouped display row does not write one rate onto every member.
 * A single row still takes an explicit rate.
 */
export function positionsAfterDisplayedRateEdit<T extends { id: string; rate: number; rateMissing?: boolean }>(
  positions: T[],
  memberIds: string[],
  nextRate: number | null,
): T[] {
  if (memberIds.length !== 1) return positions;
  const id = memberIds[0];
  return positions.map((position) => position.id === id
    ? { ...position, rate: nextRate ?? 0, rateMissing: nextRate == null }
    : position);
}
