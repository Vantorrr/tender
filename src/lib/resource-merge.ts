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

/**
 * Identical resources inside one stage become one row.
 * Negative estimate lines (возврат / исключение) are netted into that row.
 * A negative remainder is shown as «Возврат», not as a separate resource with a minus.
 */
export function mergeEstimateLeaves<T extends MergeableLeaf>(leaves: T[]): T[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const leaf of leaves) {
    const rateKey = leaf.rate == null ? "none" : String(leaf.rate);
    const key = `${leaf.kind}|${norm(leaf.name)}|${norm(leaf.unit)}|${rateKey}`;
    const list = groups.get(key);
    if (!list) {
      groups.set(key, [leaf]);
      order.push(key);
    } else {
      list.push(leaf);
    }
  }

  const merged: T[] = [];
  for (const key of order) {
    const list = groups.get(key)!;
    const baseName = list[0].name.replace(/^возврат:\s*/iu, "").trim();
    const quantity = list.reduce((sum, leaf) => sum + (Number(leaf.quantity) || 0), 0);
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
    const rates = [...new Set(list.map((leaf) => leaf.rate).filter((rate): rate is number => rate != null))];
    const isReturn = quantity < 0 || (quantity === 0 && (amount ?? 0) < 0);
    const incomplete = [...new Set(list.flatMap((leaf) => leaf.incomplete))];
    merged.push({
      ...list[0],
      name: isReturn ? `Возврат: ${baseName}` : baseName,
      quantity: Math.abs(quantity),
      difference: quantity < 0 ? quantity : null,
      hoursQ: hours == null ? null : Math.abs(hours),
      amount,
      rate: rates.length === 1 ? rates[0] : list[0].rate,
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
  const signedNet = members.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const isReturn = /^возврат:/iu.test(leaf.name) || signedNet < 0;
  const target = patch.quantity === undefined ? null : isReturn ? -Math.abs(patch.quantity) : patch.quantity;
  return members.map((member, index) => {
    const quantity = target == null
      ? member.quantity
      : Math.abs(signedNet) < 1e-9
        ? (index === 0 ? target : 0)
        : member.quantity * (target / signedNet);
    return {
      ...member,
      name: patch.name ?? member.name,
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
    const rateKey = resource.rate == null ? "none" : String(resource.rate);
    const key = `${resource.kind}|${norm(resource.name)}|${norm(resource.unit)}|${rateKey}`;
    const list = groups.get(key);
    if (!list) {
      groups.set(key, [resource]);
      order.push(key);
    } else list.push(resource);
  }
  const merged: GprStageResource[] = [];
  for (const key of order) {
    const list = groups.get(key)!;
    const quantity = list.reduce((sum, resource) => sum + (Number(resource.quantity) || 0), 0);
    if (Math.abs(quantity) < 1e-9) continue;
    const baseName = list[0].name.replace(/^возврат:\s*/iu, "").trim();
    const rates = [...new Set(list.map((resource) => resource.rate).filter((rate): rate is number => rate != null))];
    merged.push({
      ...list[0],
      name: quantity < 0 ? `Возврат: ${baseName}` : baseName,
      quantity,
      rate: rates.length === 1 ? rates[0] : list[0].rate,
    });
  }
  return merged;
}
