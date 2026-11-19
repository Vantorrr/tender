import { config } from "@/server/config";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** Reasoning models spend the completion budget on thinking. 8000 leaves room for JSON. */
const PRIMARY_MAX_TOKENS = 8000;
/** One retry after finish_reason=length gets a larger budget. */
const RETRY_MAX_TOKENS = 12000;
const REQUEST_TIMEOUT_MS = 120_000;

export function modelConfigured() {
  return Boolean(config.openRouterKey);
}

type CompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

export type JsonCompletion = {
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  elapsedMs: number;
  sourceUrls: string[];
};

type CompletionOptions = { webSearch?: boolean; maxTokens?: number; model?: string };

/** Pages the web-search tool actually returned. A model link that is not here was not found. */
export function sourceUrlsFromMessage(message: { annotations?: unknown } | undefined): string[] {
  const annotations = message?.annotations;
  if (!Array.isArray(annotations)) return [];
  const urls: string[] = [];
  for (const item of annotations) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const citation = record.url_citation;
    if (citation && typeof citation === "object") {
      const cited = citation as { url?: unknown; title?: unknown };
      if (typeof cited.url === "string") urls.push(cited.url);
      if (typeof cited.title === "string") {
        const title = cited.title.trim();
        if (/^https?:\/\//i.test(title)) urls.push(title);
        else if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(title) && !/google|vertex/i.test(title)) urls.push(`https://${title}/`);
      }
    }
    if (typeof record.url === "string") urls.push(record.url);
  }
  return [...new Set(urls)];
}

function usageOf(usage: CompletionUsage | undefined): Pick<JsonCompletion, "promptTokens" | "completionTokens" | "totalTokens"> {
  return {
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}

async function requestCompletion(
  system: string,
  user: string,
  attempt: number,
  options: CompletionOptions
): Promise<{ content: string; usage: CompletionUsage | undefined; sourceUrls: string[] }> {
  if (!config.openRouterKey) throw new Error("Ключ модели не задан");
  const retrying = attempt > 0;
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://127.0.0.1:43141",
      "X-Title": "TenderKontur",
    },
    body: JSON.stringify({
      model: options.model || config.openRouterModel,
      temperature: 0.2,
      max_tokens: retrying ? Math.max(options.maxTokens ?? 0, RETRY_MAX_TOKENS) : (options.maxTokens ?? PRIMARY_MAX_TOKENS),
      reasoning: { effort: "low", exclude: true },
      response_format: { type: "json_object" },
      ...(options.webSearch ? { tools: [{ type: "openrouter:web_search", parameters: { max_results: 5 } }] } : {}),
      messages: [
        { role: "system", content: !retrying
          ? system
          : `${system}\nПредыдущая попытка вернула пустой или неполный ответ. Сформируй полный ответ без рассуждений вне JSON, проверь что JSON непустой и содержит обязательные поля.` },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Модель ответила ${response.status}: ${detail.slice(0, 240)}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> | null; refusal?: string | null; annotations?: unknown }; finish_reason?: string }>;
    usage?: CompletionUsage;
  };
  const choice = payload.choices?.[0];
  const sourceUrls = sourceUrlsFromMessage(choice?.message);
  const rawContent = choice?.message?.content;
  const content = (typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part) => part.text ?? "").join("\n")
      : "").trim();
  const finishReason = choice?.finish_reason;
  if (!content) {
    console.error("[openrouter] empty completion", {
      finish_reason: finishReason ?? null,
      usage: payload.usage ?? null,
      attempt,
    });
    if (attempt < 1) return requestCompletion(system, user, attempt + 1, options);
    if (choice?.message?.refusal) throw new Error(`Модель отказала в анализе: ${choice.message.refusal.slice(0, 180)}`);
    throw new Error(`Пустой ответ модели (finish_reason: ${finishReason ?? "не указан"}).`);
  }
  let validJson = false;
  try {
    JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    validJson = true;
  } catch {
    // Providers may stop mid-quote despite JSON mode. Retry once with a larger
    // completion budget before surfacing a confusing JSON parser error to users.
  }
  if ((!validJson || finishReason === "length") && attempt < 1) {
    return requestCompletion(system, user, attempt + 1, options);
  }
  if (!validJson) throw new Error(`Модель вернула неполный JSON после ${attempt + 1} попыток.`);
  return { content, usage: payload.usage, sourceUrls };
}

export async function completeJson(system: string, user: string, attempt = 0, options: CompletionOptions = {}): Promise<string> {
  return (await requestCompletion(system, user, attempt, options)).content;
}

export async function completeJsonDetailed(
  system: string,
  user: string,
  attempt = 0,
  options: CompletionOptions = {}
): Promise<{ content: string; sourceUrls: string[] }> {
  const result = await requestCompletion(system, user, attempt, options);
  return { content: result.content, sourceUrls: result.sourceUrls };
}

export async function completeJsonWithUsage(
  system: string,
  user: string,
  attempt = 0,
  options: CompletionOptions = {}
): Promise<JsonCompletion> {
  const startedAt = Date.now();
  const result = await requestCompletion(system, user, attempt, options);
  return { content: result.content, ...usageOf(result.usage), sourceUrls: result.sourceUrls, elapsedMs: Date.now() - startedAt };
}
