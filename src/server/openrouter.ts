import { config } from "@/server/config";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export function modelConfigured() {
  return Boolean(config.openRouterKey);
}

export async function completeJson(system: string, user: string, attempt = 0): Promise<string> {
  if (!config.openRouterKey) throw new Error("Ключ модели не задан");
  const retrying = attempt > 0;
  const tokenBudgets = [4000, 6000, 8000];
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
      max_tokens: tokenBudgets[Math.min(attempt, tokenBudgets.length - 1)],
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: !retrying
          ? system
          : `${system}\nПредыдущая попытка вернула пустой или неполный ответ. Сформируй полный ответ без рассуждений вне JSON, проверь что JSON непустой и содержит обязательные поля.` },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Модель ответила ${response.status}: ${detail.slice(0, 240)}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> | null; refusal?: string | null }; finish_reason?: string }>;
  };
  const choice = payload.choices?.[0];
  const rawContent = choice?.message?.content;
  const content = (typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part) => part.text ?? "").join("\n")
      : "").trim();
  const finishReason = choice?.finish_reason;
  if (!content && attempt < tokenBudgets.length - 1) return completeJson(system, user, attempt + 1);
  if (!content) {
    if (choice?.message?.refusal) throw new Error(`Модель отказала в анализе: ${choice.message.refusal.slice(0, 180)}`);
    throw new Error(`Модель вернула пустой ответ после ${attempt + 1} попыток (finish_reason: ${finishReason ?? "не указан"}).`);
  }
  let validJson = false;
  try {
    JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    validJson = true;
  } catch {
    // Providers may stop mid-quote despite JSON mode. Retry once with a larger
    // completion budget before surfacing a confusing JSON parser error to users.
  }
  if ((!validJson || finishReason === "length") && attempt < tokenBudgets.length - 1) return completeJson(system, user, attempt + 1);
  if (!validJson) throw new Error(`Модель вернула неполный JSON после ${attempt + 1} попыток.`);
  return content;
}
