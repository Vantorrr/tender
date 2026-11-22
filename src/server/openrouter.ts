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

export type LlmErrorClass =
  | "timeout"
  | "http_5xx"
  | "http_4xx"
  | "empty"
  | "invalid_json"
  | "not_configured"
  | "network"
  | "other";

export type LlmCallTelemetry = {
  at: string;
  model: string;
  purpose: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  ok: boolean;
  errorClass: LlmErrorClass | null;
  fallback: boolean;
};

type CompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  cost_details?: { upstream_inference_cost?: number };
};

export type JsonCompletion = {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  elapsedMs: number;
  sourceUrls: string[];
};

export type CompletionOptions = {
  webSearch?: boolean;
  maxTokens?: number;
  model?: string;
  /** Structured calls stay at 0. Chat may pass a small temperature. */
  temperature?: number;
  /** Short caller name for telemetry. Document text is never stored. */
  purpose?: string;
};

type UsageSink = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  sawTokens: boolean;
  sawCost: boolean;
};

type RequestOptions = CompletionOptions & {
  sink?: UsageSink;
  allowRetry?: boolean;
};

const RETRYABLE: ReadonlySet<LlmErrorClass> = new Set(["timeout", "http_5xx", "empty", "invalid_json"]);

let telemetrySink: (entry: LlmCallTelemetry) => void = () => {};

/** Registered by the DB module. Calls before the store is ready are only logged. */
export function setLlmTelemetrySink(sink: (entry: LlmCallTelemetry) => void) {
  telemetrySink = sink;
}

export class OpenRouterCallError extends Error {
  readonly errorClass: LlmErrorClass;

  constructor(message: string, errorClass: LlmErrorClass) {
    super(message);
    this.name = "OpenRouterCallError";
    this.errorClass = errorClass;
  }
}

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
      const cited = citation as { url?: unknown };
      if (typeof cited.url === "string") urls.push(cited.url);
    }
    if (typeof record.url === "string") urls.push(record.url);
  }
  return [...new Set(urls)];
}

function emptySink(): UsageSink {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, sawTokens: false, sawCost: false };
}

function costOf(usage: CompletionUsage | undefined): number | null {
  if (!usage) return null;
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) return usage.cost;
  const upstream = usage.cost_details?.upstream_inference_cost;
  if (typeof upstream === "number" && Number.isFinite(upstream)) return upstream;
  return null;
}

function addUsage(sink: UsageSink | undefined, usage: CompletionUsage | undefined) {
  if (!sink || !usage) return;
  if (typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)) {
    sink.promptTokens += usage.prompt_tokens;
    sink.sawTokens = true;
  }
  if (typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens)) {
    sink.completionTokens += usage.completion_tokens;
    sink.sawTokens = true;
  }
  if (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
    sink.totalTokens += usage.total_tokens;
    sink.sawTokens = true;
  }
  const cost = costOf(usage);
  if (cost != null) {
    sink.cost += cost;
    sink.sawCost = true;
  }
}

function errorClassOf(error: unknown): LlmErrorClass {
  if (error instanceof OpenRouterCallError) return error.errorClass;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "other";
}

function logCall(entry: LlmCallTelemetry) {
  // One line per logical call. No key, no prompt, no document text.
  console.info(`[openrouter] ${JSON.stringify({
    model: entry.model,
    purpose: entry.purpose,
    latencyMs: entry.latencyMs,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    cost: entry.cost,
    ok: entry.ok,
    errorClass: entry.errorClass,
    fallback: entry.fallback,
  })}`);
  try {
    telemetrySink(entry);
  } catch (error) {
    const reason = error instanceof Error ? error.name : "error";
    console.error(`[openrouter] telemetry persist failed: ${reason}`);
  }
}

function sinkTotals(sink: UsageSink): Pick<JsonCompletion, "promptTokens" | "completionTokens" | "totalTokens" | "cost"> {
  return {
    promptTokens: sink.sawTokens ? sink.promptTokens : null,
    completionTokens: sink.sawTokens ? sink.completionTokens : null,
    totalTokens: sink.sawTokens ? sink.totalTokens : null,
    cost: sink.sawCost ? sink.cost : null,
  };
}

async function requestCompletion(
  system: string,
  user: string,
  attempt: number,
  options: RequestOptions
): Promise<{ content: string; sourceUrls: string[] }> {
  if (!config.openRouterKey) throw new OpenRouterCallError("Ключ модели не задан", "not_configured");
  const retrying = attempt > 0;
  const model = options.model || config.openRouterModel;
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://127.0.0.1:43141",
        "X-Title": "TenderKontur",
      },
      body: JSON.stringify({
        model,
        temperature: options.temperature ?? 0,
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
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || /timeout/i.test(error.message));
    const wrapped = new OpenRouterCallError(timedOut ? "Таймаут модели" : "Нет соединения с моделью", timedOut ? "timeout" : "network");
    if (wrapped.errorClass === "timeout" && options.allowRetry !== false && attempt < 1) {
      return requestCompletion(system, user, attempt + 1, options);
    }
    throw wrapped;
  }
  if (!response.ok) {
    const detail = await response.text();
    const wrapped = new OpenRouterCallError(
      `Модель ответила ${response.status}: ${detail.slice(0, 240)}`,
      response.status >= 500 ? "http_5xx" : "http_4xx"
    );
    if (wrapped.errorClass === "http_5xx" && options.allowRetry !== false && attempt < 1) {
      return requestCompletion(system, user, attempt + 1, options);
    }
    throw wrapped;
  }
  let payload: {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> | null; refusal?: string | null; annotations?: unknown }; finish_reason?: string }>;
    usage?: CompletionUsage;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new OpenRouterCallError("Модель вернула не-JSON конверт", "other");
  }
  addUsage(options.sink, payload.usage);
  const choice = payload.choices?.[0];
  const sourceUrls = sourceUrlsFromMessage(choice?.message);
  const rawContent = choice?.message?.content;
  const content = (typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part) => part.text ?? "").join("\n")
      : "").trim();
  const finishReason = choice?.finish_reason;
  const allowRetry = options.allowRetry !== false && attempt < 1;
  if (!content) {
    if (allowRetry) return requestCompletion(system, user, attempt + 1, options);
    if (choice?.message?.refusal) throw new OpenRouterCallError(`Модель отказала в анализе: ${choice.message.refusal.slice(0, 180)}`, "other");
    throw new OpenRouterCallError(`Пустой ответ модели (finish_reason: ${finishReason ?? "не указан"}).`, "empty");
  }
  let validJson = false;
  try {
    JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    validJson = true;
  } catch {
    // Providers may stop mid-quote despite JSON mode. Retry once with a larger
    // completion budget before surfacing a confusing JSON parser error to users.
  }
  if ((!validJson || finishReason === "length") && allowRetry) {
    return requestCompletion(system, user, attempt + 1, options);
  }
  if (!validJson) throw new OpenRouterCallError(`Модель вернула неполный JSON после ${attempt + 1} попыток.`, "invalid_json");
  return { content, sourceUrls };
}

export async function completeJsonWithUsage(
  system: string,
  user: string,
  attempt = 0,
  options: CompletionOptions = {}
): Promise<JsonCompletion> {
  const startedAt = Date.now();
  const purpose = (options.purpose || "unspecified").slice(0, 80);
  const primary = options.model || config.openRouterModel;
  const fallbackModel = options.model ? "" : (config.openRouterFallbackModel || "").trim();
  const sink = emptySink();
  const emit = (model: string, ok: boolean, errorClass: LlmErrorClass | null, fallback: boolean) => {
    const totals = sinkTotals(sink);
    logCall({
      at: new Date().toISOString(),
      model,
      purpose,
      latencyMs: Date.now() - startedAt,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      cost: totals.cost,
      ok,
      errorClass,
      fallback,
    });
  };
  try {
    const result = await requestCompletion(system, user, attempt, { ...options, model: primary, sink, allowRetry: true });
    emit(primary, true, null, false);
    return { content: result.content, model: primary, ...sinkTotals(sink), sourceUrls: result.sourceUrls, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const errorClass = errorClassOf(error);
    if (RETRYABLE.has(errorClass) && fallbackModel && fallbackModel !== primary) {
      try {
        const result = await requestCompletion(system, user, 0, { ...options, model: fallbackModel, sink, allowRetry: false });
        emit(fallbackModel, true, null, true);
        return { content: result.content, model: fallbackModel, ...sinkTotals(sink), sourceUrls: result.sourceUrls, elapsedMs: Date.now() - startedAt };
      } catch (fallbackError) {
        emit(fallbackModel, false, errorClassOf(fallbackError), true);
        throw fallbackError;
      }
    }
    emit(primary, false, errorClass, false);
    throw error;
  }
}

export async function completeJson(system: string, user: string, attempt = 0, options: CompletionOptions = {}): Promise<string> {
  return (await completeJsonWithUsage(system, user, attempt, options)).content;
}

export async function completeJsonDetailed(
  system: string,
  user: string,
  attempt = 0,
  options: CompletionOptions = {}
): Promise<{ content: string; sourceUrls: string[] }> {
  const result = await completeJsonWithUsage(system, user, attempt, options);
  return { content: result.content, sourceUrls: result.sourceUrls };
}
