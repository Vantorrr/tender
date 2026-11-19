import { roundMoney } from "@/lib/calc-math";
import type { GprStageResource } from "@/lib/types";

type MergeableLeaf = {
  kind: string;
  name: string;
  unit: string;
  quantity: number;
  hoursQ?: number | null;
  amount?: number | null;
  rate?: number | null;
  incomplete: string[];
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
    const key = `${leaf.kind}|${norm(leaf.name)}|${norm(leaf.unit)}`;
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
      hoursQ: hours == null ? null : Math.abs(hours),
      amount,
      rate: rates.length === 1 ? rates[0] : list[0].rate,
      incomplete,
    });
  }
  return merged;
}

/** Same netting for resources stored on a GPR stage. */
export function mergeStageResources(resources: GprStageResource[]): GprStageResource[] {
  const order: string[] = [];
  const groups = new Map<string, GprStageResource[]>();
  for (const resource of resources) {
    const key = `${resource.kind}|${norm(resource.name)}|${norm(resource.unit)}`;
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
