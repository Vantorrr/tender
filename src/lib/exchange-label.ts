/** Drop internal procurement numbers and ids from an exchange title. */
export function plainExchangeTitle(name: string): string {
  return name
    .replace(/\s*·\s*РУЧНАЯ-\S+/gu, "")
    .replace(/\s*·\s*p-[\w-]+/gu, "")
    .replace(/\s*·\s*c-[\w-]+/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
