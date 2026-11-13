import { describe, expect, it } from "vitest";
import { defaultStageResources, ensureStageResources } from "@/lib/gpr-resources";
import type { GprStage } from "@/lib/types";

describe("unconfirmed GPR resource rows", () => {
  it("uses empty, explicitly uncertain defaults instead of invented quantities", () => {
    const rows = defaultStageResources("stage-1", 6, "Подготовка");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.quantity === 0 && row.rate == null && row.quantityBasis === "uncertain")).toBe(true);
  });

  it("preserves user rows when filling missing resource categories", () => {
    const custom = {
      id: "custom-labor",
      kind: "labor" as const,
      name: "Подтверждённая бригада",
      quantity: 9,
      unit: "чел",
      rate: 1800,
      quantityBasis: "count_per_shift" as const,
    };
    const stage: GprStage = {
      id: "stage-2",
      name: "Монтаж",
      start: "2026-12-01",
      end: "2026-12-01",
      sequence: 1,
      resources: [custom],
    };

    const ensured = ensureStageResources(stage);

    expect(ensured.resources?.[0]).toEqual(custom);
    expect(ensured.resources).toHaveLength(4);
    expect(ensured.resources?.slice(1).every((row) => row.quantity === 0 && row.quantityBasis === "uncertain")).toBe(true);
  });
});
