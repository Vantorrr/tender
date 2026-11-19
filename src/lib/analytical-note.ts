const RECOGNIZED = "Текст распознан автоматически, сверьте с оригиналом";

/** Drop a raw OCR dump. Keep the estimate or drawing summary that sits beside it. */
export function presentAnalyticalNote(note: string): { text: string; recognized: boolean } {
  const recognized = /OCR\s*\(|Текст распознан автоматически/u.test(note);
  const text = note
    .split("\n")
    .filter((line) => !/^OCR\s*\(/u.test(line.trim()))
    .filter((line) => line.trim() !== RECOGNIZED)
    .join("\n")
    .trim();
  return { text, recognized };
}
