import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/config", () => ({
  config: {
    openRouterKey: "test-key",
    openRouterModel: "google/gemini-4-carbon",
  },
}));

import { completeJson } from "@/server/openrouter";

function completion(body: unknown, finishReason = "stop", usage: Record<string, number> | null = null) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof body === "string" ? body : JSON.stringify(body) }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }));
}

describe("completeJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks a reasoning model for a low-effort JSON answer with an 8000 token budget and a 120s timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue(completion({ note: "готово" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeJson("system", "user")).resolves.toContain("готово");

    expect(timeout).toHaveBeenCalledWith(120_000);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.max_tokens).toBe(8000);
    expect(payload.reasoning).toEqual({ effort: "low", exclude: true });
    expect(payload.model).toBe("google/gemini-4-carbon");
  });

  it("logs finish_reason and usage on an empty answer and retries once when the model stops for length", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion("", "length", { total_tokens: 8000, completion_tokens: 8000 }))
      .mockResolvedValueOnce(completion({ note: "после повтора" }));
    vi.stubGlobal("fetch", fetchMock);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(completeJson("system", "user")).resolves.toContain("после повтора");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).max_tokens).toBe(8000);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).max_tokens).toBe(12000);
    expect(errorLog).toHaveBeenCalledWith("[openrouter] empty completion", expect.objectContaining({
      finish_reason: "length",
      usage: { total_tokens: 8000, completion_tokens: 8000 },
      attempt: 0,
    }));
  });

  it("does not retry a second time when the length retry is still empty", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(completion("", "length", { total_tokens: 12000 })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(completeJson("system", "user")).rejects.toThrow(/Пустой ответ модели/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
