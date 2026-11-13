import { describe, expect, it } from "vitest";
import {
  filterDailyFactsByPeriod,
  filterDailyFactsByWork,
  validateProductionVarianceResult,
} from "@/server/production-variance-ai";

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

describe("filterDailyFactsByPeriod", () => {
  const facts = [
    { id: "a", date: "2026-10-31" },
    { id: "b", date: "2026-11-01" },
    { id: "c", date: "2026-11-10" },
    { id: "d", date: "2026-11-11" },
  ] as Parameters<typeof filterDailyFactsByPeriod>[0];

  it("selects comments from the same day, month, cumulative cut, or full period", () => {
    expect(filterDailyFactsByPeriod(facts, "2026-11-10", "day").map((f) => f.id)).toEqual(["c"]);
    expect(filterDailyFactsByPeriod(facts, "2026-11-10", "month").map((f) => f.id)).toEqual(["b", "c", "d"]);
    expect(filterDailyFactsByPeriod(facts, "2026-11-10", "cum").map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(filterDailyFactsByPeriod(facts, "2026-11-10", "period").map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("filterDailyFactsByWork", () => {
  it("keeps comments for the selected production work only", () => {
    const workFacts = [
      { id: "a", date: "2026-11-10", workName: "Трубопровод", unit: "м", quantity: 1, photos: [], authorId: "u", at: "" },
      { id: "b", date: "2026-11-10", workName: "Опоры", unit: "шт", quantity: 1, photos: [], authorId: "u", at: "" },
    ];
    expect(filterDailyFactsByWork(workFacts, "Трубопровод").map((fact) => fact.id)).toEqual(["a"]);
  });
});
