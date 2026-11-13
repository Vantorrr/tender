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
    expect(summary.incomplete).toBe(false);
    // Wrong legacy formula:
    expect(2 * 2650).toBe(5300);
  });

  it("sums labor+equipment+material with resolveResourceDimensions", () => {
    const stage: GprStage = {
      id: "s",
      name: "S",
      start: "2026-11-01",
      end: "2026-11-01",
      sequence: 1,
      resources: [
        {
          id: "m",
          kind: "material",
          name: "Щебень",
          quantity: 10,
          unit: "т",
          rate: 100,
          quantityBasis: "material_qty",
        },
        {
          id: "l",
          kind: "labor",
          name: "Монтажник",
          quantity: 66,
          unit: "чел.-ч",
          rate: 1400,
          quantityBasis: "total_hours",
        },
      ],
    };
    const summary = stageResourceSummary(stage);
    expect(summary.cost).toBe(10 * 100 + 66 * 1400);
    expect(summary.labor).toBe(66);
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
