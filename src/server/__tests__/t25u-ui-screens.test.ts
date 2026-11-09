import { beforeEach, describe, expect, it } from "vitest";
import {
  planResourceLinesForDay,
  stageMatchesWork,
  stagesForWork,
} from "@/lib/day-resource-plan";
import {
  buildHierarchicalEstimate,
  estimateBudgetCards,
} from "@/lib/hierarchical-estimate";
import type { CalcPosition, GprStage } from "@/lib/types";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { addDailyProductionFact } from "@/server/repo";
import "./setup";

describe("t25u hierarchical estimate (PDF UI / Excel arithmetic)", () => {
  it("builds stage → Люди/Техника/Материалы tree with shared dimensions", () => {
    const stages: GprStage[] = [
      {
        id: "st1",
        name: "Мобилизация",
        sequence: 1,
        start: "2026-01-01",
        end: "2026-01-05",
        resources: [
          {
            id: "r1",
            kind: "labor",
            name: "Монтажник",
            unit: "чел",
            quantity: 4,
            rate: 2500,
            // Explicit dims so Q=L (identity) — not silent calendar invent
            quantityBasis: "count_per_shift",
            hoursPerShift: 1,
            shiftsPerDay: 1,
            days: 1,
          },
          {
            id: "r2",
            kind: "equipment",
            name: "Кран",
            unit: "маш.-ч",
            quantity: 8,
            rate: 5000,
            // total_hours via dotted unit — must NOT re-multiply
          },
          {
            id: "r3",
            kind: "material",
            name: "Щебень",
            unit: "т",
            quantity: 10,
            rate: null,
          },
        ],
      },
    ];
    const positions: CalcPosition[] = [];
    const nodes = buildHierarchicalEstimate({ stages, positions });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].groups.map((g) => g.label)).toEqual([
      "Люди",
      "Техника",
      "Материалы",
    ]);
    const labor = nodes[0].groups.find((g) => g.kind === "labor")!;
    expect(labor.leaves[0].amount).toBe(10000);
    expect(labor.leaves[0].hoursQ).toBe(4);
    const eq = nodes[0].groups.find((g) => g.kind === "equipment")!;
    expect(eq.leaves[0].basis).toBe("total_hours");
    expect(eq.leaves[0].amount).toBe(40000);
    const mat = nodes[0].groups.find((g) => g.kind === "material")!;
    expect(mat.incomplete).toBe(true);
    expect(mat.leaves[0].amount).toBeNull();
    const cards = estimateBudgetCards(nodes);
    expect(cards.labor).toBe(10000);
    expect(cards.equipment).toBe(40000);
    expect(cards.incomplete).toBe(true);
  });
});

describe("t25u day resource scoping", () => {
  const stages: GprStage[] = [
    {
      id: "gs-2",
      name: "Демонтаж и подготовка оснований",
      workName: "Демонтаж перегородок",
      start: "2026-11-01",
      end: "2026-11-25",
      sequence: 2,
      resources: [
        {
          id: "a",
          kind: "labor",
          name: "Демонтажник",
          unit: "чел",
          quantity: 10,
          rate: 1054,
        },
        {
          id: "b",
          kind: "bus",
          name: "Автобус доставки",
          unit: "ед",
          quantity: 1,
          rate: 2650,
        },
        {
          id: "c",
          kind: "material",
          name: "Контейнеры под бой",
          unit: "шт",
          quantity: 8,
          rate: 4500,
        },
      ],
    },
    {
      id: "gs-4",
      name: "Кровля и фасад",
      workName: "Кровля и фасад",
      start: "2027-01-10",
      end: "2027-03-15",
      sequence: 4,
      resources: [
        {
          id: "d",
          kind: "labor",
          name: "Кровельщик",
          unit: "чел",
          quantity: 4,
          rate: null,
        },
      ],
    },
  ];

  it("matches only by workName, not soft includes", () => {
    expect(stageMatchesWork(stages[0], "Демонтаж перегородок")).toBe(true);
    expect(stageMatchesWork(stages[0], "Кровля и фасад")).toBe(false);
    expect(stageMatchesWork(stages[1], "Демонтаж перегородок")).toBe(false);
  });

  it("returns empty when work not linked — no whole-GPR dump", () => {
    expect(stagesForWork(stages, "Неизвестная работа")).toEqual([]);
    expect(
      planResourceLinesForDay(stages, "2026-11-08", "Неизвестная работа")
    ).toEqual([]);
  });

  it("scopes resources to linked stage+date; bus is present but not labor-only", () => {
    const lines = planResourceLinesForDay(
      stages,
      "2026-11-08",
      "Демонтаж перегородок"
    );
    expect(lines.map((l) => l.name)).toEqual([
      "Демонтажник",
      "Автобус доставки",
      "Контейнеры под бой",
    ]);
    expect(lines.some((l) => /Кровл/i.test(l.name))).toBe(false);
    expect(lines.find((l) => l.kind === "bus")).toBeTruthy();
    // date outside → empty
    expect(
      planResourceLinesForDay(stages, "2027-02-01", "Демонтаж перегородок")
    ).toEqual([]);
  });
});

describe("t25u day details resourceLines persistence", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("stores resourceLines on daily fact and reloads", () => {
    const data = readAppData();
    const pf = data.planFacts.find((p) => p.id === "pf-1") ?? data.planFacts[0];
    expect(pf).toBeTruthy();
    const work = "Демонтаж перегородок";
    addDailyProductionFact("u-obj", pf.id, {
      date: "2026-11-08",
      workName: work,
      unit: "м²",
      quantity: 12,
      resourceLines: [
        {
          kind: "labor",
          name: "Демонтажник",
          unit: "чел",
          planQty: 10,
          factQty: 9,
        },
        {
          kind: "material",
          name: "Контейнеры под бой",
          unit: "шт",
          planQty: 8,
          factQty: 7,
        },
      ],
    });
    const after = readAppData();
    const pf2 = after.planFacts.find((p) => p.id === pf.id)!;
    const day = (pf2.dailyFacts ?? []).find(
      (d) => d.date === "2026-11-08" && d.workName === work && d.quantity === 12
    );
    expect(day?.resourceLines?.[0]?.kind).toBe("labor");
    expect(day?.resourceLines?.[0]?.factQty).toBe(9);
  });

  it("school g-1 keeps original Dec'26 window (no auto-mod for screens)", () => {
    const g1 = readAppData().schedules.find((s) => s.id === "g-1")!;
    const gs2 = g1.stages.find((s) => s.id === "gs-2")!;
    expect(gs2.start).toBe("2026-12-21");
    expect(gs2.end).toBe("2027-01-25");
    expect(gs2.workName).toBeUndefined();
  });

  it("isolated [TEST] fixture exists without rewriting school", () => {
    const data = readAppData();
    const testG = data.schedules.find((s) => s.id === "g-t25u-test")!;
    const school = data.schedules.find((s) => s.id === "g-1")!;
    expect(testG.title).toMatch(/\[TEST\]/);
    expect(testG.stages.some((s) => s.workName === "Демонтаж перегородок")).toBe(
      true
    );
    expect(school.title).not.toMatch(/\[TEST\]/);
    expect(school.stages.find((s) => s.id === "gs-1")?.start).toBe("2026-12-01");
  });

  it("migration does not rewrite existing school stage dates", () => {
    const before = structuredClone(
      readAppData().schedules.find((s) => s.id === "g-1")!.stages
    );
    // Force another ensureReady / schema path
    closeDb();
    ensureReady();
    const after = readAppData().schedules.find((s) => s.id === "g-1")!.stages;
    expect(after.map((s) => ({ id: s.id, start: s.start, end: s.end }))).toEqual(
      before.map((s) => ({ id: s.id, start: s.start, end: s.end }))
    );
  });
});
