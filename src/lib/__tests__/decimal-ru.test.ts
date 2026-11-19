import { describe, expect, it } from "vitest";
import { aiFailureBannerText } from "@/lib/ai-status";
import { parseDecimalRu } from "@/lib/decimal-ru";

describe("parseDecimalRu", () => {
  it("accepts a Russian comma decimal and rejects junk", () => {
    expect(parseDecimalRu("1,5")).toBe(1.5);
    expect(parseDecimalRu("1 000,25")).toBe(1000.25);
    expect(parseDecimalRu("")).toBe(0);
    expect(parseDecimalRu("-1")).toBeNull();
    expect(parseDecimalRu("много")).toBeNull();
  });
});

describe("aiFailureBannerText", () => {
  it("shortens the persisted status for the banner", () => {
    expect(aiFailureBannerText("ИИ-анализ не выполнен: Пустой ответ модели")).toBe(
      "ИИ не выполнен: Пустой ответ модели"
    );
  });
});
