import { config } from "@/server/config";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export function modelConfigured() {
  return Boolean(config.openRouterKey);
}

export async function completeJson(system: string, user: string): Promise<string> {
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
      max_tokens: 1400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
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
  if (!content) throw new Error("Пустой ответ модели");
  return content;
}
