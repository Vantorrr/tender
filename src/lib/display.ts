/** Убирает служебные пометки из подписей, которые видит пользователь. */
export function cleanLabel(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\s*\(мок(?:-источник)?\)/gi, "")
    .replace(/\s*мок-источник/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
