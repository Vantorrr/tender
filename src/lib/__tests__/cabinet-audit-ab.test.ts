import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pack from "@/lib/grand-reference.json";
import { presentAnalyticalNote } from "@/lib/analytical-note";
import { citationTextForDisplay, isBareBasisText, isShownConfirmation } from "@/lib/citation-display";
import { formatMoney } from "@/lib/format";
import { plainUserMessage } from "@/lib/plain-user-message";
import { visibleCheckItems } from "@/lib/project-analytics";
import { collectSuppliersMessage, gprNeedNextStep, gprPathAfterUndo, searchSupplierDirectory, showEmptyExternalSupplierLine } from "@/lib/supplier-directory";
import { neutralizeProcurementJargon } from "@/lib/wave23";
import type { Citation } from "@/lib/types";

describe("cabinet audit packages A and B", () => {
  it("repairs appendix-8 cuts and glued words only on screen", () => {
    const drilling = pack.documents.find((document) => document.id === "d-gs-bur");
    expect(drilling).toBeTruthy();
    const stored = drilling!.analyticalNote;
    const shown = presentAnalyticalNote(`${stored}\nКоэффициент потранспиляции в тексте.`);
    expect(stored).toContain("стес");
    expect(stored).toContain("прил.8");
    expect(drilling!.analyticalNote).toBe(stored);
    expect(shown.text).toContain("разветвленная сеть");
    expect(shown.text).toContain("469");
    expect(shown.text).not.toMatch(/потранспиляц|\bстес\b/);
    expect(shown.text).not.toMatch(/\s-\s*$/u);
  });

  it("keeps the check list short and drops a false TZ gap and a handled edition", () => {
    const withPackage = visibleCheckItems(
      [
        "не найдено ТЗ / извещение — объём и границы работ не подтверждены",
        "ЛС 01-02-01 встречается дважды: обе редакции взяты в расчёт",
        "Сметная стоимость: 171,37 тыс. руб.",
        "Сметная стоимость: 14 926,69 тыс. руб.",
        "лишняя проверка 1",
        "лишняя проверка 2",
        "лишняя проверка 3",
        "лишняя проверка 4",
      ],
      [
        { fileName: "ЛС-01-02-01-2023-демонтаж.xlsx", title: "Демонтаж", citations: [] },
        { fileName: "ЛС-01-02-01-2023-демонтаж-редакция-2.xlsx", title: "Демонтаж, редакция 2", citations: [] },
      ],
    );
    expect(withPackage.join(" ")).not.toMatch(/не найдено ТЗ|01-02-01/);
    expect(withPackage.some((item) => /различается/.test(item))).toBe(true);
    expect(withPackage.length).toBeLessThanOrEqual(5);
    const openGap = visibleCheckItems(
      ["не найдено ТЗ / извещение — объём и границы работ не подтверждены"],
      [],
    );
    expect(openGap).toEqual(["не найдено ТЗ / извещение — объём и границы работ не подтверждены"]);
    const realClash = visibleCheckItems(
      ["ЛС 01-02-01 встречается дважды: обе редакции взяты в расчёт"],
      [{ fileName: "ЛС-01-02-01.xlsx", title: "Демонтаж", citations: [] }],
    );
    expect(realClash[0]).toMatch(/01-02-01/);
  });

  it("hides a bare basis and a scrap of another contract on p-tpkp files", () => {
    const documents = pack.documents.filter((document) => document.fileName.includes("ЛС"));
    const shown = documents.flatMap((document) => document.citations.map((citation) => {
      const row = { ...citation, confidence: citation.confidence as Citation["confidence"] };
      return {
        file: document.fileName,
        keep: isShownConfirmation(row),
        text: citationTextForDisplay(row),
      };
    }));
    expect(shown.filter((item) => item.keep).map((item) => item.text).join("\n")).not.toMatch(/(?:^|\n)\s*Основание(?:\s|:|$)|потранспиляц|(?:^|[^\p{L}])стес(?:$|[^\p{L}])/imu);
    expect(isShownConfirmation({ text: "Основание", sourceFile: "Договор.docx" })).toBe(false);
    expect(isShownConfirmation({ text: "Основание:", sourceFile: "ЛС-02-02-01.xlsx" })).toBe(false);
    expect(isShownConfirmation({
      text: "а также заказчик по договору № 14 обязуется",
      sourceFile: "ЛС-02-02-01-2023-бурение.xlsx",
    })).toBe(false);
    expect(isShownConfirmation({ text: "Штраф 0,1% за день просрочки.", sourceFile: "Договор.docx" })).toBe(true);
    const filled = citationTextForDisplay({
      id: "basis",
      text: "Основание: Дефектная ведомость №1.2",
      page: 1,
      sourceFile: "ЛС-02-02-01.xlsx",
    });
    expect(filled).toBe("Основание: Дефектная ведомость №1.2");
    expect(isBareBasisText("Основание")).toBe(true);
    expect(isBareBasisText("Основание:")).toBe(true);
    expect(isBareBasisText("Основание ")).toBe(true);
    expect(citationTextForDisplay({
      id: "bare",
      text: "Основание:",
      page: 1,
      sourceFile: "ЛС-02-02-01.xlsx",
    })).toBeNull();
  });

  it("does not show procurement jargon to a person", () => {
    expect(plainUserMessage("Источник закупок не подключён")).toBe("Поиск закупок не подключён");
    expect(plainUserMessage("Источник закупок не подключён")).not.toMatch(/Источник закупок|Контур/);
    const cleaned = neutralizeProcurementJargon("Контур.Закупки API: Источник закупок не подключён");
    expect(cleaned).not.toMatch(/Контур|Источник закупок|\bAPI\b/);
  });

  it("groups money including kopecks", () => {
    expect(formatMoney(7_677_127.06)).toBe("7 677 127,06 ₽");
    expect(formatMoney(280_939_759.9)).toBe("280 939 759,90 ₽");
    expect(formatMoney(null)).toBe("Не указано");
  });

  it("searches the supplier directory and does not build a web search", () => {
    const found = searchSupplierDirectory("долото шарошечное", [
      { name: "СеверСнаб", email: "a@example.com", materialKeywords: ["долото", "труба"], regions: ["Красноярский край"] },
      { name: "ЮгБетон", email: "b@example.com", materialKeywords: ["бетон"], regions: [] },
    ]);
    expect(found.map((item) => item.name)).toEqual(["СеверСнаб"]);
    expect(collectSuppliersMessage(["СеверСнаб"])).toMatch(/справочник/i);
    expect(collectSuppliersMessage(["СеверСнаб"])).toMatch(/не подключён/);
    expect(collectSuppliersMessage([])).toMatch(/нет/);
    expect(gprNeedNextStep("Долото")).toMatch(/Собрать/);
    const created = { notice: gprNeedNextStep("Долото"), highlightedId: "sup-1" };
    expect(gprPathAfterUndo(created, "sup-1")).toEqual({ notice: "", highlightedId: "" });
    expect(gprPathAfterUndo(created, "sup-2")).toEqual(created);
    expect(showEmptyExternalSupplierLine(2, 0)).toBe(false);
    expect(showEmptyExternalSupplierLine(0, 0)).toBe(true);
    expect(showEmptyExternalSupplierLine(1, null)).toBe(false);
    const cabinet = readFileSync("src/app/cabinet/zakupki/[id]/page.tsx", "utf8");
    const production = readFileSync("src/app/cabinet/proizvodstvo/page.tsx", "utf8");
    expect(`${cabinet}\n${production}`).not.toMatch(/duckduckgo/i);
  });
});
