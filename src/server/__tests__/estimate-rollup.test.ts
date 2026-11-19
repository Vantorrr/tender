import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rollupWorkSections } from "@/server/estimate-rollup";
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
});
