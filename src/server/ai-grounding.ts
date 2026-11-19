function numberStandsAlone(source: string, token: string): boolean {
  let from = 0;
  while (from <= source.length) {
    const at = source.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : source[at - 1];
    const afterAt = at + token.length;
    const after = source[afterAt] ?? "";
    const next = source[afterAt + 1] ?? "";
    // A trailing period ends a sentence («120.»). A period followed by a digit
    // continues the number («120.5»), so that occurrence does not count.
    const beforeOk = before === "" || !/[\d.]/.test(before);
    const afterOk = after === "" || (after !== "." ? !/\d/.test(after) : !/\d/.test(next));
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
  return false;
}

/** True when every number in `text` stands in `corpus` as its own number, not as part of a longer one. */
export function numbersAreGrounded(text: string, corpus: string): boolean {
  const tokens = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  if (!tokens.length) return true;
  const source = corpus.replace(/,/g, ".");
  return tokens.every((token) => numberStandsAlone(source, token.replace(",", ".")));
}

export const NOT_IN_DOCUMENTS = "не указано в документах";
