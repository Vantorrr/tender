import { describe, expect, it } from "vitest";
import { parseResourcePaste } from "@/components/spreadsheet-estimate-grid";

describe("resource spreadsheet paste", () => {
  it("imports a copied A–Z resource row from Egor's source sheet", () => {
    const columns = Array.from({ length: 26 }, () => "");
    columns[2] = "↳ Пикап/вахтовка";
    columns[8] = "РЕСУРС";
    columns[9] = "Техника/оснастка";
    columns[10] = "Вахтовый автобус КАМАЗ 43118";
    columns[11] = "2";
    columns[12] = "2650";
    columns[13] = "11";
    columns[14] = "1";
    columns[15] = "3";

    const result = parseResourcePaste(columns.join("\t"));

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        kind: "equipment",
        name: "Пикап/вахтовка",
        unit: "ед.",
        quantity: 2,
        rate: 2650,
        quantityBasis: "count_per_shift",
        hoursPerShift: 11,
        shiftsPerDay: 1,
        days: 3,
      },
    ]);
  });

  it("imports compact tab-separated rows and reports unsupported categories", () => {
    const valid = parseResourcePaste("Вахтовый автобус\tАвтобус\tмаш\t2\t2650\t11\t1\t20");
    expect(valid.errors).toEqual([]);
    expect(valid.rows[0]).toMatchObject({ kind: "bus", quantity: 2, rate: 2650, days: 20 });

    const invalid = parseResourcePaste("Ресурс\tНеизвестно\tед\t2\t100");
    expect(invalid.rows).toEqual([]);
    expect(invalid.errors).toHaveLength(1);
  });
});
