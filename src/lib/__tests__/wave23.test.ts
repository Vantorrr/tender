import { describe, expect, it } from "vitest";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import { buildStagesFromEstimatePositions, signedQuantityBySection } from "@/lib/estimate-stages";
import { numbersAreGrounded } from "@/server/ai-grounding";
import { citationTopicLabel } from "@/lib/citation-display";
import {
  analyticalNoteBlocks,
  analyticalNoteStructure,
  analysisFailureText,
  calcMemoState,
  citationHref,
  citedQuestion,
  combineEstimateTotals,
  completedWorkCost,
  composeAnalyticalNote,
  honestReadinessText,
  foldNorthernEconomics,
  matchDirectorySuppliers,
  migratePlanEntries,
  CONTRACT_CHECKLIST,
  dependencyWouldCycle,
  groundedStatement,
  mergeQuantities,
  northernAdditionLines,
  scheduleParamsWithNorthernDefaults,
  ocrFailureMessage,
  ocrPageLimitMessage,
  parseContractChecklist,
  parseVolumeDraft,
  planWorksOnDate,
  priceVolumeRows,
  quoteRequestOutcome,
  rateIsMissing,
  recognizedRowsPhrase,
  rowCountGenitive,
  rowCountNominative,
  sanitizeSyncDetail,
  scheduleAfterPredecessor,
  shouldRetrySync,
  splitEmbeddedUnit,
  suppressFalseAbsence,
} from "@/lib/wave23";
import type { CalcPosition, GprStage } from "@/lib/types";

describe("wave 2–3 decisions", () => {
  it("keeps the same material in two sections and nets a return", () => {
    const positions: CalcPosition[] = [
      { id: "a", code: "ФССЦ-1", name: "Долото", unit: "шт", quantity: 16, rate: 0, rateMissing: true, resourceKind: "material", sourceSectionName: "Раздел 1", sourceWorkName: "Бурение" },
      { id: "b", code: "ФССЦ-1", name: "Долото", unit: "шт", quantity: 0.74, rate: 0, rateMissing: true, resourceKind: "material", sourceSectionName: "Раздел 3", sourceWorkName: "Бурение" },
      { id: "w", code: "ФССЦ-2", name: "Вода", unit: "м3", quantity: -12.5, rate: 20, resourceKind: "material", sourceSectionName: "Раздел 1", sourceWorkName: "Бурение" },
    ];
    const stages = buildStagesFromEstimatePositions(positions, "2026-11-19T00:00:00.000Z");
    const resources = stages.flatMap((stage) => (stage.resources ?? []).map((resource) => ({
      section: stage.sectionName,
      name: resource.name,
      unit: resource.unit,
      quantity: resource.quantity,
    })));
    const source = positions.map((position) => ({
      section: position.sourceSectionName,
      name: position.name,
      unit: position.unit,
      quantity: position.quantity,
    }));
    expect(signedQuantityBySection(resources).get("раздел 1|долото|шт")).toBeCloseTo(16);
    expect(signedQuantityBySection(resources).get("раздел 3|долото|шт")).toBeCloseTo(0.74);
    expect(signedQuantityBySection(source).get("раздел 1|вода|м3")).toBeCloseTo(
      signedQuantityBySection(resources).get("раздел 1|вода|м3")!,
    );
    const water = resources.find((row) => row.name.includes("Вода"))!;
    expect(water.name.startsWith("Возврат:")).toBe(true);
    expect(water.quantity).toBeGreaterThan(0);
    const [node] = buildHierarchicalEstimate({ stages });
    const shown = node.groups.flatMap((group) => group.leaves).find((leaf) => leaf.name.includes("Вода"))!;
    expect(shown.name.startsWith("Возврат:")).toBe(true);
    expect(shown.amount).toBeLessThan(0);
  });

  it("counts rows in the nominative and keeps the genitive after для", () => {
    expect(recognizedRowsPhrase(1)).toBe("распознана 1 строка");
    expect(recognizedRowsPhrase(21)).toBe("распознана 21 строка");
    expect(recognizedRowsPhrase(24)).toBe("распознано 24 строки");
    expect(recognizedRowsPhrase(22)).toBe("распознано 22 строки");
    expect(recognizedRowsPhrase(25)).toBe("распознано 25 строк");
    expect(recognizedRowsPhrase(11)).toBe("распознано 11 строк");
    expect(rowCountNominative(0)).toBe("0 строк");
    expect(rowCountGenitive(1)).toBe("1 строки");
    expect(rowCountGenitive(24)).toBe("24 строк");
    expect(rowCountGenitive(21)).toBe("21 строки");
  });

  it("labels a missing rate and a return amount", () => {
    expect(rateIsMissing(0)).toBe(true);
    expect(rateIsMissing(null)).toBe(true);
    expect(rateIsMissing(12)).toBe(false);
    expect(completedWorkCost(4, 25)).toBe(100);
    expect(completedWorkCost(4, 0)).toBeNull();
  });

  it("does not call a defect list or an estimate total a purchase condition", () => {
    expect(citationTopicLabel("Основание: Дефектная ведомость № 12 от 01.03.2026")).toBe("Прочее");
    expect(citationTopicLabel("Основание: Дефектная ведомость №1,2")).toBe("Прочее");
    expect(citationTopicLabel("Сметная стоимость: 469 269,22 тыс. руб.")).toBe("Прочее");
    expect(citationTopicLabel("Штраф 0,1% за каждый день просрочки")).toBe("Ответственность");
  });

  it("builds a citation link and a five-block note", () => {
    expect(citationHref("doc-1", { page: 3, sheet: "ЛС", cell: "G10", paragraph: 2 }))
      .toBe("/cabinet/dokumenty/doc-1?page=3&sheet=%D0%9B%D0%A1&cell=G10&paragraph=2");
    const note = composeAnalyticalNote({
      verdict: 7.4,
      verdictText: "Участие возможно после проверки сроков.",
      blocks: ["Паспорт", "Условия", "Объёмы", "Себестоимость 10", "Штраф"],
    });
    const shape = analyticalNoteStructure(note);
    expect(note.startsWith("Готовность к решению: достаточно данных.")).toBe(true);
    expect(note).not.toMatch(/Вердикт ИИ/);
    expect(shape.verdict).toBe(7);
    expect(honestReadinessText("Вердикт ИИ: 3 / 10 — не выходить")).toBe("Готовность к решению: не участвовать. не выходить");
    expect(analyticalNoteStructure("Вердикт ИИ: 4 / 10 — мало данных").verdict).toBe(4);
    expect(shape.blocks).toHaveLength(5);
    expect(analysisFailureText("OCR (tesseract): пусто")).toBe("Разбор не выполнен: пусто");
    expect(ocrFailureMessage("tesseract failed: missing rus")).toBe("Не удалось распознать скан: missing rus");
    expect(ocrPageLimitMessage(30, 48)).toBe("Прочитано 30 из 48 страниц");
  });

  it("drops an uncited number and an uncited customer question", () => {
    const corpus = "Бурение скважин 716 м. Срок подачи 20.11.2026.";
    expect(groundedStatement("Объём 120 п.м.", corpus, numbersAreGrounded)).toBe("нет данных");
    expect(groundedStatement("Объём 716 м.", corpus, numbersAreGrounded)).toContain("716");
    expect(citedQuestion("Какой срок начала, если в смете 120 п.м?", corpus, numbersAreGrounded)).toBeNull();
    expect(citedQuestion("Уточните, пожалуйста, этот пункт.", corpus, numbersAreGrounded)).toBeNull();
    expect(citedQuestion("Подтвердите фразу «Бурение скважин 716 м».", corpus, numbersAreGrounded)).toContain("716");
    expect(suppressFalseAbsence("Срок не указан, материалы не указаны.", "Срок подачи и материалы кабеля указаны.")).not.toMatch(/не указан/iu);
  });

  it("sums distinct estimates and prices a volume draft from the directory", () => {
    const combined = combineEstimateTotals([
      { label: "Смета А", total: 100 },
      { label: "Смета Б", total: 200 },
      { label: "Смета А", total: 100 },
    ]);
    expect(combined.total).toBe(300);
    expect(combined.duplicates).toEqual(["Смета А"]);
    expect(combined.discrepancies).toEqual([]);
    const mismatched = combineEstimateTotals([
      { label: "Смета А", total: 100 },
      { label: "Смета А", total: 150 },
    ]);
    expect(mismatched.total).toBe(100);
    expect(mismatched.discrepancies[0]).toContain("100 и 150");
    const rows = priceVolumeRows(parseVolumeDraft(JSON.stringify({
      rows: [{ work: "Бурение", unit: "м", volume: 716, quote: "Бурение 716 м" }],
    })), (work) => work === "Бурение" ? 1400 : null);
    expect(rows[0]).toMatchObject({ volume: 716, rate: 1400, quote: "Бурение 716 м" });
    expect(priceVolumeRows([{ work: "Прочее", unit: "шт", volume: 1, quote: "цитата из ТЗ длиннее", rate: null }], () => null)[0].rate).toBeNull();
  });

  it("shifts a successor, rejects a cycle, and lists the contract checklist", () => {
    expect(scheduleAfterPredecessor("2026-11-01", 3)).toEqual({ start: "2026-11-02", end: "2026-11-04" });
    const stages = [
      { id: "a", dependsOn: undefined },
      { id: "b", dependsOn: "a" },
    ];
    expect(dependencyWouldCycle(stages, "a", "b")).toBe(true);
    expect(dependencyWouldCycle(stages, "b", "a")).toBe(false);
    const lines = northernAdditionLines(1000);
    expect(lines.map((line) => line.what)).toEqual(["Районный коэффициент", "Северная надбавка", "Накладные"]);
    expect(lines[0].amount).toBe(800);
    expect(lines[1].amount).toBe(800);
    expect(lines.every((line) => line.why.length > 0)).toBe(true);
    const corpus = "Неустойка 0,1% за каждый день просрочки. Аванс не предусмотрен.";
    const reviewed = parseContractChecklist(JSON.stringify({
      items: [
        { item: CONTRACT_CHECKLIST[0], severity: "high", quote: "Неустойка 0,1% за каждый день просрочки" },
        { item: "Выдуманный риск", severity: "high", quote: "этой фразы нет в договоре" },
      ],
    }), corpus);
    expect(reviewed.items).toHaveLength(1);
    expect(reviewed.items[0].quote).toContain("Неустойка");
  });

  it("folds northern add-ons into the total and splits an old plan row", () => {
    const folded = foldNorthernEconomics({
      labor: 1000,
      materials: 0,
      equipment: 0,
      profitRate: 0,
      params: { districtCoefficient: 1.8, northernPayrollShare: 0.8, overheadRate: 0.43 },
    });
    expect(folded.district).toBe(800);
    expect(folded.allowance).toBe(800);
    expect(folded.overhead).toBeCloseTo(1118, 0);
    expect(folded.total).toBeCloseTo(3718, 0);
    expect(folded.total).toBeGreaterThan(1000 * 1.43);
    expect(scheduleParamsWithNorthernDefaults().districtCoefficient).toBe(1.8);
    expect(scheduleParamsWithNorthernDefaults({ personHourRate: 1, personnelShiftsPerDay: 1, hoursPerShift: 1, equipmentShiftsPerDay: 1, overheadRate: 0.2, profitMarkupOnCostWithOh: 0.1, districtCoefficient: 1.2 }).districtCoefficient).toBe(1.2);
    expect(migratePlanEntries([{ workName: "Бурение скважин, м", unit: "", plan: 10 }])).toEqual([
      { workName: "Бурение скважин", unit: "м", plan: 10 },
    ]);
    expect(matchDirectorySuppliers("Долото трехшарошечное", [
      { name: "СеверСнаб", materialKeywords: ["долото"] },
      { name: "Кабель", materialKeywords: ["кабель"] },
    ]).map((item) => item.name)).toEqual(["СеверСнаб"]);
  });

  it("merges material needs, splits a contract row, and lists works on a date", () => {
    const merged = mergeQuantities([
      { name: "Долото", unit: "шт", quantity: 16 },
      { name: "Долото", unit: "шт", quantity: 0.74 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBeCloseTo(16.74);
    expect(splitEmbeddedUnit("Бурение скважин, м", "")).toEqual({ workName: "Бурение скважин", unit: "м" });
    expect(splitEmbeddedUnit("Монтаж", "м2")).toEqual({ workName: "Монтаж", unit: "м2" });
    const gpr: Array<Pick<GprStage, "name" | "start" | "end" | "planUnit">> = [
      { name: "Бурение", start: "2026-11-01", end: "2026-11-03", planUnit: "м" },
      { name: "Монтаж", start: "2026-11-05", end: "2026-11-06", planUnit: "шт" },
    ];
    expect(planWorksOnDate(gpr, "2026-11-02").map((stage) => stage.name)).toEqual(["Бурение"]);
    expect(quoteRequestOutcome(false)).toMatchObject({
      sent: false,
      status: "не отправлено",
      message: expect.stringContaining("почта не подключена"),
    });
    expect(sanitizeSyncDetail("Контур API ключ=secret-value-123456789012345678901234 вернул HTTP 429")).toMatch(/429/);
    expect(sanitizeSyncDetail("таймаут соединения")).toMatch(/Таймаут/);
    expect(shouldRetrySync("HTTP 503", 503)).toBe(true);
    expect(shouldRetrySync("некорректный фильтр", 400)).toBe(false);
  });
});

describe("legacy memo economics on display", () => {
  const citation = "Штраф 0 ₽ по цитате «удержать пени».";

  function legacyRecord(economics: string, calc: {
    positions: Array<{ rateMissing?: boolean; isWorkItem?: boolean }>;
    costSummary: { C0: number; resourceSlices?: { costWithOh: number } };
  }) {
    return {
      id: "p-manual-e31309bf-b800-431f-b1dc-1ebf05b90e54",
      summary: [
        "Вердикт ИИ: 4 / 10 — . Данных недостаточно для решения.",
        "",
        "1. Паспорт закупки и тайминг",
        "Закупка на бурение.",
        "",
        "4. Расчёт себестоимости и экономика",
        economics,
        "",
        "5. Риски и подводные камни",
        citation,
      ].join("\n"),
      calc,
    };
  }

  function shownEconomics(summary: string) {
    return analyticalNoteBlocks(summary).find((block) => block.title === "Расчёт себестоимости и экономика")?.body ?? "";
  }

  it("rewrites an uncalculated zero and the leftover double period without storing the change", () => {
    const record = legacyRecord(
      "Черновая себестоимость по справочникам компании: 0 ₽. Не найдены собственные ставки для 20 строк. Расчётная прибыль до налога: 0 ₽; рентабельность на себестоимость: не рассчитана%; маржа в цене: не рассчитана%. Предельная разница между НМЦК и расчётной ценой с НДС: 1000 ₽. Это запас до предельной цены, а не обещанная прибыль.",
      {
        positions: [
          ...Array.from({ length: 20 }, () => ({ rateMissing: true, isWorkItem: false })),
          { rateMissing: true, isWorkItem: true },
        ],
        costSummary: { C0: 0 },
      },
    );
    const stored = record.summary;
    const state = calcMemoState(record.calc);
    const shown = honestReadinessText(record.summary, state);

    expect(state).toEqual({ cost: 0, missingRates: 20 });
    expect(record.summary).toBe(stored);
    expect(record.summary).toContain("Вердикт ИИ");
    expect(record.summary).toContain("не рассчитана%");
    expect(shown.startsWith("Готовность к решению: данных недостаточно. Данных недостаточно для решения.")).toBe(true);
    expect(shown).not.toMatch(/\.\s+\./);
    const economics = shownEconomics(shown);
    expect(economics).toContain("Себестоимость не рассчитана: нет ставок для 20 строк");
    expect(economics).toContain("Прибыль и рентабельность не рассчитаны: себестоимость не подтверждена.");
    expect(economics).toContain("Сравнение с НМЦК невозможно, пока себестоимость не рассчитана.");
    expect(economics).not.toMatch(/не рассчитана%/);
    expect(economics).not.toMatch(/0 ₽/);
    expect(shown).toContain("Закупка на бурение.");
    expect(shown).toContain(citation);

    const fallback = honestReadinessText(
      "Себестоимость с учтёнными накладными: 0 ₽. Прибыль: не рассчитана; рентабельность на себестоимость: не рассчитана%; маржа в цене: не рассчитана%.",
      state,
    );
    expect(fallback).toContain("Себестоимость не рассчитана: нет ставок для 20 строк");
    expect(fallback).toContain("Прибыль и рентабельность не рассчитаны: себестоимость не подтверждена.");
    expect(fallback).not.toMatch(/не рассчитана%/);
  });

  it("shows a partial cost from the current draft and keeps the profit figure", () => {
    const record = legacyRecord(
      "Черновая себестоимость по справочникам компании: 1500 ₽. Не найдены собственные ставки для 2 строк. Расчётная прибыль до налога: 100 ₽; рентабельность на себестоимость: не рассчитана%; маржа в цене: 10%.",
      {
        positions: [{ rateMissing: false }, { rateMissing: true }, { rateMissing: true }],
        costSummary: { C0: 100, resourceSlices: { costWithOh: 1500 } },
      },
    );
    const shown = honestReadinessText(record.summary, calcMemoState(record.calc));
    const economics = shownEconomics(shown);
    expect(economics).toContain("Себестоимость по найденным ставкам: 1 500,00 ₽ (без 2 строк без ставок)");
    expect(economics).toContain("Предварительно, только по найденным ставкам, без 2 строк без ставок.");
    expect(economics).toContain("Расчётная прибыль до налога: 100 ₽");
    expect(economics).toContain("маржа в цене: 10%");
    expect(economics).toContain("рентабельность на себестоимость: не рассчитана;");
    expect(economics).not.toMatch(/не рассчитана%/);
    expect(shown).toContain(citation);
    expect(record.summary).toContain("не рассчитана%");
  });

  it("keeps a genuine zero when every rate is found", () => {
    const record = legacyRecord(
      "Черновая себестоимость по справочникам компании: 0 ₽. Ставки по строкам черновика найдены. Расчётная прибыль до налога: 0 ₽; рентабельность на себестоимость: не рассчитана%; маржа в цене: не рассчитана%.",
      {
        positions: [{ rateMissing: false, isWorkItem: false }],
        costSummary: { C0: 0 },
      },
    );
    const shown = honestReadinessText(record.summary, calcMemoState(record.calc));
    const economics = shownEconomics(shown);
    expect(economics).toContain("Себестоимость 0 ₽: проверьте объёмы и ставки");
    expect(economics).not.toContain("нет ставок");
    expect(economics).toContain("Ставки по строкам черновика найдены.");
    expect(economics).toContain("Расчётная прибыль до налога: 0 ₽");
    expect(economics).toContain("не рассчитана;");
    expect(economics).not.toMatch(/не рассчитана%/);
    expect(shown).toContain(citation);
  });

  it("cleans the double period left by the readiness line", () => {
    const shown = honestReadinessText("Вердикт ИИ: 4 / 10 — . Данных недостаточно для решения.");
    expect(shown).toBe("Готовность к решению: данных недостаточно. Данных недостаточно для решения.");
    expect(shown).not.toMatch(/\.\s+\./);
    expect(shown).not.toMatch(/Вердикт ИИ/);
  });

  it("leaves a confirmed cost and an already honest note unchanged", () => {
    const confirmed = "Черновая себестоимость по справочникам компании: 1500 ₽. Расчётная прибыль до налога: 200 ₽; рентабельность на себестоимость: 20%; маржа в цене: 16%.";
    expect(honestReadinessText(confirmed, { cost: 1500, missingRates: 0 })).toBe(confirmed);
    const fresh = "Готовность к решению: данных недостаточно. Данных недостаточно. Себестоимость не рассчитана: нет ставок для 4 строк. Прибыль и рентабельность не рассчитаны: себестоимость не подтверждена.";
    expect(honestReadinessText(fresh, { cost: 0, missingRates: 4 })).toBe(fresh);
  });
});
