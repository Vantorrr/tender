/** True when every number in `text` stands in `corpus` as its own number, not as part of a longer one. */
export function numbersAreGrounded(text: string, corpus: string): boolean {
  const tokens = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  if (!tokens.length) return true;
  const source = corpus.replace(/,/g, ".");
  return tokens.every((token) => {
    const normalized = token.replace(",", ".").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\d.])${normalized}(?:[^\\d.]|$)`).test(source);
  });
}

export const NOT_IN_DOCUMENTS = "не указано в документах";
