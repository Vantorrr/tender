import { afterEach, describe, expect, it, vi } from "vitest";
import "./setup";
import { config } from "@/server/config";
import { closeDb, ensureReady, healthSnapshot, integrationSnapshot, llmTelemetryView } from "@/server/db";
import { completeJson } from "@/server/openrouter";

function completion(body: unknown, usage?: Record<string, number>) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(body) }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  }));
}

describe("llm telemetry", () => {
  afterEach(() => {
    config.openRouterKey = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    closeDb();
  });

  it("stores a rolling call and today's totals without the key or the document text", async () => {
    ensureReady();
    config.openRouterKey = "telemetry-secret-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ note: "готово" }, { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13, cost: 0.02 }))
      .mockImplementation(() => Promise.resolve(new Response("down", { status: 502 })));
    vi.stubGlobal("fetch", fetchMock);
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(completeJson("system", "ТЕКСТ ДОКУМЕНТА НЕ ЛОГИРОВАТЬ", 0, { purpose: "package-analysis" })).resolves.toContain("готово");
    await expect(completeJson("system", "ТЕКСТ ДОКУМЕНТА НЕ ЛОГИРОВАТЬ", 0, { purpose: "model-note" })).rejects.toThrow(/502/);

    const view = llmTelemetryView();
    expect(view.today.calls).toBe(2);
    expect(view.today.promptTokens).toBe(8);
    expect(view.today.completionTokens).toBe(5);
    expect(view.today.cost).toBeCloseTo(0.02);
    expect(view.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(view.lastError).toMatchObject({ errorClass: "http_5xx", purpose: "model-note", model: config.openRouterModel });

    const admin = integrationSnapshot();
    expect(admin.llm.configured).toBe(true);
    expect(admin.llm.model).toBe(config.openRouterModel);
    expect(admin.llm.fallbackModel).toBeNull();
    expect(admin.llm.today.calls).toBe(2);
    expect(admin.llm.lastError?.errorClass).toBe("http_5xx");

    const health = healthSnapshot() as { llm: Record<string, unknown> };
    expect(health.llm.configured).toBe(true);
    expect(health.llm.model).toBeUndefined();
    expect(health.llm.fallbackModel).toBeUndefined();

    const dumped = `${JSON.stringify(view)}\n${infoLog.mock.calls.map((call) => String(call[0])).join("\n")}`;
    expect(dumped).not.toContain("telemetry-secret-key");
    expect(dumped).not.toContain("ТЕКСТ ДОКУМЕНТА");
    expect(dumped).not.toContain("down");
    expect(infoLog.mock.calls).toHaveLength(2);
    expect(String(infoLog.mock.calls[0][0]).startsWith("[openrouter] ")).toBe(true);
  });
});
