/**
 * Non-negative Russian decimal: «1,5», «1.5», «1 000,25».
 * An empty field is 0. Anything else is null.
 */
export function parseDecimalRu(value: string): number | null {
  const normalized = value.trim().replace(/[\s\u00a0]/g, "").replace(",", ".");
  if (!normalized) return 0;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
