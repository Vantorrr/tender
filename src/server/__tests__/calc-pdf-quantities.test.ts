import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { formatNumber, formatQuantity } from "@/lib/format";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { buildCalculationPdf } from "@/server/export";
import { createManualProcurement, sendProcurementToCalculation, updateCalculation } from "@/server/repo";
import "./setup";

function pdfText(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calc-pdf-"));
  const pdfPath = path.join(dir, "out.pdf");
  fs.writeFileSync(pdfPath, buf);
  try {
    return execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("calculation PDF quantities", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("prints absolute quantities, a difference, and labour words", async () => {
    const created = createManualProcurement("u-ruk", { title: "PDF возвраты", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    updateCalculation("u-ruk", draft.id, {
      positions: [
        { id: "cable", code: "М-1", name: "Кабель", unit: "м", quantity: -7.16, rate: 10 },
        { id: "water", code: "М-2", name: "Вода", unit: "м3", quantity: -164.68, rate: 20 },
        { id: "labor", code: "ЗТ", name: "ЗТ", unit: "чел.-ч", quantity: 12, rate: 100 },
        { id: "drivers", code: "ЗТм", name: "ЗТм", unit: "чел.-ч", quantity: 4, rate: 80 },
      ],
    });
    const text = pdfText(await buildCalculationPdf(draft.id)).replace(/\s+/g, " ");
    expect(text).toContain("Разница");
    expect(text).toContain(formatQuantity(7.16, "м"));
    expect(text).toContain(`Разница ${formatNumber(-7.16)}`);
    expect(text).toContain(formatQuantity(164.68, "м3"));
    expect(text).toContain(`Разница ${formatNumber(-164.68)}`);
    expect(text).not.toContain(`${formatNumber(-7.16)} м`);
    expect(text).not.toContain(`${formatNumber(-164.68)} м3`);
    expect(text).toContain("Затраты труда");
    expect(text).toContain("Затраты труда машинистов");
    expect(text).not.toMatch(/(?:^|[\s·])ЗТм?(?:$|[\s·])/u);
  });
});
