import { describe, expect, it } from "vitest";
import { selectRelevantProjectChatSources, validateProjectChatResult } from "@/server/project-chat";

describe("grounded procurement chat", () => {
  const card = {
    id: "S001",
    label: "Карточка закупки",
    quote: "",
    sourceText: "Заказчик: ГБУ «Дирекция образования»\nСрок подачи: 15 ноября 2026 г., 15:00 (исходное значение: 2026-11-15T12:00:00Z)",
    href: "/cabinet/zakupki/p-1",
  };

  it("allows multiple exact quotes from the same procurement card", () => {
    const result = validateProjectChatResult({
      answer: "Заказчик: ГБУ «Дирекция образования»\nСрок подачи: 15 ноября 2026 г., 15:00",
      outOfScope: false,
      sources: [
        { sourceId: "S001", quote: "Заказчик: ГБУ «Дирекция образования»" },
        { sourceId: "S001", quote: "Срок подачи: 15 ноября 2026 г., 15:00" },
      ],
    }, [card], "Кто заказчик и какой срок подачи?");

    expect(result.sources).toHaveLength(2);
    expect(result.answer).toContain("15 ноября 2026 г., 15:00");
  });

  it("rejects a numeric claim that is not supported by the accepted quotes", () => {
    const result = validateProjectChatResult({
      answer: "Заказчик: ГБУ «Дирекция образования». НМЦК: 99 000 000 ₽.",
      outOfScope: false,
      sources: [{ sourceId: "S001", quote: "Заказчик: ГБУ «Дирекция образования»" }],
    }, [card]);

    expect(result.sources).toEqual([]);
    expect(result.answer).toContain("не нашёл ответа на этот вопрос");
  });

  it("prefers a relevant document over an unrelated procurement card", () => {
    const sources = [
      card,
      { id: "S002", label: "Документ · Общие условия", sourceText: "Общие сведения о компании и объекте." },
      { id: "S003", label: "Риски · Договор", sourceText: "Штраф за просрочку срока выполнения работ по договору." },
      { id: "S004", label: "План/факт · Производство", sourceText: "План и факт работ на площадке." },
    ];

    const selected = selectRelevantProjectChatSources("Какие штрафы за просрочку по договору?", sources);

    expect(selected[0].id).toBe("S003");
    expect(selected).not.toContainEqual(expect.objectContaining({ id: "S001" }));
    expect(selected).not.toContainEqual(expect.objectContaining({ id: "S002" }));
  });

  it("includes the card when the user asks for its deadline", () => {
    const selected = selectRelevantProjectChatSources("Какой срок подачи?", [card]);
    expect(selected.map((source) => source.id)).toEqual(["S001"]);
  });

  it("does not send the procurement card for a work question", () => {
    const selected = selectRelevantProjectChatSources("Какой объём работы предусмотрен?", [
      card,
      { id: "S002", label: "Документ · Техническое задание", sourceText: "Объем работ: выполнить ремонт кровли здания." },
    ]);

    expect(selected.map((source) => source.id)).toEqual(["S002"]);
  });

  it("rejects a card dump when the user asked a different question", () => {
    const result = validateProjectChatResult({
      answer: "Заказчик: ГБУ «Дирекция образования»\nСрок подачи: 15 ноября 2026 г., 15:00",
      outOfScope: false,
      sources: [{ sourceId: "S001", quote: "Заказчик: ГБУ «Дирекция образования»" }],
    }, [card], "Какой объем работ?");

    expect(result.sources).toEqual([]);
    expect(result.answer).toContain("не нашёл ответа на этот вопрос");
  });
});
