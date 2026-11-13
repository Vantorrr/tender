import { describe, expect, it } from "vitest";
import { formatDate, parseDateRu } from "@/lib/format";
import { stageResourceSummary } from "@/lib/gpr-stage-cost";
import { stageMatchesWork } from "@/lib/day-resource-plan";
import { pickLastExchangeForProcurement } from "@/lib/obmen-for-procurement";
import { allocatePlanForSlice } from "@/lib/plan-from-gpr";
import type { GprStage } from "@/lib/types";

describe("t33u day plan % of contract (not dayPlan/dayPlan)", () => {
  it("day slice percent is share of contract plan, never tautological 100%", () => {
    const stages: GprStage[] = [
      {
        id: "s1",
        name: "Этап",
        workName: "Работа А",
        start: "2026-11-01",
        end: "2026-11-10",
        sequence: 1,
      },
    ];
    const contractPlan = 100;
    const day = allocatePlanForSlice(contractPlan, stages, "day", "2026-11-05").plan;
    expect(day).toBeGreaterThan(0);
    expect(day).toBeLessThan(contractPlan);
    const pct = Math.round((day / contractPlan) * 100);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
    // Bugbot: dayPlan / max(dayPlan,1) was always 100
    expect(Math.round((day / Math.max(day, 1)) * 100)).toBe(100);
  });
});

describe("t33u Gantt cost uses hour formula (Q×M)", () => {
  it("golden bus 2×11×1×3×2650 = 174900, not qty×rate=5300", () => {
    const stage: GprStage = {
      id: "gst-2",
      name: "Демонтаж",
      workName: "Демонтаж перегородок",
      start: "2026-11-08",
      end: "2026-11-10",
      sequence: 2,
      resources: [
        {
          id: "rst-2-bus",
          kind: "bus",
          name: "Автобус доставки",
          quantity: 2,
          unit: "ед",
          rate: 2650,
          quantityBasis: "count_per_shift",
          hoursPerShift: 11,
          shiftsPerDay: 1,
          days: 3,
        },
      ],
    };
    const summary = stageResourceSummary(stage);
    expect(summary.cost).toBe(174_900);
    expect(summary.busCost).toBe(174_900);
    expect(summary.incomplete).toBe(false);
    // Wrong legacy formula:
    expect(2 * 2650).toBe(5300);
  });

  it("Демонтаж stage sum includes bus 174900 and matches line rollup", () => {
    // Mirror t25u fixture gst-2 resources (calc model byte-identical).
    const stage: GprStage = {
      id: "gst-2",
      name: "Демонтаж [TEST]",
      workName: "Демонтаж перегородок",
      start: "2026-11-01",
      end: "2026-11-20",
      sequence: 2,
      resources: [
        {
          id: "rst-2-labor",
          kind: "labor",
          name: "Демонтажник",
          quantity: 10,
          unit: "чел",
          rate: 1054,
        },
        {
          id: "rst-2-labor-2",
          kind: "labor",
          name: "Электрогазосварщик 3 разряда",
          quantity: 2,
          unit: "чел",
          rate: 1376,
        },
        {
          id: "rst-2-mat",
          kind: "material",
          name: "Контейнеры под бой",
          quantity: 8,
          unit: "шт",
          rate: 4500,
        },
        {
          id: "rst-2-eq",
          kind: "equipment",
          name: "JCB 5 CX",
          quantity: 2,
          unit: "маш",
          rate: 5800,
        },
        {
          id: "rst-2-bus",
          kind: "bus",
          name: "Автобус доставки",
          quantity: 2,
          unit: "ед",
          rate: 2650,
          quantityBasis: "count_per_shift",
          hoursPerShift: 11,
          shiftsPerDay: 1,
          days: 3,
        },
      ],
    };
    const summary = stageResourceSummary(stage);
    expect(summary.busCost).toBe(174_900);
    expect(summary.incomplete).toBe(false);
    const lineSum = summary.lines.reduce(
      (s, line) => s + (line.amount ?? 0),
      0
    );
    expect(summary.cost).toBe(lineSum);
    expect(summary.cost).toBeGreaterThan(174_900);
    const busLine = summary.lines.find((l) => l.resourceId === "rst-2-bus");
    expect(busLine?.amount).toBe(174_900);
  });

  it("Мобилизация «неполно» is honest missing tariff, not a cost-formula bug", () => {
    const stage: GprStage = {
      id: "gst-1",
      name: "Мобилизация [TEST]",
      workName: "Мобилизация",
      start: "2026-10-25",
      end: "2026-11-02",
      sequence: 1,
      resources: [
        {
          id: "rst-1-labor",
          kind: "labor",
          name: "Дорожный рабочий",
          quantity: 4,
          unit: "чел",
          rate: 1054,
        },
        {
          id: "rst-1-eq",
          kind: "equipment",
          name: "JCB 5 CX мобилизация",
          quantity: 1,
          unit: "маш",
          rate: 5800,
        },
        {
          id: "rst-1-mat",
          kind: "material",
          name: "Материалы мобилизации",
          quantity: 1,
          unit: "компл",
          rate: null,
        },
        {
          id: "rst-1-bus",
          kind: "bus",
          name: "Автобус мобилизации",
          quantity: 1,
          unit: "ед",
          rate: 2650,
          quantityBasis: "count_per_shift",
          hoursPerShift: 11,
          shiftsPerDay: 1,
          days: 2,
        },
      ],
    };
    const summary = stageResourceSummary(stage);
    expect(summary.incomplete).toBe(true);
    expect(summary.incompleteHint).toBe("нет тарифа");
    expect(summary.cost).not.toBeNull();
    expect(summary.busCost).toBe(1 * 11 * 1 * 2 * 2650); // 58_300
    const mat = summary.lines.find((l) => l.resourceId === "rst-1-mat");
    expect(mat?.amount).toBeNull();
    expect(mat?.incomplete.some((x) => x.startsWith("missing_tariff:"))).toBe(
      true
    );
  });
});

describe("t33u DateInputRu / parseDateRu timezone + invalid", () => {
  it("formats and parses calendar days in UTC (no local TZ shift)", () => {
    expect(formatDate("2026-11-08")).toBe("08.11.2026");
    expect(parseDateRu("08.11.2026")).toBe("2026-11-08");
    expect(parseDateRu("1.3.2026")).toBe("2026-03-01");
    expect(parseDateRu("")).toBeNull();
    expect(parseDateRu("не дата")).toBeNull();
    expect(parseDateRu("31.02.2026")).toBeNull();
    expect(parseDateRu("2026-11-08")).toBe("2026-11-08");
  });

  it("Enter+blur must not emit the same ISO twice (Gantt double-shift)", async () => {
    const { nextEmittedIso } = await import("@/components/date-input-ru");
    const first = nextEmittedIso("2026-11-01", "2026-11-03");
    expect(first).toBe("2026-11-03");
    // Second commit before parent re-renders (same as Enter then blur):
    expect(nextEmittedIso(first!, "2026-11-03")).toBeNull();
  });
});

describe("t33u Obmen — no org-wide fallback on procurement card", () => {
  it("returns undefined when no exchange names this procurement", () => {
    const picked = pickLastExchangeForProcurement(
      [
        {
          orgId: "org-alfa",
          name: "Импорт из Гранд-Смета — другой объект",
          at: "2026-11-10T12:00:00Z",
        },
        {
          orgId: "org-alfa",
          name: "Экспорт — ещё один проект",
          at: "2026-11-11T12:00:00Z",
        },
      ],
      {
        orgId: "org-alfa",
        procurementId: "p-school",
        procurementNumber: "ЗК-12",
        originalCalculationId: "c-orig-school",
      }
    );
    expect(picked).toBeUndefined();
  });

  it("picks the matching exchange by procurement id / number, not a newer unrelated one", () => {
    const picked = pickLastExchangeForProcurement(
      [
        {
          orgId: "org-alfa",
          name: "Чужой свежий обмен",
          at: "2026-11-12T12:00:00Z",
        },
        {
          orgId: "org-alfa",
          name: "Смета заказчика · file.xlsx · ЗК-12 · p-school",
          at: "2026-11-08T12:00:00Z",
        },
      ],
      {
        orgId: "org-alfa",
        procurementId: "p-school",
        procurementNumber: "ЗК-12",
      }
    );
    expect(picked?.name).toContain("p-school");
  });
});

describe("t33u work-stage matching consistency", () => {
  it("does not treat stage.name alone as a work link", () => {
    const stage: GprStage = {
      id: "gs-2",
      name: "Демонтаж и подготовка оснований",
      workName: "Демонтаж перегородок",
      start: "2026-11-01",
      end: "2026-11-25",
      sequence: 2,
    };
    expect(stageMatchesWork(stage, "Демонтаж перегородок")).toBe(true);
    expect(stageMatchesWork(stage, "Демонтаж и подготовка оснований")).toBe(false);
    expect(
      stageMatchesWork(
        { ...stage, workNames: ["Штукатурка стен"], workName: undefined },
        "Штукатурка стен"
      )
    ).toBe(true);
  });
});
