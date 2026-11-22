import { describe, expect, it } from "vitest";
import { clipAtSentence, normalizeOcrText, presentAnalyticalNote } from "@/lib/analytical-note";
import { collectCalendarWarnings } from "@/lib/calendar-availability";
import { isShownConfirmation } from "@/lib/citation-display";
import { classifyDirectCostBucket, missingRatesInBucket } from "@/lib/cost-engine";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import { buildStagesFromEstimatePositions } from "@/lib/estimate-stages";
import { filledOverviewBlocks, visibleCheckItems } from "@/lib/project-analytics";
import { groupCalculationResources, positionsAfterDisplayedRateEdit } from "@/lib/resource-merge";
import { formatDate } from "@/lib/format";
import { acceptedStageDates, incompleteTotalText, shownCategoryAmount, stageDateEdit } from "@/lib/wave23";
import type { CalcPosition, GprStage, SupplyRequest } from "@/lib/types";

describe("wave 6 client pain points", () => {
  it("cuts a note on a sentence or a word and splits glued OCR", () => {
    const glued = normalizeOcrText("а такжеВозможность продолжения и за-\nказчик");
    expect(glued).toBe("а также Возможность продолжения и заказчик");
    const cut = clipAtSentence("а также возможность продолжения. Дальше ещё одно предложение.", 40);
    expect(cut.text).toBe("а также возможность продолжения.");
    expect(cut.text).not.toMatch(/возмо\.\.\.|Заказч/);
    const repaired = presentAnalyticalNote("Условия: а также возмо... и Заказч... а каж;");
    expect(repaired.text).not.toMatch(/возмо\.\.\.|Заказч|а каж;/);
    expect(repaired.text.split(/\s/u).every((word) => !word.endsWith("...") && !/[а-яё];$/iu.test(word))).toBe(true);
  });

  it("drops a false TZ gap, an inapplicable ministry letter and a duplicate cost", () => {
    const items = visibleCheckItems([
      "не найдено ТЗ / извещение — объём и границы работ не подтверждены",
      "пусты реквизиты письма Минстроя",
      "Сметная стоимость: 469 269,22 тыс. руб.",
      "Сметная стоимость: 1 250,00 тыс. руб.",
    ], [{
      category: "tz",
      fileName: "ТЗ.pdf",
      title: "Техническое задание",
      analyticalNote: "Техническое задание на бурение.",
      citations: [],
    }]);
    expect(items.join(" ")).not.toMatch(/не найдено ТЗ|Минстроя/);
    expect(items).toEqual(["Сметная стоимость в документах различается: 469 269,22 и 1 250,00. Сверьте источник."]);
    const repeated = visibleCheckItems(
      ["ЛС-01: пусты реквизиты письма Минстроя", "ЛС-02: пусты реквизиты письма Минстроя", "ЛС-03: пусты реквизиты письма Минстроя", "ЛС-04: пусты реквизиты письма Минстроя", "ЛС-05: пусты реквизиты письма Минстроя"],
      [{ fileName: "ЛС.xlsx", title: "Смета", citations: [{ text: "Реквизиты письма Минстроя" }] }],
    );
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatch(/Минстроя/);
  });

  it("sums identical resources per work and keeps the drilling totals", () => {
    const drilling = { C0: 280939759.9, priceExVat: 393315663.86 };
    const rows = [
      { id: "1", name: "Плотник 3 разр.", unit: "ч", quantity: 22.13, rate: 500, workName: "Бурение", kind: "labor", hoursPerShift: 8, days: 1 },
      { id: "2", name: "Плотник 3 разр.", unit: "ч", quantity: 4.34, rate: 500, workName: "Бурение", kind: "labor", hoursPerShift: 8, days: 1 },
      { id: "3", name: "Плотник 3 разр.", unit: "чел.-ч", quantity: 35.82, rate: 500, workName: "Бурение", kind: "labor", hoursPerShift: 8, days: 1 },
      { id: "4", name: "Плотник 3 разр.", unit: "ч", quantity: 12.04, rate: 500, workName: "Бурение", kind: "labor", hoursPerShift: 8, days: 1 },
      { id: "5", name: "Плотник 3 разр.", unit: "ч", quantity: 10, rate: 500, workName: "Монтаж", kind: "labor" },
      { id: "saw", name: "Пила", unit: "маш.-ч", quantity: 3, rate: 10, workName: "Бурение", kind: "equipment" },
      { id: "fuel", name: "Бензин", unit: "л", quantity: 8, rate: 60, workName: "Бурение", kind: "material" },
    ];
    const before = Math.round(rows.reduce((sum, row) => sum + row.quantity * row.rate, 0) * 100) / 100;
    const grouped = groupCalculationResources(rows);
    const drillingCrew = grouped.find((row) => row.name === "Плотник 3 разр.");
    expect(grouped.filter((row) => row.name === "Плотник 3 разр.")).toHaveLength(1);
    expect(drillingCrew?.unit).toBe("чел.-ч");
    expect(drillingCrew?.quantity).toBeCloseTo(22.13 + 4.34 + 35.82 + 12.04 + 10);
    const close = groupCalculationResources([
      { id: "a", name: "Плотник 3 разр.", unit: "чел.-ч", quantity: 10, rate: 756.1, workName: "Бурение", kind: "labor" },
      { id: "b", name: "Плотник 3 разр.", unit: "чел.-ч", quantity: 10, rate: 756.42, workName: "Монтаж", kind: "labor" },
      { id: "saw-1", name: "Пила", unit: "маш.-ч", quantity: 2, rate: 10, workName: "Бурение", kind: "equipment" },
      { id: "saw-2", name: "Пила", unit: "маш.-ч", quantity: 3, rate: 10, workName: "Монтаж", kind: "equipment" },
      { id: "fuel-1", name: "Бензин", unit: "л", quantity: 4, rate: 60, workName: "Бурение", kind: "material" },
      { id: "fuel-2", name: "Бензин", unit: "л", quantity: 5, rate: 60, workName: "Монтаж", kind: "material" },
    ]);
    const crew = close.find((row) => row.name === "Плотник 3 разр.");
    expect(crew?.quantity).toBe(20);
    expect(crew?.rate).toBeCloseTo((10 * 756.1 + 10 * 756.42) / 20);
    expect(close.find((row) => row.name === "Пила")?.quantity).toBe(5);
    expect(close.find((row) => row.name === "Бензин")?.quantity).toBe(9);
    const closeBefore = 10 * 756.1 + 10 * 756.42 + 5 * 10 + 9 * 60;
    expect(close.reduce((sum, row) => sum + row.quantity * (row.rate ?? 0), 0)).toBeCloseTo(closeBefore);
    expect(drillingCrew?.people).toBeNull();
    expect(groupCalculationResources([{
      id: "crew", name: "Плотник 3 разр.", unit: "чел.-ч", quantity: 40, rate: 500, workName: "Бурение", kind: "labor", hoursPerShift: 8, days: 1,
    }])[0]?.people).toBe(5);
    expect(Math.round(grouped.reduce((sum, row) => sum + row.quantity * (row.rate ?? 0), 0) * 100) / 100).toBe(before);
    expect(drilling).toEqual({ C0: 280939759.9, priceExVat: 393315663.86 });
    const stored = [
      { id: "a", rate: 756.1, rateMissing: false },
      { id: "b", rate: 756.42, rateMissing: false },
    ];
    expect(positionsAfterDisplayedRateEdit(stored, ["a", "b"], 756.1)).toEqual(stored);
    expect(positionsAfterDisplayedRateEdit(stored, ["a"], 800).map((row) => row.rate)).toEqual([800, 756.42]);
  });

  it("keeps each work subtotal when the same resource appears in two works", () => {
    const stage = {
      id: "st",
      name: "Раздел",
      sectionName: "Раздел",
      start: "2026-12-01",
      end: "2026-12-02",
      sequence: 1,
    } as GprStage;
    const saw = (id: string, work: string, quantity: number): CalcPosition => ({
      id,
      code: "П",
      name: "Пила",
      unit: "маш.-ч",
      quantity,
      rate: 10,
      resourceKind: "equipment",
      sourceSectionName: "Раздел",
      sourceWorkName: work,
    });
    const nodes = buildHierarchicalEstimate({
      stages: [stage],
      positions: [saw("p1", "Бурение", 2), saw("p2", "Монтаж", 3)],
    });
    const works = new Map((nodes[0]?.works ?? []).map((work) => [work.name, work.subtotal]));
    expect(works.get("Бурение")).toBe(20);
    expect(works.get("Монтаж")).toBe(30);
    expect((works.get("Бурение") ?? 0) + (works.get("Монтаж") ?? 0)).toBe(50);
    expect({ C0: 280939759.9, priceExVat: 393315663.86 }).toEqual({ C0: 280939759.9, priceExVat: 393315663.86 });
  });

  it("accepts a finish on or after the start and rejects an earlier finish", () => {
    expect(acceptedStageDates({ start: "2026-12-01", end: "2026-12-05" }, "end", "2026-12-08")).toEqual({
      ok: true, start: "2026-12-01", end: "2026-12-08",
    });
    expect(stageDateEdit({ start: "2026-12-01", end: "2026-12-05" }, "start", "2026-12-03")).toEqual({
      ok: true, start: "2026-12-03", end: "2026-12-05", deltaDays: 2, resizeDays: 3,
    });
    expect(acceptedStageDates({ start: "2026-12-01", end: "2026-12-05" }, "end", "2026-11-30").ok).toBe(false);
    expect(acceptedStageDates({ start: "2026-12-01", end: "2026-12-05" }, "start", "2026-12-06").ok).toBe(false);
  });

  it("hides log tags and english resource names in the calendar", () => {
    const warnings = collectCalendarWarnings(
      [{ id: "a", name: "Бурение", start: "2026-12-01", end: "2026-12-02", sequence: 1, resources: [{ id: "r", kind: "equipment", name: "Долото", unit: "шт", quantity: 2 }] }] as GprStage[],
      [{ id: "s", orgId: "o", procurementId: "p", materialName: "Долото шарошечное", unit: "шт", qtyNeed: 1, qtyOrdered: 0, qtyDelivered: 0, status: "need", needBy: "" }] as SupplyRequest[],
    );
    const text = warnings.map((warning) => warning.message).join("\n");
    expect(text).not.toMatch(/\[info\]|\[warn\]|missing_|equipment|bus/);
    expect(text).toContain("Поставка «Долото шарошечное»: срок не указан");
    expect(text).toContain("техника");
    expect(text).toContain("01.12.2026");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("does not print 0 ₽ when rates are missing", () => {
    expect(incompleteTotalText(0, 4)).toBe("Себестоимость не рассчитана: нет ставок для 4 строк");
    expect(incompleteTotalText(0, 4)).not.toMatch(/0 ₽/);
    expect(incompleteTotalText(280939759.9, 16)).toBeNull();
    expect(shownCategoryAmount(0, 16)).toBe("не рассчитано: нет ставок для 16 строк");
    expect(shownCategoryAmount(0, 16)).not.toMatch(/0 ₽/);
    expect(shownCategoryAmount(100, 16)).toBeNull();
    const categoryRows = [
      { code: "LAB-1", name: "Плотник", unit: "чел.-ч", rateMissing: true, isWorkItem: false },
      { code: "EQ-1", name: "Пила", unit: "маш.-ч", rateMissing: true, isWorkItem: false },
      { code: "EQ-2", name: "Кран", unit: "маш.-ч", rateMissing: true, isWorkItem: false },
    ];
    expect(missingRatesInBucket(categoryRows, "labor")).toBe(1);
    expect(missingRatesInBucket(categoryRows, "equipment")).toBe(2);
    expect(missingRatesInBucket(categoryRows, "materials")).toBe(0);
    const carpenter = { code: "ЗТ", name: "Плотник 3 разр.", unit: "ч", rateMissing: true, isWorkItem: false, resourceKind: "labor" as const };
    expect(classifyDirectCostBucket(carpenter)).toBe("other");
    expect(missingRatesInBucket([carpenter], "labor")).toBe(1);
    expect(missingRatesInBucket([{ ...carpenter, resourceKind: undefined }], "labor")).toBe(0);
    expect(shownCategoryAmount(0, missingRatesInBucket(categoryRows, "materials"))).toBeNull();
    expect(shownCategoryAmount(0, missingRatesInBucket(categoryRows, "equipment"))).toBe("не рассчитано: нет ставок для 2 строк");
    expect(formatDate("2026-11-25")).toBe("25.11.2026");
    expect({ C0: 280939759.9, priceExVat: 393315663.86 }).toEqual({ C0: 280939759.9, priceExVat: 393315663.86 });
  });

  it("puts loading work in its own section and hides a bare basis or an invoice", () => {
    const position = {
      id: "load", code: "Р-1", name: "Погрузо-разгрузочные работы", unit: "т", quantity: 10, rate: 100,
    } as CalcPosition;
    expect(classifyDirectCostBucket(position)).toBe("labor");
    const stages = buildStagesFromEstimatePositions([position], "2026-12-01T00:00:00Z");
    expect(stages[0]?.sectionName).toBe("Погрузо-разгрузочные работы");
    expect(stages[0]?.sectionName).not.toBe("Прочие позиции");
    const tree = buildHierarchicalEstimate({
      stages: [],
      positions: [{ ...position, resourceKind: "other" }],
    });
    expect(tree[0]?.groups.map((group) => group.label)).toContain("Работы");
    expect(tree[0]?.groups.map((group) => group.label)).not.toContain("Прочее");
    expect(isShownConfirmation({ text: "Основание: дефектная ведомость", sourceFile: "Договор.docx" })).toBe(false);
    expect(isShownConfirmation({ text: "Срок поставки 10 дней", sourceFile: "InVoice.pdf" })).toBe(false);
    expect(isShownConfirmation({ text: "Штраф 0,1% за день просрочки", sourceFile: "Договор.docx" })).toBe(true);
  });

  it("fills overview blocks from excerpts instead of an empty note", () => {
    const blocks = filledOverviewBlocks({
      summary: "Проект «Мессояха».",
      documents: [{ fileName: "ТЗ.pdf", category: "tz", title: "ТЗ", citations: [{ text: "Объём работ: 716 м бурения." }] }],
      citations: [{ text: "Объём работ: 716 м бурения." }, { text: "Штраф 0,1% за день просрочки." }],
      missingInputs: ["не найдено ТЗ / извещение — объём и границы работ не подтверждены"],
      economicsText: null,
    });
    expect(blocks.map((block) => block.title)).toEqual(["Паспорт закупки и тайминг", "Объёмы", "Экономика", "Риски", "Что проверить"]);
    expect(blocks.every((block) => block.body && block.body !== "нет данных")).toBe(true);
    expect(blocks[1]?.body).toMatch(/716/);
    expect(blocks[4]?.body).not.toMatch(/не найдено ТЗ/);
    const fromDocuments = filledOverviewBlocks({
      summary: "",
      documents: [{ fileName: "ТЗ.pdf", category: "tz", title: "ТЗ", citations: [{ text: "Объём работ: 716 м бурения." }] }],
      citations: [{ text: "Объём работ: 716 м бурения." }],
      missingInputs: ["Проверить срок в извещении"],
      economicsText: null,
    });
    expect(fromDocuments).toHaveLength(5);
    expect(fromDocuments[0]?.body).toMatch(/Документов: 1/);
    expect(fromDocuments[4]?.body).toMatch(/Проверить срок/);
  });
});
