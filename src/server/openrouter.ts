import { config } from "@/server/config";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export function modelConfigured() {
  return Boolean(config.openRouterKey);
}

export async function completeJson(system: string, user: string, retryEmpty = true): Promise<string> {
  if (!config.openRouterKey) throw new Error("Ключ модели не задан");
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
      max_tokens: retryEmpty ? 1400 : 2400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: retryEmpty
          ? system
          : `${system}\nЕсли предыдущая попытка вернула пустой ответ, сформируй полный ответ сейчас. Верни непустой JSON строго по заданной схеме.` },
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
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content && retryEmpty) return completeJson(system, user, false);
  if (!content) throw new Error("Модель дважды вернула пустой ответ. Повторите анализ позже.");
  return content;
}
