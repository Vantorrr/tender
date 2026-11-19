import { describe, expect, it, vi } from "vitest";

const modelInputs = vi.hoisted(() => ({ users: [] as string[] }));
vi.mock("@/server/openrouter", () => ({
  completeJson: vi.fn(async (_system: string, user: string) => {
    modelInputs.users.push(user);
    return JSON.stringify({ summary: "Проверьте основания сопоставления.", findings: [] });
  }),
}));

import { analyzeCalculationComparisonWithAI, groupCompareRows, validateCalcCompareAiResult, ensureCompareSummary } from "@/server/calc-compare-ai";
import type { Calculation } from "@/lib/types";

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

describe("grouped comparison", () => {
  it("merges repeated lines of one position and states the estimate total", () => {
    const groups = groupCompareRows([
      { rowId: "row-16", name: "Бурение скважин диаметром 450 мм", unit: "м", section: "Раздел 1", status: "diff", factsText: "Позиция: Бурение скважин диаметром 450 мм; Разница: -100", originalSum: 200, draftSum: 100, deltaSum: -100 },
      { rowId: "row-17", name: "Бурение скважин диаметром 450 мм", unit: "м", section: "Раздел 1", status: "diff", factsText: "Позиция: Бурение скважин диаметром 450 мм; Разница: -40", originalSum: 80, draftSum: 40, deltaSum: -40 },
      { rowId: "row-27", name: "Долото трёхшарошечное", unit: "шт", section: "Раздел 2", status: "diff", factsText: "Позиция: Долото трёхшарошечное; Разница: -10", originalSum: 30, draftSum: 20, deltaSum: -10 },
      { rowId: "row-28", name: "Долото трёхшарошечное", unit: "шт", section: "Раздел 2", status: "diff", factsText: "Позиция: Долото трёхшарошечное; Разница: -5", originalSum: 15, draftSum: 10, deltaSum: -5 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.rowIds.includes("row-16"))).toMatchObject({ impact: -140, rowIds: ["row-16", "row-17"] });
    expect(groups.find((group) => group.rowIds.includes("row-27"))?.rowIds).toEqual(["row-27", "row-28"]);
    expect(ensureCompareSummary("Проверьте ставки.", -172204022.31)).toMatch(/^Черновик дешевле сметы заказчика на 172/);
    expect(ensureCompareSummary("172 204 022,31", -172204022.31)).toMatch(/^Черновик дешевле/);
    const alreadyNamed = "Черновик дешевле сметы заказчика на 172 204 022,31 руб., потому что ставки ниже.";
    expect(ensureCompareSummary(alreadyNamed, -172204022.31).match(/Черновик дешевле/gu)).toHaveLength(1);
    expect(ensureCompareSummary(alreadyNamed, -172204022.31, ["Монтаж металлоконструкций"])).toContain("Только в черновике: Монтаж металлоконструкций");
    const sized = groupCompareRows([
      { rowId: "a", name: "Труба стальная 108", unit: "м", section: "Раздел 1", status: "diff", factsText: "Позиция: Труба стальная 108", originalSum: 10, draftSum: 8, deltaSum: -2 },
      { rowId: "b", name: "Труба стальная 159", unit: "м", section: "Раздел 1", status: "diff", factsText: "Позиция: Труба стальная 159", originalSum: 12, draftSum: 9, deltaSum: -3 },
    ]);
    expect(sized).toHaveLength(2);
  });

  it("does not let one group reuse numbers from another group", () => {
    const result = validateCalcCompareAiResult(
      JSON.stringify({
        summary: "Проверьте ставки.",
        findings: [{ rowId: "row-1", text: "Разница 999 руб.", sourceExcerpt: "Позиция: Труба" }],
      }),
      [{ rowId: "row-1", factsText: "Позиция: Труба; Разница: -2" }],
      { summaryCorpus: "Проверьте ставки. 999", sharedFacts: "Накладные: 43% от прямых затрат." }
    );
    expect(result.findings).toEqual([]);
  });
});

describe("full estimate AI coverage", () => {
  it("sends every comparison row in consecutive batches and reports full coverage", async () => {
    modelInputs.users.length = 0;
    const positions = Array.from({ length: 161 }, (_, index) => ({
      id: `pos-${index + 1}`,
      code: `CODE-${index + 1}`,
      name: `Строительная работа ${index + 1}`,
      unit: "м²",
      quantity: index + 1,
      rate: 100,
    }));
    const makeCalculation = (id: string): Calculation => ({
      id,
      orgId: "org-test",
      procurementId: "proc-test",
      title: id,
      status: "v_rabote",
      positions,
      assumptions: [],
      scenario: "bazovyy",
      scenarioFactor: 1,
      participateDecision: null,
      directoryVersionId: "dir-test",
      version: 1,
      authorId: "u-test",
      updatedAt: "2026-11-11T00:00:00.000Z",
      kind: id === "original" ? "customer_original" : "resource_draft",
    });

    const report = await analyzeCalculationComparisonWithAI(
      makeCalculation("original"),
      makeCalculation("draft")
    );

    expect(modelInputs.users).toHaveLength(1);
    const payload = JSON.parse(modelInputs.users[0] ?? "{}") as {
      coverage: { rowsTotal: number; groupsInDetail: number };
      sections: Array<{ rowCount: number }>;
      materialGroups: unknown[];
    };
    expect(payload.coverage.rowsTotal).toBe(161);
    expect(payload.materialGroups.length).toBeLessThanOrEqual(12);
    expect(payload.sections.reduce((sum, section) => sum + section.rowCount, 0)).toBe(161);
    expect(report).toMatchObject({ rowsAnalyzed: 161, rowsTotal: 161, batches: 1 });
  });
});
