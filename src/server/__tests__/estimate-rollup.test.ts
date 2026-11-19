import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { alignVolumeToSections, rollupWorkSections } from "@/server/estimate-rollup";
import { parseGrandBuffer } from "@/server/grand-smeta";

describe("estimate section rollup", () => {
  it("sums every drilling section and the wells named in the headings", async () => {
    const filePath = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    const parsed = await parseGrandBuffer(fs.readFileSync(filePath));
    const rollup = rollupWorkSections(parsed?.positions ?? []);
    expect(rollup.sections.map((section) => section.quantity)).toEqual([716, 17076, 720, 32]);
    expect(rollup.totalsByUnit).toEqual([{ unit: "м", quantity: 18544, rows: 4 }]);
    expect(rollup.titledCounts).toEqual([{ unit: "шт", quantity: 3044 }]);
  });

  it("does not count an overhead norm as a drilling section", () => {
    const rollup = rollupWorkSections([
      { sectionName: "Раздел 1. Бурение скважин", name: "Бурение", code: "ФЕР01", unit: "м", quantity: 716, isWorkItem: true },
      { sectionName: "НР Свайные работы", name: "НР Свайные работы", code: "НР", unit: "шт", quantity: 3044, isWorkItem: true },
    ]);
    expect(rollup.sections.map((section) => section.section)).toEqual(["Раздел 1. Бурение скважин"]);
  });

  it("keeps a counted well as a well when a norm line says piles", () => {
    const rollup = rollupWorkSections([
      { sectionName: "Раздел 2. Бурение скважин 3044 шт", name: "Бурение скважин", code: "ФЕР01", unit: "м", quantity: 18544, isWorkItem: true },
      { sectionName: "НР Свайные работы", name: "НР Свайные работы", code: "НР", unit: "шт", quantity: 3044, isWorkItem: true },
    ]);
    expect(alignVolumeToSections("и установку 3044 шт. свай", rollup)).toContain("скважин");
    expect(alignVolumeToSections("и установку 3044 шт. свай", rollup)).not.toContain("свай");
    expect(alignVolumeToSections("4 раздела бурения на 18544 м", rollup)).toContain("бурения");
  });
});
