import { describe, expect, it } from "vitest";
import { parseDecimalRu } from "@/lib/decimal-ru";
import { formatDate, formatDateTime } from "@/lib/format";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import { humanizeIssue, humanizeIssues } from "@/lib/issue-text";
import { presentAnalyticalNote } from "@/lib/analytical-note";
import { plainExchangeTitle } from "@/lib/exchange-label";
import { quantityPresentation } from "@/lib/format";
import { rowDeleteConfirmed } from "@/lib/row-delete";
import { paymentAmountError, paymentBucket, paymentTotals } from "@/lib/money-payments";
import { gprStageLabel } from "@/lib/gpr-stage-label";
import { displayedKanbanColumn, procurementBoardLabel, visibleProcurementNumber } from "@/lib/pipeline";
import { REVIEW_LABELS } from "@/lib/roles";
import { patchMergedResources } from "@/lib/resource-merge";
import type { CalcPosition, GprStage } from "@/lib/types";

describe("client wave 1 wording and money", () => {
  it("turns issue codes into Russian and hides raw ids", () => {
    const names = new Map([["res-12", "Арматура"]]);
    expect(humanizeIssue("missing_tariff:res-12", names)).toBe("Нет ставки для: Арматура");
    expect(humanizeIssue("vat_percent_rate")).toBe("Не указана ставка НДС");
    expect(humanizeIssue("vat_percent")).toBe("Не указана ставка НДС");
    expect(humanizeIssues(["missing_tariff:res-12", "missing_tariff:res-12"], names)).toEqual([
      "Нет ставки для: Арматура",
    ]);
    expect(humanizeIssue("hours_inputs:res-9")).not.toMatch(/hours_inputs|res-/);
  });

  it("keeps the chosen payment type and does not rewrite legacy key payments", () => {
    expect(paymentBucket({ type: "spisanie", title: "Аванс 2 этап" })).toBe("spisanie");
    expect(paymentBucket({ type: "klyuchevoy", title: "Оплата этапа отделки" })).toBe("klyuchevoy");
    expect(paymentBucket({ type: "postuplenie", title: "2 этап" })).toBe("postuplenie");
    expect(paymentBucket({ title: "2 этап" })).toBe("postuplenie");
    const totals = paymentTotals([
      { type: "avans", title: "Аванс 30%", amount: 100_000 },
      { type: "postuplenie", title: "2 этап", amount: 300_000 },
      { type: "klyuchevoy", title: "Оплата этапа отделки", amount: 4_000_000 },
      { type: "spisanie", title: "Аванс 2 этап", amount: 50_000 },
    ]);
    expect(totals).toMatchObject({
      avans: 100_000,
      postuplenie: 300_000,
      klyuchevoy: 4_000_000,
      spisanie: 50_000,
      total: 4_350_000,
    });
    expect(paymentTotals([
      { type: "postuplenie", title: "2 этап", amount: 4_300_000 },
      { type: "spisanie", title: "Списание", amount: 50_000 },
    ]).total).toBe(4_250_000);
  });

  it("shows a rejected card in the archive column it already occupies", () => {
    expect(displayedKanbanColumn({ reviewStatus: "otklonena" })).toBe("closed_not_realized");
    expect(displayedKanbanColumn({ reviewStatus: "dublirovana" })).toBe("closed_not_realized");
    expect(displayedKanbanColumn({ reviewStatus: "novaya" })).toBe("novaya");
  });

  it("reads Russian money the way it is typed", () => {
    expect(parseDecimalRu("300 000")).toBe(300_000);
    expect(parseDecimalRu("300\u00a0000")).toBe(300_000);
    expect(parseDecimalRu("300,5")).toBe(300.5);
    expect(parseDecimalRu("1 000 000,25")).toBe(1_000_000.25);
    expect(parseDecimalRu("1 000")).not.toBe(0);
    expect(paymentAmountError(parseDecimalRu("0"))).toMatch(/больше нуля/);
    expect(paymentAmountError(parseDecimalRu(""))).toMatch(/больше нуля/);
    expect(paymentAmountError(parseDecimalRu("абв"))).toMatch(/больше нуля/);
    expect(paymentAmountError(parseDecimalRu("300 000"))).toBeNull();
  });

  it("does not throw when a manual procurement has no deadline", () => {
    expect(formatDate("")).toBe("не указан");
    expect(formatDateTime("")).toBe("не указан");
    expect(formatDateTime("not-a-date")).toBe("не указан");
  });

  it("nets negative lines into a return and merges the same resource in a stage", () => {
    const stage: GprStage = {
      id: "s1",
      name: "Бурение",
      sequence: 1,
      start: "2026-11-01",
      end: "2026-11-02",
      resources: [
        { id: "w1", kind: "material", name: "Вода", unit: "м3", quantity: -164.68, rate: 20 },
        { id: "w2", kind: "material", name: "Вода", unit: "м3", quantity: -2563.6, rate: 20 },
        { id: "d1", kind: "material", name: "Долото", unit: "шт", quantity: 16.63, rate: 100 },
        { id: "d2", kind: "material", name: "Долото", unit: "шт", quantity: 0.74, rate: 100 },
        { id: "p1", kind: "labor", name: "Плотник 3 разр.", unit: "чел", quantity: 4, rate: 756.41, quantityBasis: "count_per_shift", hoursPerShift: 11, shiftsPerDay: 1, days: 1 },
      ],
    };
    const [node] = buildHierarchicalEstimate({ stages: [stage], params: { personHourRate: 1400, personnelShiftsPerDay: 1, hoursPerShift: 11, equipmentShiftsPerDay: 1, overheadRate: 0.43, profitMarkupOnCostWithOh: 0.4 } });
    const materials = node.groups.find((group) => group.kind === "material")!.leaves;
    const water = materials.find((leaf) => leaf.name.includes("Вода"))!;
    const bit = materials.find((leaf) => leaf.name.includes("Долото"))!;
    expect(water.memberIds).toEqual(["w1", "w2"]);
    expect(water.name.startsWith("Возврат:")).toBe(true);
    expect(water.quantity).toBeCloseTo(2728.28, 2);
    expect(water.quantity).toBeGreaterThan(0);
    expect(bit.name).toBe("Долото");
    expect(bit.quantity).toBeCloseTo(17.37, 2);
    expect(materials.filter((leaf) => leaf.name.includes("Долото"))).toHaveLength(1);
    const carpenter = node.groups.find((group) => group.kind === "labor")!.leaves[0];
    expect(carpenter.rate).toBe(756.41);
    expect(carpenter.hoursQ).toBe(44);
    expect(carpenter.hoursQ).not.toBe(carpenter.rate);
  });

  it("keeps a scanned summary and drops the raw recognition dump", () => {
    const presented = presentAnalyticalNote([
      "Смета 12: бурение.",
      "Текст распознан автоматически, сверьте с оригиналом",
      "OCR (tesseract): сырой текст страницы",
    ].join("\n"));
    expect(presented.recognized).toBe(true);
    expect(presented.text).toBe("Смета 12: бурение.");
  });

  it("keeps the sign and each calendar when a merged return is edited", () => {
    const members = [
      { id: "w1", kind: "material" as const, name: "Вода", unit: "м3", quantity: -164.68, rate: 20, days: 2 },
      { id: "w2", kind: "material" as const, name: "Вода", unit: "м3", quantity: -2563.6, rate: 20, days: 5 },
    ];
    const rated = patchMergedResources(members, { name: "Возврат: Вода" }, { rate: 25 });
    expect(rated.map((item) => item.quantity)).toEqual([-164.68, -2563.6]);
    expect(rated.map((item) => item.days)).toEqual([2, 5]);
    expect(rated.every((item) => item.rate === 25)).toBe(true);
    const resized = patchMergedResources(members, { name: "Возврат: Вода" }, { quantity: 100 });
    expect(resized.reduce((sum, item) => sum + item.quantity, 0)).toBeCloseTo(-100, 5);
  });

  it("removes a calculation row only after an explicit confirm", () => {
    expect(rowDeleteConfirmed("dismiss")).toBe(false);
    expect(rowDeleteConfirmed("confirm")).toBe(true);
  });

  it("shows a piece quantity from a norm with two decimals and an explanation", () => {
    const shown = quantityPresentation(16.5396, "шт");
    expect(shown.text).toBe("16,54");
    expect(shown.title).toMatch(/норме сметы/);
    expect(quantityPresentation(4, "шт").title).toBeUndefined();
  });

  it("hides internal ids in an exchange title", () => {
    expect(plainExchangeTitle("Смета заказчика · смета.xlsx · РУЧНАЯ-20261119-abc · p-manual-1")).toBe(
      "Смета заказчика · смета.xlsx",
    );
  });

  it("nests each estimate section under its own stage", () => {
    const work = "Бурение скважин диаметром 450 мм вращательным способом";
    const stages: GprStage[] = [1, 3, 4].map((n, index) => ({
      id: `s${n}`,
      name: work,
      workName: work,
      sectionName: n === 1 ? "Раздел 1. Опоры П-12" : n === 3 ? "Раздел 3. Опоры П-2к" : "Раздел 4. Защитные конструкции",
      sequence: index + 1,
      start: "2026-01-01",
      end: "2026-01-02",
      resources: [],
    }));
    const positions: CalcPosition[] = [
      { id: "p3", code: "ФССЦ-1", name: "Долото", unit: "шт", quantity: 16.632, rate: 1, sourceSectionName: "Раздел 3. Опоры П-2к", sourceWorkName: work },
      { id: "p4", code: "ФССЦ-1", name: "Долото", unit: "шт", quantity: 0.7392, rate: 1, sourceSectionName: "Раздел 4. Защитные конструкции", sourceWorkName: work },
    ];
    const nodes = buildHierarchicalEstimate({ stages, positions });
    const ids = (id: string) => {
      const node = nodes.find((item) => item.id === id)!;
      return [
        ...node.groups.flatMap((group) => group.leaves.map((leaf) => leaf.id)),
        ...node.works.flatMap((item) => item.groups.flatMap((group) => group.leaves.map((leaf) => leaf.id))),
        ...node.unassignedGroups.flatMap((group) => group.leaves.map((leaf) => leaf.id)),
        ...node.works.map((item) => item.name),
      ];
    };
    expect(ids("s1").join(" ")).not.toMatch(/p3|p4|Раздел 3|Раздел 4/);
    expect(ids("s3")).toContain("p3");
    expect(ids("s4")).toContain("p4");
  });

  it("hides a generated manual procurement number", () => {
    expect(visibleProcurementNumber({ number: "РУЧНАЯ-20261119-38b63b", source: "manual" })).toBe("Ручная закупка");
    expect(visibleProcurementNumber({ number: "0373100012" })).toBe("0373100012");
  });

  it("gives identical works distinct stage names by section number", () => {
    const work = "Бурение скважин диаметром 450 мм вращательным (роторным) способом";
    const first = gprStageLabel({
      name: work,
      workName: work,
      sectionName: "Раздел 1. Бурение скважин под неподвижные опоры П-12Р(325) 118 шт",
    });
    const third = gprStageLabel({
      name: work,
      workName: work,
      sectionName: "Раздел 3. Бурение скважин под опоры П-2к и П-4к (325) 72 шт",
    });
    expect(first.text.startsWith("1.")).toBe(true);
    expect(first.numbered).toBe(true);
    expect(third.text.startsWith("3.")).toBe(true);
    expect(gprStageLabel({ name: "Подготовка" }).numbered).toBe(false);
    expect(first.text).not.toBe(third.text);
    expect(first.title).toContain("П-12Р");
    expect(third.title).toContain("П-2к");
  });

  it("uses the same words for the board and the review status", () => {
    expect(REVIEW_LABELS.novaya).toBe("Новое");
    expect(REVIEW_LABELS.na_rassmotrenii).toBe("В работе");
    expect(REVIEW_LABELS.na_rassmotrenii).toBe(procurementBoardLabel({ reviewStatus: "na_rassmotrenii" }));
  });

  it("names a rejected card the same way as the closed column", () => {
    expect(procurementBoardLabel({ reviewStatus: "otklonena" })).toBe("Закрыто и не реализовано");
    expect(procurementBoardLabel({ reviewStatus: "dublirovana" })).toBe("Закрыто и не реализовано");
    expect(displayedKanbanColumn({ reviewStatus: "otklonena" })).toBe("closed_not_realized");
  });
});
