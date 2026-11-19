export type PromptScore = {
  id: string;
  title: string;
  jsonValid: boolean;
  fieldsFilled: boolean;
  missingFields: string[];
  hasCitation: boolean;
  elapsedMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  error?: string;
};

const CITATION_KEYS = new Set(["quote", "sourceExcerpt", "sourceQuote", "evidence", "note", "location"]);

function collectStrings(value: unknown, keys: Set<string>, found: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, keys, found);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string") found.push(child);
    else collectStrings(child, keys, found);
  }
}

function missingField(key: string, value: unknown, allowEmptyArray: boolean): string | null {
  if (value == null) return key;
  if (typeof value === "string" && !value.trim()) return key;
  if (Array.isArray(value) && !allowEmptyArray && value.length === 0) return key;
  return null;
}

/** Score a model reply without calling the network. */
export function scoreModelResponse(input: {
  id: string;
  title: string;
  raw: string;
  requiredFields: string[];
  allowEmptyArrays?: string[];
  citationHint?: string;
  elapsedMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  error?: string;
}): PromptScore {
  const allowEmpty = new Set(input.allowEmptyArrays ?? []);
  let jsonValid = false;
  let parsed: unknown = null;
  if (!input.error) {
    try {
      parsed = JSON.parse(input.raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      jsonValid = parsed !== null && typeof parsed === "object";
    } catch {
      jsonValid = false;
    }
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const missingFields = jsonValid
    ? input.requiredFields.flatMap((key) => {
        const missing = missingField(key, record[key], allowEmpty.has(key));
        return missing ? [missing] : [];
      })
    : input.requiredFields;
  const snippets: string[] = [];
  collectStrings(parsed, CITATION_KEYS, snippets);
  const hasCitation = snippets.some((snippet) => snippet.trim().length >= 8)
    || Boolean(input.citationHint && typeof record.note === "string" && record.note.includes(input.citationHint));
  return {
    id: input.id,
    title: input.title,
    jsonValid,
    fieldsFilled: jsonValid && missingFields.length === 0,
    missingFields,
    hasCitation,
    elapsedMs: input.elapsedMs,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    error: input.error,
  };
}

export function renderScoreSummary(scores: PromptScore[]): string {
  const lines = [
    "# Оценка промптов",
    "",
    "| Промпт | JSON | Поля | Цитата | Время, мс | Токены запроса | Токены ответа |",
    "| --- | --- | --- | --- | ---: | ---: | ---: |",
  ];
  for (const score of scores) {
    lines.push(`| ${score.title} | ${score.jsonValid ? "да" : "нет"} | ${score.fieldsFilled ? "да" : score.missingFields.join(", ") || "нет"} | ${score.hasCitation ? "да" : "нет"} | ${score.elapsedMs} | ${score.promptTokens ?? "—"} | ${score.completionTokens ?? "—"} |`);
    if (score.error) lines.push(`|  | ошибка: ${score.error.replace(/\|/g, "/")} |  |  |  |  |  |`);
  }
  lines.push("", "Цитата считается найденной, если в ответе есть выдержка, фрагмент источника или ссылка на файл длиннее 8 знаков.");
  return lines.join("\n");
}
