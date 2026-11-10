import { describe, expect, it } from "vitest";
import { validateCalcCompareAiResult } from "@/server/calc-compare-ai";

describe("validateCalcCompareAiResult", () => {
  const rows = [
    {
      rowId: "row-1",
      factsText: "Код: 01; Позиция: Монтаж труб; Ставка заказчика: 100; Ставка черновика: 120",
    },
  ];

  it("keeps only findings tied to an exact source excerpt and filters model numbers", () => {
    const result = validateCalcCompareAiResult(
      JSON.stringify({
        summary: "Проверьте отличия ставок между двумя сметами.",
        findings: [
          {
            rowId: "row-1",
            text: "Ставки требуют сверки по исходным основаниям.",
            sourceExcerpt: "Ставка заказчика: 100; Ставка черновика: 120",
          },
          {
            rowId: "row-1",
            text: "Разница составляет 20 процентов.",
            sourceExcerpt: "Ставка заказчика: 100; Ставка черновика: 120",
          },
          {
            rowId: "row-2",
            text: "Проверьте позицию.",
            sourceExcerpt: "Ставка заказчика: 100",
          },
          {
            rowId: "row-1",
            text: "Проверьте позицию.",
            sourceExcerpt: "Модель придумала основание",
          },
        ],
      }),
      rows
    );
    expect(result.summary).toBe("Проверьте отличия ставок между двумя сметами.");
    expect(result.findings).toEqual([
      {
        rowId: "row-1",
        text: "Ставки требуют сверки по исходным основаниям.",
        sourceExcerpt: "Ставка заказчика: 100; Ставка черновика: 120",
      },
    ]);
  });

  it("replaces numeric model prose so the model cannot change quoted calculations", () => {
    const result = validateCalcCompareAiResult(
      JSON.stringify({ summary: "Разница равна 20 рублям.", findings: [] }),
      rows
    );
    expect(result.summary).toContain("не сформировала");
  });
});
