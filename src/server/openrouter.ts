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
};

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
  options: { webSearch?: boolean }
): Promise<{ content: string; usage: CompletionUsage | undefined }> {
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
      model: config.openRouterModel,
      temperature: 0.2,
      max_tokens: retrying ? RETRY_MAX_TOKENS : PRIMARY_MAX_TOKENS,
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
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> | null; refusal?: string | null }; finish_reason?: string }>;
    usage?: CompletionUsage;
  };
  const choice = payload.choices?.[0];
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
  return { content, usage: payload.usage };
}

export async function completeJson(system: string, user: string, attempt = 0, options: { webSearch?: boolean } = {}): Promise<string> {
  return (await requestCompletion(system, user, attempt, options)).content;
}

export async function completeJsonWithUsage(
  system: string,
  user: string,
  attempt = 0,
  options: { webSearch?: boolean } = {}
): Promise<JsonCompletion> {
  const startedAt = Date.now();
  const result = await requestCompletion(system, user, attempt, options);
  return { content: result.content, ...usageOf(result.usage), elapsedMs: Date.now() - startedAt };
}
