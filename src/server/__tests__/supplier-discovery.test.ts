import { beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.hoisted(() => vi.fn());
vi.mock("@/server/openrouter", () => ({ completeJsonDetailed: complete }));

import { applyLiveSupplierLinks, discoverMaterialSuppliers, filterSupplierCandidates, isRedirectUrl, resolveSearchSources } from "@/server/supplier-discovery";

describe("open-source supplier discovery", () => {
  beforeEach(() => {
    complete.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });

  it("uses web search and only returns evidenced candidates with safe links", async () => {
    complete.mockResolvedValueOnce({
      content: JSON.stringify({ candidates: [
        { name: "СеверСнаб", website: "https://vendor.example", email: "sales@vendor.example", materials: ["Труба стальная"], regionEvidence: "Доставка в регион", evidence: "Поставляем трубы", sourceUrl: "https://vendor.example/materials" },
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
    const unconfirmed = JSON.stringify({ candidates: [
      { name: "Без региона", website: "https://vendor.example", materials: ["Труба стальная"], regionEvidence: "не указано в документах", evidence: "Поставляем трубы на север", sourceUrl: "https://vendor.example/materials" },
    ] });
    expect(filterSupplierCandidates(unconfirmed, resolved)).toEqual([]);
  });

  it("requires both a material and a delivery region", async () => {
    await expect(discoverMaterialSuppliers({ material: "", region: "Норильск" })).rejects.toThrow("Укажите материал и регион");
    expect(complete).not.toHaveBeenCalled();
  });
});
