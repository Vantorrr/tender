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

it("loads remaining pages, deduplicates IDs and records the verified result", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  const notice = (Id: string) => ({ Id, OrderName: "Ремонт трубопровода", Currency: "RUB", MaxPrice: 1000, Customers: [{ FullName: "АО Заказчик" }] });
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ TotalCount: 3, Items: [notice("A"), notice("B")] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ TotalCount: 3, Items: [notice("B"), notice("C")] })));
  vi.stubGlobal("fetch", fetcher);
  const source = new KonturProcurementSource();
  const result = await source.fetchNotices();
  expect(result.ok).toBe(true);
  expect(result.notices.map((item) => item.number)).toEqual(["A", "B", "C"]);
  expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body).PageNumber)).toEqual([0, 1]);
  expect(source.lastResult).toBe(result);
  expect(result.detail).toContain("Все страницы");
});

it("reports a bounded partial result rather than claiming all purchases were loaded", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  vi.stubEnv("KONTUR_MAX_PAGES", "1");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ TotalCount: 1000, Items: [{ Id: "A", OrderName: "Ремонт" }] })));
  vi.stubGlobal("fetch", fetcher);
  const result = await new KonturProcurementSource().fetchNotices();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.detail).toContain("Выборка неполная");
});

it("does not import partially collected pages if the next page is masked", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ TotalCount: 2, Items: [{ Id: "A", OrderName: "Ремонт" }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ TotalCount: 2, Items: [{ Id: "B", OrderName: "░░░" }] })));
  vi.stubGlobal("fetch", fetcher);
  const source = new KonturProcurementSource();
  expect(await source.fetchNotices()).toMatchObject({ ok: false, notices: [], status: "error" });
  expect(source.lastResult?.status).toBe("error");
});
