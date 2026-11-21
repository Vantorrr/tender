import { parseDecimalRu } from "@/lib/decimal-ru";

export const QUANTITY_INPUT_ERROR = "Введите количество, например 12,5";

/** Accept a typed quantity. Empty, negative and unreadable values stay on the field. */
export function parseCommittedQuantity(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: QUANTITY_INPUT_ERROR };
  const value = parseDecimalRu(text);
  if (value == null || value < 0) return { ok: false, error: QUANTITY_INPUT_ERROR };
  return { ok: true, value };
}
