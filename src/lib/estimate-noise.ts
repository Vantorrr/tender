/** Labor and machine hours may be unpriced without wiping the work prices. */
export function isEstimateHourRow(row: { unit?: string; resourceKind?: string; name?: string }): boolean {
  const unit = row.unit ?? "";
  if (/чел\.?\s*[-.]?\s*ч|маш\.?\s*[-.]?\s*ч/iu.test(unit)) return true;
  if (row.resourceKind === "labor") return true;
  if (row.resourceKind === "equipment" && /маш/iu.test(unit)) return true;
  return /^зтм?$/iu.test((row.name ?? "").trim());
}
function isPicketLabel(name: string): boolean {
  return /^пк\s*\d+.*\bдо\s*пк\b/iu.test(name.replace(/\s+/g, " ").trim());
}

/** Rows that are totals or overhead norms, not work or resources. */
export function isEstimateNoiseRow(name: string, code = ""): boolean {
  const text = `${code} ${name}`.replace(/\s+/g, " ").trim();
  if (!text) return true;
  if (isPicketLabel(name)) return true;
  return /накладн\p{L}*\s+расход|сметн\p{L}*\s+прибыл|(?:^|[\s(])(?:нр|сп)\b[^.\n]{0,40}%|%\s*фот|итого(?:\s+по)?(?:\s+поз|\s+раздел)|итоги\s+по\s+поз|всего\s+по\s+(?:смете|раздел|позиц)|лимитированн|взис|временн\p{L}*\s+(?:здан|сооруж)|зимн\p{L}*\s+удорож|снегоборьб/iu.test(text);
}

/** A unit cell that is only a number is a price that landed in the wrong column. */
export function isNumericUnit(unit: string | null | undefined): boolean {
  const text = (unit ?? "").trim();
  return Boolean(text) && /^[\d\s.,]+$/u.test(text);
}

/**
 * A quantity glued out of every digit in a label.
 * «177% ФОТ (от 784 598)» and «ПК 103 до ПК 103+546» are not volumes.
 */
export function isGluedQuantity(name: string, quantity: number | null | undefined): boolean {
  if (quantity == null || !Number.isFinite(quantity)) return false;
  if (isEstimateNoiseRow(name)) return true;
  return false;
}

export function isUnusableEstimateLine(row: { name?: string; code?: string; unit?: string; quantity?: number }): boolean {
  const name = row.name ?? "";
  return isEstimateNoiseRow(name, row.code ?? "")
    || isNumericUnit(row.unit)
    || isGluedQuantity(name, row.quantity);
}

/** Saved rows whose unit is a price or that still contain overhead totals. */
export function estimatePositionsLookBroken(rows: Array<{ name?: string; code?: string; unit?: string; rate?: number }>): boolean {
  if (!rows.length) return false;
  let numericUnit = 0;
  let noise = 0;
  for (const row of rows) {
    if (isNumericUnit(row.unit)) numericUnit += 1;
    if (isEstimateNoiseRow(row.name ?? "", row.code ?? "")) noise += 1;
  }
  return numericUnit >= 3 || noise >= 2 || (numericUnit > 0 && noise > 0);
}
