import { describe, expect, it } from "vitest";
import { validateProductionVarianceResult } from "@/server/production-variance-ai";

describe("validateProductionVarianceResult", () => {
  const sources = [
    {
      id: "fact-1",
      kind: "daily_comment" as const,
      text: "Дата: 2026-11-09; работа: монтаж крана; комментарий: Сильный ветер остановил подъем крана",
    },
    {
      id: "supply-1",
      kind: "supplier_delay" as const,
      text: "Материал: Кабель; требуется к 2026-11-01; статус: ordered; работа: монтаж",
    },
  ];

  it("accepts source-grounded reasons and only marks supply delays as possible factors", () => {
    const result = validateProductionVarianceResult(JSON.stringify({
      summary: "В отчёте записана причина остановки работ.",
      observations: [
        {
          sourceId: "fact-1",
          kind: "documented_reason",
          text: "Сильный ветер остановил подъем крана.",
          sourceQuote: "Сильный ветер остановил подъем крана",
        },
        {
          sourceId: "supply-1",
          kind: "possible_factor",
          text: "Кабель может задержать монтаж.",
          sourceQuote: "Материал: Кабель; требуется к 2026-11-01; статус: ordered; работа: монтаж",
        },
        {
          sourceId: "supply-1",
          kind: "documented_reason",
          text: "Кабель остановил монтаж.",
          sourceQuote: "Материал: Кабель; требуется к 2026-11-01; статус: ordered; работа: монтаж",
        },
        {
          sourceId: "missing",
          kind: "documented_reason",
          text: "Сильный ветер остановил подъем крана.",
          sourceQuote: "Сильный ветер остановил подъем крана",
        },
      ],
    }), sources);

    expect(result.observations).toHaveLength(2);
    expect(result.observations.map((item) => item.kind)).toEqual([
      "documented_reason",
      "possible_factor",
    ]);
  });

  it("rejects numeric prose and claims without matching source wording", () => {
    const result = validateProductionVarianceResult(JSON.stringify({
      summary: "Отставание составляет 30 процентов.",
      observations: [
        {
          sourceId: "fact-1",
          kind: "documented_reason",
          text: "Работы отложены из-за аварии.",
          sourceQuote: "Сильный ветер остановил подъем крана",
        },
      ],
    }), sources);
    expect(result.summary).toContain("не сформировал");
    expect(result.observations).toHaveLength(0);
  });
});
