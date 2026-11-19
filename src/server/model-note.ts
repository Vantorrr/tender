import type { Citation, DocumentAnalysis, Highlight } from "@/lib/types";
import { aiAnalysisFailureStatus } from "@/lib/ai-status";
import { MODEL_NOTE_SYSTEM, formatSourceLocation } from "@/server/ai-prompts";
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
  const sources = citations.slice(0, 40).map((citation) => ({
    file: citation.sourceFile,
    page: citation.page,
    paragraph: citation.paragraph ?? null,
    sheet: citation.sheet ?? null,
    cell: citation.cell ?? null,
    location: formatSourceLocation(citation),
    text: citation.text.slice(0, 700),
  }));
  return JSON.stringify({ facts, highlights, sources });
}

function digits(value: string) {
  return value.replace(/\D/g, "");
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
