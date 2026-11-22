import { afterEach, describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({
  openRouterKey: "test-key",
  openRouterModel: "google/gemini-4-carbon",
  openRouterFallbackModel: "",
}));

vi.mock("@/server/config", () => ({
  config: configMock,
}));

import { completeJson, completeJsonDetailed, sourceUrlsFromMessage } from "@/server/openrouter";

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
    configMock.openRouterFallbackModel = "";
    configMock.openRouterModel = "google/gemini-4-carbon";
  });

  it("asks a reasoning model for a low-effort JSON answer with an 8000 token budget and a 120s timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue(completion({ note: "готово" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeJson("system", "user")).resolves.toContain("готово");

    expect(timeout).toHaveBeenCalledWith(120_000);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.max_tokens).toBe(8000);
    expect(payload.temperature).toBe(0);
    expect(payload.reasoning).toEqual({ effort: "low", exclude: true });
    expect(payload.model).toBe("google/gemini-4-carbon");
  });

  it("logs finish_reason and usage on an empty answer and retries once when the model stops for length", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion("", "length", { total_tokens: 8000, completion_tokens: 8000 }))
      .mockResolvedValueOnce(completion({ note: "после повтора" }));
    vi.stubGlobal("fetch", fetchMock);
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(completeJson("system", "SECRET_DOCUMENT_BODY")).resolves.toContain("после повтора");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).max_tokens).toBe(8000);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).max_tokens).toBe(12000);
    expect(infoLog).toHaveBeenCalledTimes(1);
    const line = String(infoLog.mock.calls[0][0]);
    expect(line.startsWith("[openrouter] ")).toBe(true);
    expect(line).not.toContain("test-key");
    expect(line).not.toContain("SECRET_DOCUMENT_BODY");
    expect(JSON.parse(line.slice("[openrouter] ".length))).toMatchObject({
      ok: true,
      errorClass: null,
      fallback: false,
      model: "google/gemini-4-carbon",
      promptTokens: 0,
      completionTokens: 8000,
    });
  });

  it("keeps a caller token cap and returns only the pages the search tool cited", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({ candidates: [] }),
          annotations: [{ type: "url_citation", url_citation: { url: "https://vendor.example/materials" } }],
        },
        finish_reason: "stop",
      }],
    })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await completeJsonDetailed("system", "user", 0, { webSearch: true, maxTokens: 4000 });
    expect(result.sourceUrls).toEqual(["https://vendor.example/materials"]);
    expect(sourceUrlsFromMessage({
      annotations: [{ url_citation: { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "https://evil.example/materials" } }],
    })).toEqual(["https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).max_tokens).toBe(4000);
  });

  it("raises a caller token cap on the length retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion("", "length"))
      .mockResolvedValueOnce(completion(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await completeJson("system", "user", 0, { maxTokens: 4000 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).max_tokens).toBe(4000);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).max_tokens).toBe(12000);
  });

  it("does not retry a second time when the length retry is still empty", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(completion("", "length", { total_tokens: 12000 })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(completeJson("system", "user")).rejects.toThrow(/Пустой ответ модели/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps chat temperature only when the caller asks for it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion({ note: "готово" }));
    vi.stubGlobal("fetch", fetchMock);
    await completeJson("system", "user", 0, { purpose: "project-chat", temperature: 0.2 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).temperature).toBe(0.2);
  });

  it("tries the fallback model once after the primary retry fails", async () => {
    configMock.openRouterFallbackModel = "openai/gpt-4o-mini";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream", { status: 503 }))
      .mockResolvedValueOnce(new Response("upstream", { status: 503 }))
      .mockResolvedValueOnce(completion({ note: "запасная" }, "stop", { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, cost: 0.01 }));
    vi.stubGlobal("fetch", fetchMock);
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(completeJson("system", "SECRET_DOCUMENT_BODY", 0, { purpose: "package-analysis" })).resolves.toContain("запасная");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe("google/gemini-4-carbon");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).model).toBe("google/gemini-4-carbon");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).model).toBe("openai/gpt-4o-mini");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).max_tokens).toBe(8000);
    expect(infoLog).toHaveBeenCalledTimes(1);
    const line = String(infoLog.mock.calls[0][0]);
    expect(line).not.toContain("test-key");
    expect(line).not.toContain("SECRET_DOCUMENT_BODY");
    expect(line).not.toContain("upstream");
    expect(JSON.parse(line.slice("[openrouter] ".length))).toMatchObject({
      model: "openai/gpt-4o-mini",
      purpose: "package-analysis",
      ok: true,
      fallback: true,
      errorClass: null,
      promptTokens: 3,
      completionTokens: 4,
      cost: 0.01,
    });
  });

  it("does not call a fallback after a 4xx or when no fallback is configured", async () => {
    const denied = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", denied);
    vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(completeJson("system", "user")).rejects.toThrow(/401/);
    expect(denied).toHaveBeenCalledTimes(1);

    configMock.openRouterFallbackModel = "openai/gpt-4o-mini";
    const stillDenied = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", stillDenied);
    await expect(completeJson("system", "user")).rejects.toThrow(/401/);
    expect(stillDenied).toHaveBeenCalledTimes(1);

    configMock.openRouterFallbackModel = "";
    const empty = vi.fn().mockImplementation(() => Promise.resolve(completion("", "length")));
    vi.stubGlobal("fetch", empty);
    await expect(completeJson("system", "user")).rejects.toThrow(/Пустой ответ модели/);
    expect(empty).toHaveBeenCalledTimes(2);
  });
});
