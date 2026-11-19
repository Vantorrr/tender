import { beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.hoisted(() => vi.fn());
vi.mock("@/server/openrouter", () => ({ completeJsonDetailed: complete }));

import { applyLiveSupplierLinks, discoverMaterialSuppliers, filterSupplierCandidates, groundSupplierRegions, isRedirectUrl, probeSupplierUrl, resolveSearchSources } from "@/server/supplier-discovery";

describe("open-source supplier discovery", () => {
  beforeEach(() => {
    complete.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>Доставка в Норильск за 5 дней</p>", { status: 200 })));
  });

  it("uses web search and only returns evidenced candidates with safe links", async () => {
    complete.mockResolvedValueOnce({
      content: JSON.stringify({ candidates: [
        { name: "СеверСнаб", website: "https://vendor.example", email: "sales@vendor.example", materials: ["Труба стальная"], regionEvidence: "Доставка в Норильск", evidence: "Поставляем трубы", sourceUrl: "https://vendor.example/materials" },
        { name: "Без источника", website: "javascript:alert(1)", materials: ["Трубы"], regionEvidence: "", evidence: "Поставляем", sourceUrl: "javascript:alert(1)" },
        { name: "Выдуманный", website: "https://invented.example", materials: ["Долото"], regionEvidence: "Норильск", evidence: "Поставляем долота на север", sourceUrl: "https://invented.example/bit" },
        { name: "Пустое доказательство", website: "https://vendor2.example", materials: ["Песок"], evidence: "", sourceUrl: "https://vendor2.example/about" },
      ] }),
      sourceUrls: ["https://vendor.example/materials"],
    });

    await expect(discoverMaterialSuppliers({ material: "Труба стальная", region: "Норильск", work: "Монтаж" })).resolves.toEqual([
      expect.objectContaining({ name: "СеверСнаб", email: "sales@vendor.example", sourceUrl: "https://vendor.example/materials" }),
    ]);
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("web search"), expect.stringContaining("Норильск"), 0, { webSearch: true });
  });

  it("returns an empty list when the search produced no pages", () => {
    const raw = JSON.stringify({ candidates: [
      { name: "СеверСнаб", website: "https://vendor.example", materials: ["Труба"], regionEvidence: "Дудинка", evidence: "Поставляем трубы", sourceUrl: "https://vendor.example/materials" },
    ] });
    expect(filterSupplierCandidates(raw, [])).toEqual([]);
  });

  it("unwraps a vertex grounding redirect and substitutes a missing candidate page", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("vertexaisearch")) {
        return new Response(null, { status: 302, headers: { location: "https://vendor.example/materials" } });
      }
      return new Response("no", { status: 404 });
    });
    const resolved = await resolveSearchSources([redirect, "https://vendor.example/materials"], { fetchImpl, cache: new Map() });
    expect(resolved).toEqual(["https://vendor.example/materials"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(isRedirectUrl("https://evil.example/grounding-api-redirect/abc")).toBe(false);
    const foreign = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/catalog" } }));
    await expect(resolveSearchSources(["https://evil.example/grounding-api-redirect/abc"], { fetchImpl: foreign, cache: new Map() })).resolves.toEqual(["https://evil.example/grounding-api-redirect/abc"]);
    expect(foreign).not.toHaveBeenCalled();
    const again = await resolveSearchSources([redirect], { fetchImpl, cache: new Map([[redirect, "https://vendor.example/materials"]]) });
    expect(again).toEqual(["https://vendor.example/materials"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const raw = JSON.stringify({ candidates: [
      { name: "СеверСнаб", website: "https://vendor.example", materials: ["Труба стальная"], regionEvidence: "Дудинка", evidence: "Поставляем трубы на север", sourceUrl: "https://vendor.example/missing" },
      { name: "Чужой", website: "https://other.example", materials: ["Труба"], regionEvidence: "Норильск", evidence: "Поставляем трубы на север", sourceUrl: "https://other.example/pipe" },
    ] });
    const kept = await applyLiveSupplierLinks(
      filterSupplierCandidates(raw, resolved),
      resolved,
      async (url) => url.includes("/missing") ? "missing" : "ok"
    );
    expect(kept).toEqual([
      expect.objectContaining({ name: "СеверСнаб", sourceUrl: "https://vendor.example/materials" }),
    ]);
    const dropped = await applyLiveSupplierLinks(
      filterSupplierCandidates(raw, resolved),
      resolved,
      async () => "missing"
    );
    expect(dropped).toEqual([]);
    const down = await applyLiveSupplierLinks(
      filterSupplierCandidates(raw, resolved),
      resolved,
      async () => "down"
    );
    expect(down).toEqual([]);
    const unconfirmed = JSON.stringify({ candidates: [
      { name: "Без региона", website: "https://vendor.example", materials: ["Труба стальная"], regionEvidence: "не указано в документах", evidence: "Поставляем трубы на север", sourceUrl: "https://vendor.example/materials" },
    ] });
    expect(filterSupplierCandidates(unconfirmed, resolved)).toEqual([]);
    const vagueRegion = JSON.stringify({ candidates: [
      { name: "Помбур", website: "https://vendor.example", materials: ["Долото"], regionEvidence: "северные регионы", evidence: "Продажа долот", sourceUrl: "https://vendor.example/materials" },
      { name: "Енисей-Норд", website: "https://vendor.example", materials: ["Труба"], regionEvidence: "Норильск", evidence: "Перевозка грузов в Норильск", sourceUrl: "https://vendor.example/materials" },
      { name: "Грузовой экспресс", website: "https://vendor.example", materials: ["Оборудование"], regionEvidence: "Дудинка", evidence: "Транспортная компания, доставка на Таймыр", sourceUrl: "https://vendor.example/materials" },
      { name: "Склад Севера", website: "https://vendor.example", materials: ["Труба стальная"], regionEvidence: "Красноярский край, отгрузка в Норильск", evidence: "Продажа труб со склада", sourceUrl: "https://vendor.example/materials" },
      { name: "СеверСнаб", website: "https://vendor.example", email: "sales@vendor.example", materials: ["Труба стальная"], regionEvidence: "Норильск", evidence: "Поставляем трубы, перевозка в Норильск", sourceUrl: "https://vendor.example/materials" },
      { name: "НордСталь", website: "https://vendor.example", email: "steel@vendor.example", materials: ["Труба"], regionEvidence: "Дудинка", evidence: "Поставщик труб, логистика до Дудинки", sourceUrl: "https://vendor.example/materials" },
    ] });
    expect(filterSupplierCandidates(vagueRegion, resolved).map((item) => item.name)).toEqual(["Склад Севера", "СеверСнаб", "НордСталь"]);
  });

  it("quotes the region from the source page and drops a page that does not name it", async () => {
    const candidates = filterSupplierCandidates(JSON.stringify({ candidates: [
      { name: "Горное дело", website: "https://gorndelo.ru", materials: ["Труба"], regionEvidence: "Норильск, 8-14 дней", evidence: "Продажа труб", sourceUrl: "https://gorndelo.ru/catalog" },
      { name: "Экспотех", website: "https://po-expotech.ru", materials: ["Насос"], regionEvidence: "Дудинка", evidence: "Поставка насосов", sourceUrl: "https://po-expotech.ru/" },
    ] }), ["https://gorndelo.ru/catalog", "https://po-expotech.ru/"]);
    let gorndeloReads = 0;
    const grounded = await groundSupplierRegions(candidates, async (url) => {
      if (String(url).includes("gorndelo")) {
        gorndeloReads += 1;
        if (gorndeloReads === 1) return new Response("temporary", { status: 503 });
        return new Response("<p>Норильск – 5 дней</p>", { status: 200 });
      }
      return new Response("<p>Каталог оборудования</p>", { status: 200 });
    });
    expect(grounded.map((item) => item.name)).toEqual(["Горное дело"]);
    expect(grounded[0]?.regionEvidence).toContain("5 дней");
    expect(grounded[0]?.regionEvidence).not.toContain("8-14");
    const down = await groundSupplierRegions(candidates.slice(0, 1), async () => new Response("down", { status: 502 }));
    expect(down).toEqual([]);
  });

  it("drops a page that stays on 500 and quotes the page text verbatim", async () => {
    const catalog = "https://geo-mining.ru/catalog/burovoy-instrument/sharoshechnye-dolota";
    let reads = 0;
    const probe = await probeSupplierUrl(catalog, async () => {
      reads += 1;
      return new Response("unavailable", { status: 500 });
    });
    expect(probe).toBe("down");
    expect(reads).toBe(2);
    const page = "<p>Труба есть на складе в Норильске круглый год.</p>";
    const kept = await groundSupplierRegions([
      { name: "РусМет", website: "https://rusmet.example", materials: ["Труба"], regionEvidence: "Склад в Норильске", evidence: "Продажа труб", sourceUrl: "https://rusmet.example/sklad" },
    ], async () => new Response(page, { status: 200 }));
    expect(kept).toHaveLength(1);
    expect(page).toContain(kept[0]!.regionEvidence);
    expect(kept[0]!.regionEvidence).toContain("на складе в Норильске");
    expect(kept[0]!.regionEvidence).not.toBe("Склад в Норильске");
    const failed = await groundSupplierRegions([
      { name: "Геомайнинг", website: "https://geo-mining.ru", materials: ["Долото"], regionEvidence: "Норильск", evidence: "Продажа долот", sourceUrl: catalog },
    ], async () => new Response("unavailable", { status: 500 }));
    expect(failed).toEqual([]);
    const calls: string[] = [];
    const redirected = await groundSupplierRegions([
      { name: "Открытый редирект", website: "https://vendor.example", materials: ["Труба"], regionEvidence: "Норильск", evidence: "Продажа труб", sourceUrl: "https://vendor.example/go" },
    ], async (url) => {
      calls.push(String(url));
      if (String(url).includes("127.0.0.1")) return new Response("склад в Норильске", { status: 200 });
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/latest" } });
    });
    expect(redirected).toEqual([]);
    expect(calls.some((url) => url.includes("127.0.0.1"))).toBe(false);
    for (const location of ["http://2130706433/latest", "http://[::ffff:127.0.0.1]/latest", "http://[::ffff:169.254.169.254]/latest"]) {
      const hidden: string[] = [];
      const dropped = await groundSupplierRegions([
        { name: "Обход", website: "https://vendor.example", materials: ["Труба"], regionEvidence: "Норильск", evidence: "Продажа труб", sourceUrl: "https://vendor.example/go" },
      ], async (url) => {
        hidden.push(String(url));
        if (String(url).includes("vendor.example")) return new Response(null, { status: 302, headers: { location } });
        return new Response("склад в Норильске", { status: 200 });
      });
      expect(dropped).toEqual([]);
      expect(hidden.every((url) => url.includes("vendor.example"))).toBe(true);
    }
    const followed = await groundSupplierRegions([
      { name: "Склад", website: "https://shop.example", materials: ["Труба"], regionEvidence: "Норильск", evidence: "Продажа труб", sourceUrl: "https://shop.example/go" },
    ], async (url) => {
      if (String(url).endsWith("/go")) return new Response(null, { status: 302, headers: { location: "https://shop.example/sklad" } });
      return new Response("<p>Труба есть на складе в Норильске.</p>", { status: 200 });
    });
    expect(followed[0]?.regionEvidence).toContain("на складе в Норильске");
  });

  it("requires both a material and a delivery region", async () => {
    await expect(discoverMaterialSuppliers({ material: "", region: "Норильск" })).rejects.toThrow("Укажите материал и регион");
    expect(complete).not.toHaveBeenCalled();
  });
});
