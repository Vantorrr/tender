/** Убирает служебные пометки из подписей, которые видит пользователь. */
export function cleanLabel(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\s*\(мок(?:-источник)?\)/gi, "")
    .replace(/\s*мок-источник/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Source line on cards and lists. Vendor and protocol names stay off the screen. */
export function visibleProcurementSource(source: string | null | undefined): string {
  const value = cleanLabel(source);
  if (!value || value === "manual") return "Создано вручную";
  if (/контур|api|площадк/iu.test(value)) return "Площадка";
  return value;
}
