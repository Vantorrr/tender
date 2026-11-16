import { afterEach, expect, it, vi } from "vitest";
import { KonturProcurementSource } from "@/server/procurement-source";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("authenticates server-side and rejects masked vendor data rather than importing it", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Items: [{ Id: "IS1", OrderName: "Ремонт", NotificationNumber: "░░░" }] })));
  vi.stubGlobal("fetch", fetcher);
  const result = await new KonturProcurementSource().fetchNotices();
  expect(fetcher.mock.calls[0][1].headers["X-Kontur-Apikey"]).toBe("test-secret");
  expect(result).toMatchObject({ ok: false, stub: false, status: "error", notices: [] });
  expect(result.detail).toContain("маскирует");
  expect(JSON.stringify(result)).not.toContain("test-secret");
});

it("does not disclose a key or raw provider error in diagnostics", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("test-secret")));
  const result = await new KonturProcurementSource().fetchNotices();
  expect(result.ok).toBe(false);
  expect(result.detail).not.toContain("test-secret");
});
