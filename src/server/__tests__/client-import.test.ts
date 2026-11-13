import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { importClientDirectories } from "@/server/client-import";
import "./setup";

describe("client directory workbook import", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("imports 2026 equipment tariffs, labor rates and fleet from the supplied xlsx files", async () => {
    const result = await importClientDirectories("u-super");
    const data = readAppData();
    const equipment = data.directories.find((item) => item.type === "ceny" && item.current)!;
    const labor = data.directories.find((item) => item.type === "rascenki" && item.current)!;
    const fleet = data.directories.find((item) => item.type === "park" && item.current)!;

    expect(result.source).toBe("xlsx");
    expect(result).toMatchObject({ equipment: 69, labor: 57, fleet: 77 });
    expect(result.files).toEqual([
      "tarify-ats-dsm-2026.xlsx",
      "sebestoimost-normochas.xlsx",
      "park-tehniki.xlsx",
    ]);
    expect(equipment.rows).toHaveLength(69);
    expect(equipment.rows).toContainEqual(expect.objectContaining({
      name: "ПАЗ 32054",
      unit: "руб/маш-час",
      rate_1s_kpi085: 2990,
    }));
    expect(labor.rows).toHaveLength(57);
    expect(labor.rows).toContainEqual(expect.objectContaining({
      work: "Кладовщик",
      unit: "руб/н-ч",
      rate: 881,
    }));
    expect(fleet.rows).toHaveLength(77);
    expect(fleet.rows).toContainEqual(expect.objectContaining({
      name: "ПАЗ 32054",
      qty: 1,
      unit: "ед.",
    }));
  });
});
