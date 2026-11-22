import { honestReadinessText, type MemoCalcState } from "@/lib/wave23";

const RECOGNIZED = "Текст распознан автоматически, сверьте с оригиналом";

/** Join a hyphen broken by a line wrap and split a lowercase/uppercase glue. */
export function normalizeOcrText(text: string): string {
  return text
    .replace(/\u00ad/gu, "")
    .replace(/([а-яёa-z])-\s*\n\s*([а-яёa-z])/giu, "$1$2")
    .replace(/([а-яё])([А-ЯЁ])/gu, "$1 $2")
    .replace(/([.!?])([А-ЯЁA-Z])/gu, "$1 $2")
    .replace(/[ \t]{2,}/gu, " ");
}

/**
 * Shorten at a sentence end, otherwise at a word. Never cut inside a word.
 * A fragment that has no boundary stays whole so the screen can offer the full text.
 */
export function clipAtSentence(text: string, limit: number): { text: string; clipped: boolean } {
  const clean = normalizeOcrText(text).replace(/\s+/gu, " ").trim();
  if (clean.length <= limit) return { text: clean, clipped: false };
  const window = clean.slice(0, limit + 1);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentence >= 8) return { text: clean.slice(0, sentence + 1).trim(), clipped: true };
  const word = window.lastIndexOf(" ");
  if (word > 0) return { text: clean.slice(0, word).trim(), clipped: true };
  return { text: clean, clipped: true };
}

function repairCutLine(line: string): string {
  const trimmed = line.trim();
  if (!/(?:\.{3}|…)|[а-яё];$/iu.test(trimmed)) return line;
  const kept = trimmed
    .replace(/(?:^|\s)\S*(?:\.{3}|…)/gu, " ")
    .replace(/(?:^|\s)\S{1,8};?\s*$/u, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[;,\s]+$/u, "");
  return kept.length >= 12 ? kept : "";
}

function isOcrWall(line: string): boolean {
  const text = line.trim();
  if (text.length < 400) return false;
  const sentences = text.match(/[.!?]/gu)?.length ?? 0;
  if (sentences >= 2) return false;
  const tokens = text.split(/\s+/u);
  const glued = tokens.filter((token) => token.length > 24).length;
  return glued >= 3 || sentences === 0;
}

/** Drop a raw OCR dump. Keep the estimate or drawing summary that sits beside it. */
export function presentAnalyticalNote(note: string, economics?: MemoCalcState | null): {
  text: string;
  recognized: boolean;
  preview: string;
  clipped: boolean;
} {
  const recognized = /OCR\s*\(|Текст распознан автоматически/u.test(note);
  const text = honestReadinessText(normalizeOcrText(note), economics)
    .split("\n")
    .map(repairCutLine)
    .filter((line) => !/^OCR\s*\(/u.test(line.trim()))
    .filter((line) => line.trim() !== RECOGNIZED)
    .filter((line) => !isOcrWall(line))
    .join("\n")
    .trim();
  const preview = text.length > 900 ? clipAtSentence(text, 700).text : text;
  return { text, recognized, preview, clipped: preview !== text };
}
