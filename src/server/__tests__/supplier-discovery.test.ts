import { beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.hoisted(() => vi.fn());
vi.mock("@/server/openrouter", () => ({ completeJsonDetailed: complete }));

import { discoverMaterialSuppliers, filterSupplierCandidates } from "@/server/supplier-discovery";

describe("open-source supplier discovery", () => {
  beforeEach(() => complete.mockReset());

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

  it("requires both a material and a delivery region", async () => {
    await expect(discoverMaterialSuppliers({ material: "", region: "Норильск" })).rejects.toThrow("Укажите материал и регион");
    expect(complete).not.toHaveBeenCalled();
  });
});
