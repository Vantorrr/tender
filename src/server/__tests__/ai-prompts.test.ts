import { describe, expect, it } from "vitest";
import { numbersAreGrounded } from "@/server/ai-grounding";
import {
  CALC_COMPARE_SYSTEM,
  MODEL_NOTE_SYSTEM,
  PRODUCTION_VARIANCE_SYSTEM,
  PROJECT_ANALYSIS_SYSTEM,
  PROJECT_CHAT_SYSTEM,
  SUPPLIER_DISCOVERY_SYSTEM,
  formatSourceLocation,
} from "@/server/ai-prompts";
import { scoreModelResponse } from "@/server/ai-prompt-score";
import { buildModelNoteUserContent, noteRejectionReason, omitUnsourcedPlaces, requireSourceCells } from "@/server/model-note";
import { citationForModel, parseProjectAnalysisResult, sanitizeCustomerQuestions, validateProjectEvidence } from "@/server/project-analysis-ai";
import { validateCalcCompareAiResult, pricingTextForCompare } from "@/server/calc-compare-ai";
import { validateProductionVarianceResult } from "@/server/production-variance-ai";
import type { Calculation } from "@/lib/types";

const PROMPTS = [
  MODEL_NOTE_SYSTEM,
  PROJECT_ANALYSIS_SYSTEM,
  PROJECT_CHAT_SYSTEM,
  CALC_COMPARE_SYSTEM,
  PRODUCTION_VARIANCE_SYSTEM,
  SUPPLIER_DISCOVERY_SYSTEM,
];

describe("estimator prompts", () => {
  it("gives every prompt the northern estimator role and forbids invented figures", () => {
    for (const prompt of PROMPTS) {
      expect(prompt).toContain("ведущий сметчик");
      expect(prompt).toContain("не указано в документах");
      expect(prompt).toContain("Норильск");
    }
  });

  it("keeps the JSON keys the parsers already read", () => {
    expect(MODEL_NOTE_SYSTEM).toContain('"note"');
    expect(PROJECT_ANALYSIS_SYSTEM).toContain('"recommendation"');
    expect(PROJECT_ANALYSIS_SYSTEM).toContain('"citationIds"');
    expect(PROJECT_ANALYSIS_SYSTEM).toContain('"customerQuestions"');
    expect(PROJECT_ANALYSIS_SYSTEM).toContain("guarantees");
    expect(PROJECT_CHAT_SYSTEM).toContain('"outOfScope"');
    expect(PROJECT_CHAT_SYSTEM).toContain('"sourceId"');
    expect(CALC_COMPARE_SYSTEM).toContain('"sourceExcerpt"');
    expect(CALC_COMPARE_SYSTEM).toContain("pricingText");
    expect(PRODUCTION_VARIANCE_SYSTEM).toContain('"sourceQuote"');
    expect(SUPPLIER_DISCOVERY_SYSTEM).toContain("Перевозчика");
    expect(PROJECT_ANALYSIS_SYSTEM).toContain("НР Свайные работы");
    expect(MODEL_NOTE_SYSTEM).toContain("cells");
  });

  it("puts the file name and page into the model-note payload", () => {
    const payload = buildModelNoteUserContent(
      { kind: "local-estimate", fileName: "ЛС-02-бурение.xlsx", zone: "5" },
      [{ id: "h1", text: "Зона 5", reason: "из шапки", severity: "info", page: 3 }],
      [{ id: "c1", text: "Зона 5. Районный коэффициент не приведён.", page: 3, sourceFile: "ЛС-02-бурение.xlsx" }]
    );
    expect(payload).toContain("ЛС-02-бурение.xlsx");
    expect(payload).toContain("стр. 3");
    expect(payload).toContain("Районный коэффициент не приведён");
  });

  it("labels a package citation with the file and page", () => {
    expect(citationForModel({
      id: "c-ocr-p2-1",
      text: "Оплата после акта в течение 30 дней.",
      page: 2,
      sourceFile: "договор.pdf",
    }).location).toBe("договор.pdf, стр. 2");
    expect(formatSourceLocation({ sourceFile: "смета.xlsx", sheet: "ЛС", cell: "A12" })).toBe("смета.xlsx, лист ЛС, A12");
    expect(formatSourceLocation({ sourceFile: "смета.xlsx", sheet: "ЛС", page: 1 })).toBe("смета.xlsx, лист ЛС");
    expect(omitUnsourcedPlaces("Коэффициент стеснённости, стр. 1, ячейка A1. Чертёж L2, ISO9001.", [
      { id: "c-k", text: "Приказ о коэффициенте стеснённости", page: 1, sourceFile: "смета.xlsx", sheet: "ЛС" },
    ])).toBe("Коэффициент стеснённости. Чертёж L2, ISO9001.");
    expect(omitUnsourcedPlaces("Коэффициент на листе ЛС, A1. Чертёж L2, ISO9001.", [
      { id: "c-k", text: "Приказ о коэффициенте стеснённости", page: 1, sourceFile: "смета.xlsx", sheet: "ЛС" },
    ])).toBe("Коэффициент на листе ЛС. Чертёж L2, ISO9001.");
    expect(omitUnsourcedPlaces("Стоимость на листе ЛС, N20.", [
      { id: "c-est", text: "Сметная стоимость", page: 1, sourceFile: "смета.xlsx", sheet: "ЛС", cell: "N20" },
    ])).toContain("N20");
    expect(omitUnsourcedPlaces("Итог на листе ЛС, G10:G11. На листе указан чертёж, L2 и ISO9001.", [
      { id: "c-sum", text: "Итог", page: 1, sourceFile: "смета.xlsx", sheet: "ЛС", cell: "G10:G11" },
    ])).toBe("Итог на листе ЛС, G10:G11. На листе указан чертёж, L2 и ISO9001.");
    const sourcedCells = ["A20", "A13", "C28", "G10", "B43"].map((cell) => ({
      id: `c-${cell}`,
      text: `Факт ${cell}`,
      page: 1,
      sourceFile: "смета.xlsx",
      sheet: "ЛС",
      cell,
    }));
    const cellPayload = buildModelNoteUserContent(
      { kind: "local-estimate" },
      [{ id: "h-cost", text: "Факт A20", reason: "шапка", severity: "info", page: 1 }],
      sourcedCells
    );
    for (const cell of ["A20", "A13", "C28", "G10", "B43"]) expect(cellPayload).toContain(cell);
    expect(cellPayload).toContain('"cells"');
    const named = omitUnsourcedPlaces("Стоимость на листе ЛС, A20. Объём в ячейке A13. Диаметр C28, итог G10, коэффициент B43.", sourcedCells);
    for (const cell of ["A20", "A13", "C28", "G10", "B43"]) expect(named).toContain(cell);
    const restored = requireSourceCells(omitUnsourcedPlaces("Стоимость на листе ЛС.", sourcedCells), sourcedCells);
    for (const cell of ["A20", "A13", "C28", "G10", "B43"]) expect(restored).toContain(cell);
    const sheetPayload = buildModelNoteUserContent(
      { kind: "local-estimate" },
      [],
      [{ id: "c-est", text: "Сметная стоимость", page: 1, sourceFile: "смета.xlsx", sheet: "ЛС", cell: "N20" }]
    );
    expect(sheetPayload).toContain("лист ЛС");
    expect(sheetPayload).toContain("N20");
    expect(sheetPayload).not.toContain("стр. 1");
  });
});

describe("grounded numbers", () => {
  it("accepts a number only when it is not glued to a longer one", () => {
    expect(numbersAreGrounded("ставка 100", "Ставка заказчика: 100; Ставка черновика: 120")).toBe(true);
    expect(numbersAreGrounded("разница 20", "Ставка заказчика: 100; Ставка черновика: 120")).toBe(false);
    expect(numbersAreGrounded("без чисел", "120")).toBe(true);
    expect(numbersAreGrounded("итого 120", "Итого 120. Проверьте остаток.")).toBe(true);
    expect(numbersAreGrounded("итого 120", "Значение 120.5.")).toBe(false);
    expect(numbersAreGrounded("штраф 0,5", "Штраф 0.5.")).toBe(true);
  });

  it("keeps a comparison finding whose numbers are in the row and drops an invented one", () => {
    const rows = [{
      rowId: "row-1",
      factsText: "Код: 01; Позиция: Монтаж труб; Ставка заказчика: 100; Ставка черновика: 120",
    }];
    const result = validateCalcCompareAiResult(JSON.stringify({
      summary: "Ставка черновика 120 выше ставки заказчика 100.",
      findings: [
        {
          rowId: "row-1",
          text: "Ставка заказчика 100, ставка черновика 120.",
          sourceExcerpt: "Ставка заказчика: 100; Ставка черновика: 120",
        },
        {
          rowId: "row-1",
          text: "Разница составляет 20.",
          sourceExcerpt: "Ставка заказчика: 100; Ставка черновика: 120",
        },
      ],
    }), rows);
    expect(result.summary).toContain("120");
    expect(result.findings.map((finding) => finding.text)).toEqual([
      "Ставка заказчика 100, ставка черновика 120.",
    ]);
  });

  it("names overhead and profit only from the calculation rules", () => {
    const draft = {
      resourceScheduleParams: { overheadRate: 0.43, profitMarkupOnCostWithOh: 0.4, personHourRate: 1, personnelShiftsPerDay: 1, hoursPerShift: 1, equipmentShiftsPerDay: 1 },
      costSummary: { reserve: 0, profit: 400, resourceSlices: { direct: 1000, overhead: 430, costWithOh: 1430, profit: 572 } },
    } as unknown as Calculation;
    const text = pricingTextForCompare(draft, null);
    expect(text).toContain("43");
    expect(text).toContain("40");
    expect(text).toContain("1430");
    expect(pricingTextForCompare(null, null)).toContain("не указано в документах");
  });

  it("keeps a production figure that is written in the daily comment", () => {
    const result = validateProductionVarianceResult(JSON.stringify({
      summary: "В комментарии указан простой из-за ветра.",
      observations: [{
        sourceId: "fact-1",
        kind: "documented_reason",
        text: "Простой длился 4 часа из-за ветра.",
        sourceQuote: "простой 4 часа, сильный ветер",
      }],
    }), [{
      id: "fact-1",
      kind: "daily_comment",
      text: "Дата: 2026-11-09; комментарий: простой 4 часа, сильный ветер",
    }]);
    expect(result.observations).toHaveLength(1);
    expect(result.summary).toContain("ветра");
  });
});

describe("package answer parsing", () => {
  it("keeps a customer question without new numbers and a grounded cost impact", () => {
    const citations = [{
      id: "c-contract-1",
      text: "Заказчик оплачивает работы в течение 60 календарных дней после подписания акта.",
      page: 12,
      sourceFile: "Проект договора.pdf",
    }];
    const parsed = parseProjectAnalysisResult(JSON.stringify({
      recommendation: "insufficient_data",
      missingInputs: [],
      customerQuestions: [
        "Уточните районный коэффициент и порядок вахты.",
        "Подтвердите аванс 30 процентов.",
      ],
      evidence: [{
        topic: "payment",
        importance: "high",
        text: "Срок оплаты составляет 60 дней.",
        quote: "Заказчик оплачивает работы в течение 60 календарных дней",
        citationIds: ["c-contract-1"],
        costImpact: "Отсрочка 60 дней влияет на оборот.",
        scheduleImpact: "Срок сдвигается на 90 дней.",
      }],
    }));
    const checked = validateProjectEvidence(parsed, citations);
    expect(checked.accepted[0].costImpact).toContain("60");
    expect(checked.accepted[0].scheduleImpact).toBe("не указано в документах");
    expect(sanitizeCustomerQuestions(parsed.customerQuestions, citations.map((item) => item.text).join("\n"))).toEqual([
      "Уточните районный коэффициент и порядок вахты.",
    ]);
  });

  it("still rejects a model note that invents a three-digit number", () => {
    const reason = noteRejectionReason(
      `${"Записка по локальной смете без новых чисел. ".repeat(8)}Зона 5. Позиций 12.`,
      ["зона 5", "12"],
      { kind: "local-estimate" },
      JSON.stringify({ facts: { kind: "local-estimate", zone: 5, positionCount: 12 } })
    );
    expect(reason).toBeNull();
    expect(noteRejectionReason(
      `${"• Раздел 1: 716 м. ".repeat(12)}Только одна позиция.`,
      [],
      { kind: "local-estimate", sectionRollup: { sections: [
        { section: "Раздел 1", unit: "м", quantity: 716, rows: 1 },
        { section: "Раздел 2", unit: "м", quantity: 17076, rows: 1 },
      ], totalsByUnit: [], titledCounts: [] } },
      "716"
    )).toContain("одной позиции");
    expect(noteRejectionReason(
      `${"Записка по локальной смете. ".repeat(10)}Зона 5. Позиций 12. Лишняя сумма 777.`,
      ["зона 5", "12"],
      { kind: "local-estimate" },
      JSON.stringify({ facts: { zone: 5, positionCount: 12 } })
    )).toContain("777");
  });
});

describe("prompt score", () => {
  it("marks a JSON answer with a quote as filled and cited", () => {
    const score = scoreModelResponse({
      id: "project-package",
      title: "ИИ-анализ пакета",
      raw: JSON.stringify({
        recommendation: "insufficient_data",
        missingInputs: [],
        evidence: [{ text: "Срок оплаты 60 дней.", quote: "оплата в течение 60 дней", citationIds: ["c1"] }],
      }),
      requiredFields: ["recommendation", "evidence"],
      allowEmptyArrays: ["missingInputs"],
      elapsedMs: 12,
    });
    expect(score.jsonValid).toBe(true);
    expect(score.fieldsFilled).toBe(true);
    expect(score.hasCitation).toBe(true);
  });
});
