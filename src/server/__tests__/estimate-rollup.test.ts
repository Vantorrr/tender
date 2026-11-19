import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { alignVolumeToSections, rollupWorkSections, stripWorkTypesOutsideSources } from "@/server/estimate-rollup";
import { parseGrandBuffer } from "@/server/grand-smeta";

describe("estimate section rollup", () => {
  it("sums every drilling section and the wells named in the headings", async () => {
    const filePath = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    const parsed = await parseGrandBuffer(fs.readFileSync(filePath));
    const rollup = rollupWorkSections(parsed?.positions ?? []);
    expect(rollup.sections.map((section) => section.quantity)).toEqual([716, 17076, 720, 32]);
    expect(rollup.totalsByUnit).toEqual([{ unit: "м", quantity: 18544, rows: 4 }]);
    expect(rollup.titledCounts).toEqual([{ unit: "шт", quantity: 3044 }]);
    expect(parsed?.factCells.filter((fact) => fact.kind === "indexes").map((fact) => fact.cell)).toEqual(["A8", "P8"]);
    expect(parsed?.factCells.filter((fact) => fact.kind === "wages").map((fact) => fact.cell)).toContain("A9");
    expect(parsed?.factCells.some((fact) => fact.kind === "negative" && fact.cell.endsWith("58"))).toBe(true);
    expect(parsed?.factCells.some((fact) => fact.kind === "negative" && fact.cell.endsWith("61"))).toBe(true);
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

  it("drops a work type that the cited excerpt does not contain", () => {
    const sections = ["Раздел 1. Бурение скважин под неподвижные опоры"];
    const stripped = stripWorkTypesOutsideSources(
      "Работы включают бурение скважин и установку свай.",
      "конденсатопровод Мессояха–Дудинка",
      sections
    );
    expect(stripped).not.toMatch(/сва/iu);
    expect(stripped).not.toMatch(/бурен/iu);
    const kept = stripWorkTypesOutsideSources(
      "Работы включают бурение скважин и установку свай.",
      "Бурение скважин под опоры",
      sections
    );
    expect(kept).toMatch(/бурение скважин/iu);
    expect(kept).not.toMatch(/сва/iu);
    const piles = stripWorkTypesOutsideSources(
      "Нужна установка свай.",
      "Установка свай на площадке",
      ["Раздел 3. Установка свай"]
    );
    expect(piles).toMatch(/установка свай/iu);
  });
});
