/** A dot between digits is a date or a decimal, not the end of a sentence. */
export function protectNumericDots(text: string): string {
  return text.replace(/(\d)\.(?=\d)/gu, "$1\u0000");
}

export function restoreNumericDots(text: string): string {
  return text.replace(/\u0000/gu, ".");
}

export function splitSentences(text: string): string[] {
  const hidden = protectNumericDots(text);
  return hidden
    .split(/(?<=[.!?])\s+/u)
    .map((part) => restoreNumericDots(part).trim())
    .filter(Boolean);
}
