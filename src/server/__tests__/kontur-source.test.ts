import { afterEach, expect, it, vi } from "vitest";
import { KonturProcurementSource, validateKonturSearchFilters } from "@/server/procurement-source";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("authenticates server-side and rejects masked vendor data rather than importing it", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Items: [{ Id: "IS1", OrderName: "Ремонт", NotificationNumber: "░░░" }] })));
  vi.stubGlobal("fetch", fetcher);
  const result = await new KonturProcurementSource().fetchNotices();
  expect(fetcher.mock.calls[0][1].headers["X-Kontur-Apikey"]).toBe("test-secret");
  expect(result).toMatchObject({ ok: false, stub: false, status: "error", notices: [] });
  expect(result.detail).toContain("замаскированные");
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

it("uses the official search filter schema and maps fields from Kontur search results", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  const filters = {
    DateTimeFrom: "2026-11-01T00:00:00.000Z",
    DateTimeTo: "2026-11-16T23:59:59.999Z",
    Text: ["ремонт", "трубопровод"],
    Laws: [1, 2],
    Procedures: [0, 3],
    RegionIds: ["80"],
    PurchaseStatuses: [1],
    MaxPriceFrom: 100000,
    MaxPriceTo: 5000000,
    ApplicationDeadlineFrom: "2026-11-16T00:00:00.000Z",
    StrictSearch: true,
    Attachments: true,
    PageNumber: 2,
  };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    TotalCount: 51,
    Items: [{
      Id: "kontur-id-1",
      NotificationNumber: "0123456789012345",
      OrderName: "Ремонт трубопровода",
      Currency: "RUB",
      MaxPrice: 2500000,
      Customers: [{ FullName: "Заказчик", Inn: "1234567890" }],
      DeliveryPlaces: ["Ямало-Ненецкий АО"],
      ApplicationDeadline: "2026-11-25T10:00:00Z",
      Link: "https://zakupki.kontur.ru/purchase-1",
      IsCancelled: false,
    }],
  })));
  vi.stubGlobal("fetch", fetcher);
  const result = await new KonturProcurementSource().search(validateKonturSearchFilters(filters));
  expect(fetcher.mock.calls[0][1].headers).toMatchObject({
    "X-Kontur-Apikey": "test-secret",
    "Content-Type": "application/json-patch+json",
  });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(filters);
  expect(result).toMatchObject({
    ok: true,
    page: 2,
    totalCount: 51,
    items: [{
      id: "kontur-id-1",
      number: "0123456789012345",
      title: "Ремонт трубопровода",
      customer: "Заказчик",
      region: "Ямало-Ненецкий АО",
      nmck: 2500000,
      deadline: "2026-11-25T10:00:00Z",
      link: "https://zakupki.kontur.ru/purchase-1",
    }],
  });
});

it("validates date, enum, and price-range filters before sending a paid request", () => {
  const base = { DateTimeFrom: "2026-11-01T00:00:00Z", DateTimeTo: "2026-11-16T00:00:00Z" };
  expect(() => validateKonturSearchFilters({ ...base, Laws: [4] })).toThrow("Laws");
  expect(() => validateKonturSearchFilters({ ...base, MaxPriceFrom: 500, MaxPriceTo: 10 })).toThrow("Цена");
  expect(() => validateKonturSearchFilters({ ...base, DateTimeFrom: "bad date" })).toThrow("дата");
  expect(() => validateKonturSearchFilters({ ...base, Typo: true })).toThrow("Неизвестный фильтр");
  expect(() => validateKonturSearchFilters({ ...base, PageNumber: 200 })).toThrow("PageNumber");
});

it("loads one selected purchase detail and keeps only HTTPS source documents", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    Id: "purchase/id",
    NotificationNumber: "44-123",
    Title: "Ремонт объекта",
    Organizer: { FullName: "Заказчик" },
    InitialSum: { Price: 750000, Currency: "RUB" },
    ApplicationDeadline: "2026-12-01T00:00:00Z",
    Link: "https://zakupki.kontur.ru/purchase/id",
    Docs: [
      { FileName: "ТЗ.pdf", Url: "https://files.example.org/tz.pdf" },
      { FileName: "bad.url", Url: "javascript:alert(1)" },
    ],
  })));
  vi.stubGlobal("fetch", fetcher);
  const result = await new KonturProcurementSource().purchaseDetails("purchase/id");
  expect(fetcher.mock.calls[0][0]).toBe("https://api-zakupki.kontur.ru/external/v1/purchases/purchase%2Fid");
  expect(fetcher.mock.calls[0][1].headers["X-Kontur-Apikey"]).toBe("test-secret");
  expect(result).toMatchObject({
    ok: true,
    purchase: {
      externalId: "purchase/id",
      number: "44-123",
      title: "Ремонт объекта",
      customer: "Заказчик",
      nmck: 750000,
      attachments: [{ name: "ТЗ.pdf", url: "https://files.example.org/tz.pdf" }],
    },
  });
  expect(JSON.stringify(result)).not.toContain("test-secret");
});

it("explains missing purchase permission and masked details without leaking data", async () => {
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response("", { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ Title: "░░░" })));
  vi.stubGlobal("fetch", fetcher);
  const source = new KonturProcurementSource();
  expect((await source.purchaseDetails("id")).detail).toContain("группа purchase");
  expect((await source.purchaseDetails("id")).detail).toContain("тестовый API-ключ");
});
