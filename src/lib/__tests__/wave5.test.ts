import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calculationArticleName, calculationBreakdownRows } from "@/lib/calculation-breakdown";
import { linkedWorkRows } from "@/lib/gpr-linked-rows";
import { SUMMARY_FRESH, SUMMARY_UNCHANGED, summaryRefreshNotice } from "@/lib/summary-notice";
import { visibleProcurementSource } from "@/lib/display";
import { recentPaymentId } from "@/lib/duplicate-click";
import { parseCommittedQuantity } from "@/lib/quantity-draft";
import { procurementBoardLabel } from "@/lib/pipeline";
import { neutralizeProcurementJargon, sanitizeSyncDetail } from "@/lib/wave23";
import type { CalcPosition, GprStage } from "@/lib/types";

describe("wave 5 visible copy and breakdown", () => {
  it("names an article without the estimate code", () => {
    expect(calculationArticleName({
      code: "ФЕР05-01-055-05",
      name: "Кладовщик",
      sourceSectionName: "Раздел 1",
    })).toBe("Кладовщик");
    expect(calculationArticleName({
      code: "ФЕР05-01-055-05",
      name: "ФЕР05-01-055-05",
      sourceWorkName: "Бурение скважин",
    })).toBe("Бурение скважин");
  });

  it("builds a file, sheet and section for each priced line", () => {
    const positions: CalcPosition[] = [
      {
        id: "work",
        code: "ФЕР-1",
        name: "Бурение",
        unit: "м",
        quantity: 10,
        rate: 0,
        isWorkItem: true,
      },
      {
        id: "labor",
        code: "ЗТ",
        name: "Кладовщик",
        unit: "чел.-ч",
        quantity: 2,
        rate: 881,
        sourceDocumentId: "doc-1",
        sourceSectionName: "Люди",
      },
      {
        id: "missing",
        code: "ФССЦ-1",
        name: "Вода",
        unit: "м3",
        quantity: 1,
        rate: 0,
        rateMissing: true,
        sourceDocumentId: "doc-1",
        sourceSectionName: "Материалы",
      },
    ];
    const rows = calculationBreakdownRows(positions, [{
      id: "doc-1",
      fileName: "Смета.xlsx",
      title: "Смета",
      citations: [{ id: "c1", sourceFile: "Смета.xlsx", text: "Кладовщик", sheet: "Лист1", page: 1 }],
    }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      what: "Кладовщик",
      amount: 1762,
      fileName: "Смета.xlsx",
      place: "лист Лист1 · раздел Люди",
      href: "/cabinet/dokumenty/doc-1?sheet=%D0%9B%D0%B8%D1%81%D1%821",
    });
    expect(rows[0].what).not.toMatch(/ФЕР|ЗТ/);
    expect(rows[1].amount).toBeNull();
  });

  it("collapses a repeated click on the same payment", () => {
    const now = 1_700_000_000_000;
    const id = recentPaymentId([
      { id: `pay-${now - 500}`, type: "postuplenie", title: "2 этап", amount: 1000, date: "2026-12-01" },
    ], { type: "postuplenie", title: "2 этап", amount: 1000, date: "2026-12-01" }, now);
    expect(id).toBe(`pay-${now - 500}`);
    expect(recentPaymentId([
      { id: `pay-${now - 500}`, type: "postuplenie", title: "2 этап", amount: 1000, date: "2026-12-01" },
    ], { type: "spisanie", title: "2 этап", amount: 1000, date: "2026-12-01" }, now)).toBeNull();
  });

  it("rejects an empty quantity and keeps a typed decimal", () => {
    expect(parseCommittedQuantity("")).toMatchObject({ ok: false });
    expect(parseCommittedQuantity("-1")).toMatchObject({ ok: false });
    expect(parseCommittedQuantity("12,5")).toEqual({ ok: true, value: 12.5 });
  });

  it("uses one board status and a neutral source name", () => {
    expect(procurementBoardLabel({ reviewStatus: "na_rassmotrenii" })).toBe("В работе");
    expect(procurementBoardLabel({ reviewStatus: "odobrena", lifecycle: "production" })).toBe("В производстве");
    expect(visibleProcurementSource("Контур.Закупки API")).toBe("Площадка");
    expect(visibleProcurementSource("manual")).toBe("Создано вручную");
  });

  it("strips vendor and protocol words from status text", () => {
    const cleaned = sanitizeSyncDetail("Контур API: ключ не задан, ID закупки Контура пуст");
    expect(cleaned).not.toMatch(/Контур|\bAPI\b|ID закупки/);
    expect(neutralizeProcurementJargon("Документ API")).toBe("файл");
    expect(sanitizeSyncDetail("Источник закупок не подключён.")).toBe("Источник закупок не подключён.");
  });

  it("keeps live dates in the work table when only the chart filter ids stay the same", () => {
    const before = [
      { id: "a", name: "Демонтаж", start: "2026-12-01", end: "2026-12-05", sequence: 1 },
      { id: "b", name: "Монтаж", start: "2026-12-06", end: "2026-12-10", sequence: 2 },
    ] as GprStage[];
    const shifted = before.map((stage) => stage.id === "a" ? { ...stage, start: "2026-12-03", end: "2026-12-08" } : stage);
    expect(linkedWorkRows(shifted, ["a", "b"]).map((stage) => stage.start)).toEqual(["2026-12-03", "2026-12-06"]);
    expect(linkedWorkRows(shifted, ["b"]).map((stage) => stage.name)).toEqual(["Монтаж"]);
    expect(linkedWorkRows(shifted, null).map((stage) => stage.id)).toEqual(["a", "b"]);
  });

  it("says the note is already current only when the text is the same", () => {
    expect(summaryRefreshNotice("Записка", "Записка")).toBe(SUMMARY_UNCHANGED);
    expect(summaryRefreshNotice("Записка", "  Записка  ")).toBe(SUMMARY_UNCHANGED);
    expect(summaryRefreshNotice("Записка", "Новая записка")).toBe(SUMMARY_FRESH);
    expect(summaryRefreshNotice("", "Записка")).toBe(SUMMARY_FRESH);
  });

  it("keeps cabinet and component copy free of internal procurement words", () => {
    const roots = ["src/app/cabinet", "src/components"];
    const forbidden = /Контур|Документ API|ID закупки|\bAPI\b/u;
    const offenders: string[] = [];
    for (const root of roots) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".tsx")) {
            const text = fs.readFileSync(full, "utf8");
            if (forbidden.test(text)) offenders.push(full);
          }
        }
      };
      walk(path.join(process.cwd(), root));
    }
    expect(offenders).toEqual([]);
  });
});
