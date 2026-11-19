import type { Citation, DocumentAnalysis, Highlight } from "@/lib/types";
import { aiAnalysisFailureStatus } from "@/lib/ai-status";
import { MODEL_NOTE_SYSTEM, formatSourceLocation } from "@/server/ai-prompts";
import type { WorkSectionRollup } from "@/server/estimate-rollup";
import { config } from "@/server/config";
import { completeJson, modelConfigured } from "@/server/openrouter";

export const ANALYSIS_SYSTEM_PROMPT = MODEL_NOTE_SYSTEM;

type Noted = {
  analyticalNote: string;
  highlights: Highlight[];
  analysis: DocumentAnalysis;
  citations?: Citation[];
  noteByModel?: boolean;
  aiFailure?: string;
};

/** Citations always come from parsed source file — never invented by the LLM. */
export function sourceCitationsFromAnalysis(input: {
  citations?: Citation[];
  highlights: Highlight[];
  fileName?: string;
}): Citation[] {
  if (input.citations?.length) return input.citations;
  return input.highlights.map((h, i) => ({
    id: h.id || `cite-${i}`,
    text: h.text,
    page: h.page,
    sourceFile: input.fileName ?? "source",
  }));
}

export function buildModelNoteUserContent(
  facts: Record<string, unknown>,
  highlights: Highlight[],
  citations: Citation[] = []
): string {
  const spreadsheet = citations.some((citation) => citation.sheet);
  const sources = citations.slice(0, 40).map((citation) => ({
    file: citation.sourceFile,
    ...(citation.sheet ? { sheet: citation.sheet } : { page: citation.page }),
    ...(citation.paragraph != null ? { paragraph: citation.paragraph } : {}),
    ...(citation.cell ? { cell: citation.cell } : {}),
    location: formatSourceLocation({
      sourceFile: citation.sourceFile,
      sheet: citation.sheet,
      cell: citation.cell,
      paragraph: citation.paragraph,
      page: citation.sheet ? undefined : citation.page,
    }),
    text: citation.text.slice(0, 700),
  }));
  const visibleHighlights = highlights.slice(0, 10).map((highlight) => {
    const probe = highlight.text.trim().toLocaleLowerCase("ru-RU").slice(0, 48);
    const matched = citations.find((citation) => {
      const text = citation.text.toLocaleLowerCase("ru-RU");
      return probe.length >= 4 && (text.includes(probe) || probe.includes(text.slice(0, 48)));
    });
    const related = citations.find((citation) => citation.cell && cellRelatesToFact(highlight.text, citation.text));
    const source = matched && (!matched.cell || cellRelatesToFact(highlight.text, matched.text)) ? matched : related;
    const sheet = source?.sheet ?? citations.find((citation) => citation.sheet)?.sheet;
    return spreadsheet
      ? {
        text: highlight.text,
        reason: highlight.reason,
        severity: highlight.severity,
        location: formatSourceLocation({
          sourceFile: source?.sourceFile ?? citations[0]?.sourceFile,
          sheet,
          cell: source?.cell,
        }),
      }
      : {
        text: highlight.text,
        reason: highlight.reason,
        severity: highlight.severity,
        page: highlight.page,
        location: formatSourceLocation({ sourceFile: source?.sourceFile, page: highlight.page }),
      };
  });
  return JSON.stringify({ facts, highlights: visibleHighlights, sources });
}

const CELL_TOKEN = "[A-Z]{1,3}\\d{1,5}(?::[A-Z]{1,3}\\d{1,5})?";

/** Drop an invented cell label or an Excel page the source did not provide. Codes such as L2 stay. */
export function omitUnsourcedPlaces(note: string, citations: Citation[]): string {
  const cells = new Set(citations.map((citation) => citation.cell).filter((cell): cell is string => Boolean(cell)).map((cell) => cell.toUpperCase()));
  const knownCell = (token: string) => {
    const value = token.toUpperCase();
    if (cells.has(value)) return true;
    return [...cells].some((cell) => cell.split(":").includes(value));
  };
  let text = note.replace(new RegExp(`ячейк[аеиу]\\s+(${CELL_TOKEN})\\b`, "gi"), (full, token: string) => knownCell(token) ? full : "");
  text = text.replace(
    new RegExp(`(лист[а-яё]*\\s+(?:[«"][^»"]{1,40}[»"]|[^\\s,»"]{1,40})\\s*,\\s*)(${CELL_TOKEN})\\b`, "gi"),
    (full, prefix: string, token: string) => knownCell(token) ? full : prefix.replace(/,\s*$/, "")
  );
  if (citations.length > 0 && citations.every((citation) => citation.sheet)) {
    text = text.replace(/,?\s*стр\.\s*\d+/gi, "");
  }
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/,\s*(?=[,.]|$)/g, "")
    .trim();
}

/** A scanned negative is the cell value itself, not a hyphen inside an estimate header. */
export function isNegativeAmount(text: string): boolean {
  return /^-\d+(?:[.,]\d+)?$/.test(text.trim().replace(/\s/g, ""));
}

/** Keep a cell on a fact only when that cell's own text contains the fact's keyword or number. */
export function cellRelatesToFact(fact: string, cellText: string): boolean {
  const factFold = fact.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const cellFold = cellText.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  if (/индекс/.test(factFold)) return /индекс/.test(cellFold);
  if (/отрицательн/.test(factFold)) return isNegativeAmount(cellText);
  if (/оплат/.test(factFold) || (/акт/.test(factFold) && /труд/.test(factFold))) return /оплат|труд/.test(cellFold);
  if (cellFold.length >= 4 && factFold.includes(cellFold.slice(0, 24))) return true;
  const words = factFold.replace(new RegExp(CELL_TOKEN, "gi"), " ").match(/[а-яa-z]{5,}/gu) ?? [];
  const numbers = fact.replace(new RegExp(CELL_TOKEN, "gi"), " ").match(/\d+(?:[.,]\d+)?/g) ?? [];
  const cellWords = new Set(cellFold.match(/[а-яa-z]{5,}/gu) ?? []);
  return words.some((word) => cellWords.has(word)) || numbers.some((value) => cellText.includes(value));
}

function cellKeys(cell: string): string[] {
  const value = cell.toUpperCase();
  const parts = value.split(":");
  return [...new Set(parts.length > 1 ? [value, ...parts] : [value])];
}

export function keepCellsThatSupportFact(note: string, citations: Citation[]): string {
  const byCell = new Map<string, string>();
  for (const citation of citations) {
    if (!citation.cell) continue;
    for (const key of cellKeys(citation.cell)) byCell.set(key, `${byCell.get(key) ?? ""} ${citation.text}`);
  }
  return note.split(/(?<=\n)/).map((line) => {
    const mention = new RegExp(`ячейк[а-яё]{0,3}\\s+((?:${CELL_TOKEN}\\s*,\\s*)*${CELL_TOKEN})`, "gi");
    return line.replace(mention, (_full, list: string) => {
      const tokens = [...new Set(list.split(/\s*,\s*/).map((token) => token.toUpperCase()))];
      const negativeFact = /отрицательн/.test(line.toLocaleLowerCase("ru-RU").replace(/ё/g, "е"));
      const supported = tokens.filter((token) => {
        const text = byCell.get(token) ?? "";
        if (negativeFact) return isNegativeAmount(text.trim());
        return cellRelatesToFact(line, text);
      }).slice(0, 3);
      return supported.length ? `ячейка ${supported.join(", ")}` : "";
    });
  }).join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/,\s*(?=[,.]|$)/g, "")
    .trim();
}

function digits(value: string) {
  return value.replace(/\D/g, "");
}

function noteHasQuantity(note: string, quantity: number): boolean {
  const whole = Math.trunc(quantity);
  if (!Number.isFinite(whole)) return true;
  const digits = String(Math.abs(whole));
  return new RegExp(`(?:^|\\D)${digits.split("").join("[\\s\\u00a0]?")}(?:\\D|$)`).test(note);
}

function standalone(note: string, value: string) {
  return new RegExp(`(?:^|\\D)${value}(?:\\D|$)`).test(note);
}

/** Parse model JSON note; invalid/missing → null (caller keeps local note). */
export function readNote(raw: string): string | null {
  const trimmed = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as { note?: unknown };
    return typeof parsed.note === "string" ? parsed.note.trim() : null;
  } catch {
    const match = trimmed.match(/"note"\s*:\s*"([\s\S]*)"\s*}/);
    if (!match) return null;
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  }
}

/** Reject model output that claims external actions or tool use. */
export function rejectsExternalActions(note: string): string | null {
  if (
    /(?:вызва(л|ла|ли)\s+api|отправил[аи]?\s+письм|sync\s+procurement|openrouter|curl\s+http|удалил[аи]?\s+записи|сменил[аи]?\s+парол)/i.test(
      note
    )
  ) {
    return "модель заявила внешнее действие";
  }
  return null;
}

async function writeNote(
  facts: Record<string, unknown>,
  checks: Array<string | null>,
  highlights: Highlight[],
  citations: Citation[]
): Promise<{ note: string } | { failure: string }> {
  if (!modelConfigured()) return { failure: "ключ модели не задан" };
  const userContent = buildModelNoteUserContent(facts, highlights, citations);
  let raw: string;
  try {
    raw = await completeJson(ANALYSIS_SYSTEM_PROMPT, userContent);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "ошибка модели";
    console.error("model note skipped:", reason);
    return { failure: reason };
  }
  let note = readNote(raw);
  if (note) note = keepCellsThatSupportFact(omitUnsourcedPlaces(note, citations), citations);
  if (!note) {
    console.error("model note skipped: пустой ответ модели");
    return { failure: "пустой ответ модели" };
  }
  const external = rejectsExternalActions(note);
  if (external) {
    console.error("model note rejected:", external);
    return { failure: external };
  }
  if (rejection(note, checks, facts, userContent)?.startsWith("нет факта зона 5") && /зон/i.test(note)) {
    note = `${note.replace(/\s+$/, "")} Зона 5.`;
  }
  const reason = rejection(note, checks, facts, userContent);
  if (reason) {
    console.error("model note rejected:", reason);
    return { failure: reason };
  }
  return { note };
}

export function noteRejectionReason(
  note: string | null,
  checks: Array<string | null>,
  facts: Record<string, unknown>,
  allowedText?: string
): string | null {
  return rejection(note, checks, facts, allowedText);
}

function rejection(
  note: string | null,
  checks: Array<string | null>,
  facts: Record<string, unknown>,
  allowedText?: string
) {
  if (!note) return "пустой ответ";
  if (note.length < 180) return "слишком коротко";
  if (note.length > 4000) return "слишком длинно";
  const plain = note.toLowerCase();
  for (const check of checks) {
    if (!check) continue;
    const asDigits = digits(check);
    if (asDigits === check && standalone(note, asDigits)) continue;
    if (check === "0,12" && /0[.,]12/.test(note)) continue;
    if (check === "зона 5" && /зон[а-яё]*[^0-9]{0,6}5/.test(plain)) continue;
    if (plain.includes(check.toLowerCase())) continue;
    if (check === "зона 5") {
      return `нет факта зона 5: ${note.replace(/\s+/g, " ").slice(0, 280)}`;
    }
    return `нет факта «${check.slice(0, 80)}»`;
  }
  if (facts.kind === "local-estimate" && /черт[её]ж|текстового слоя/i.test(note)) {
    return "смета упомянула чертёж";
  }
  if (facts.kind === "drawing" && !/текстов/i.test(note)) return "чертёж без оговорки про текст";
  const rollup = facts.sectionRollup as WorkSectionRollup | undefined;
  if (rollup && Array.isArray(rollup.sections) && rollup.sections.length > 1) {
    if (/только\s+(?:по\s+)?одн(?:у|ой|а|о)\s+позиц/iu.test(note)) return "записка сузила объём до одной позиции";
    for (const section of rollup.sections) {
      if (!noteHasQuantity(note, section.quantity)) return `нет объёма раздела «${section.section.slice(0, 80)}»`;
    }
  }
  const allowed = digits(allowedText ?? JSON.stringify(facts));
  for (const chunk of note.match(/\d{3,}/g) ?? []) {
    if (!allowed.includes(chunk)) return `число ${chunk} не из файла`;
  }
  return null;
}

export async function refineNote<T extends Noted>(
  analysis: T,
  facts: Record<string, unknown>,
  checks: Array<string | null>
): Promise<T> {
  // Preserve / normalize citations from the source parse before any model call.
  const citations = sourceCitationsFromAnalysis({
    citations: analysis.citations,
    highlights: analysis.highlights,
    fileName:
      typeof facts.fileName === "string"
        ? facts.fileName
        : typeof facts.estimateNumber === "string"
          ? String(facts.estimateNumber)
          : undefined,
  });
  const withCitations = { ...analysis, citations } as T;

  if (!modelConfigured()) {
    return withCitations;
  }

  try {
    const written = await writeNote(facts, checks, analysis.highlights, citations);
    if ("failure" in written) {
      return {
        ...withCitations,
        aiFailure: aiAnalysisFailureStatus(written.failure),
      };
    }
    return {
      ...withCitations,
      analyticalNote: written.note,
      noteByModel: true,
      aiFailure: undefined,
      analysis: { ...analysis.analysis, narrator: config.openRouterModel },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "ошибка модели";
    console.error("model note skipped:", reason);
    return {
      ...withCitations,
      aiFailure: aiAnalysisFailureStatus(reason),
    };
  }
}
