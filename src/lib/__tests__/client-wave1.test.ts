import { describe, expect, it } from "vitest";
import { parseDecimalRu } from "@/lib/decimal-ru";
import { formatDate, formatDateTime } from "@/lib/format";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import { humanizeIssue, humanizeIssues } from "@/lib/issue-text";
import { paymentAmountError, paymentBucket, paymentTotals } from "@/lib/money-payments";
import { displayedKanbanColumn } from "@/lib/pipeline";
import type { GprStage } from "@/lib/types";

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
});
