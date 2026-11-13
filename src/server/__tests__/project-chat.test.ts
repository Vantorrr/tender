import { describe, expect, it } from "vitest";
import { validateProjectChatResult } from "@/server/project-chat";

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
    }, [card]);

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
    expect(result.answer).toContain("Не нашёл");
  });
});
