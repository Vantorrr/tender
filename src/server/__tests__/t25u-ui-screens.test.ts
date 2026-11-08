import { beforeEach, describe, expect, it } from "vitest";
import {
  buildHierarchicalEstimate,
  estimateBudgetCards,
} from "@/lib/hierarchical-estimate";
import type { CalcPosition, GprStage } from "@/lib/types";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { addDailyProductionFact } from "@/server/repo";
import "./setup";

describe("t25u hierarchical estimate (PDF UI / Excel arithmetic)", () => {
  it("builds stage → Люди/Техника/Материалы tree with qty×rate", () => {
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
          },
          {
            id: "r2",
            kind: "equipment",
            name: "Кран",
            unit: "маш-ч",
            quantity: 8,
            rate: 5000,
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
    const mat = nodes[0].groups.find((g) => g.kind === "material")!;
    expect(mat.incomplete).toBe(true);
    expect(mat.leaves[0].amount).toBeNull();
    const cards = estimateBudgetCards(nodes);
    expect(cards.labor).toBe(10000);
    expect(cards.equipment).toBe(40000);
    expect(cards.incomplete).toBe(true);
  });
});

describe("t25u day details resourceLines persistence", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("stores resourceLines on daily fact and reloads", () => {
    const data = readAppData();
    const pf = data.planFacts[0];
    expect(pf).toBeTruthy();
    const work = pf.entries[0]?.workName ?? "Общий объём";
    addDailyProductionFact("u-obj", pf.id, {
      date: "2026-11-08",
      workName: work,
      unit: pf.entries[0]?.unit ?? "%",
      quantity: 3,
      resourceLines: [
        {
          kind: "labor",
          name: "Монтажник",
          unit: "чел",
          planQty: 4,
          factQty: 3,
        },
        {
          kind: "material",
          name: "Щебень",
          unit: "т",
          planQty: 10,
          factQty: 9,
        },
      ],
    });
    const after = readAppData();
    const pf2 = after.planFacts.find((p) => p.id === pf.id)!;
    const day = (pf2.dailyFacts ?? []).find(
      (d) => d.date === "2026-11-08" && d.workName === work && d.quantity === 3
    );
    expect(day?.resourceLines).toEqual([
      {
        kind: "labor",
        name: "Монтажник",
        unit: "чел",
        planQty: 4,
        factQty: 3,
      },
      {
        kind: "material",
        name: "Щебень",
        unit: "т",
        planQty: 10,
        factQty: 9,
      },
    ]);
  });
});
