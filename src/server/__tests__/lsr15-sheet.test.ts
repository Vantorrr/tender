import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { isUnusableEstimateLine } from "@/lib/estimate-noise";
import { splitSentences } from "@/lib/sentences";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { analysisFromScan, analyzeUpload } from "@/server/grand-smeta";
import { parseLsrWorkbook } from "@/server/lsr-sheet";
import { makeOfficialCalculationAndSchedule, repairBrokenEstimateDocuments, createManualProcurement } from "@/server/repo";
import { rollupWorkSections } from "@/server/estimate-rollup";
import { saveUpload } from "@/server/uploads";
import "./setup";

async function lsr15Buffer(withHours = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ЛСР 15 граф");
  const header = ["№ п/п", "Обоснование", "Наименование работ и затрат", "Ед. изм.", "Кол.", "Стоимость единицы", "", "Общая стоимость"];
  header.forEach((text, index) => { ws.getCell(8, index + 1).value = text; });
  ws.getCell(9, 6).value = "Всего";
  ws.getCell(9, 7).value = "Оплата труда";
  ws.getCell(9, 8).value = "Всего";
  const rows: Array<Array<string | number>> = [
    ["", "", "Раздел 1. Основания", "", "", "", "", ""],
    [1, "ФЕР01-01-013", "Устройство щебеночного основания", "м3", 1200, 1500, 400, 1_800_000],
    [2, "ФЕР27-02", "Устройство объемных конструкций (геоматрица)", "м2", 400, 900, 100, 360_000],
    [3, "ФЕР08-01", "Устройство постели при одном кабеле в траншее", "м", 600, 80, 10, 48_000],
    [4, "ГЭСН04-01", "Шнековое бурение станками типа ЛБУ-50", "м", 240, 3200, 500, 768_000],
    [5, "", "Накладные расходы 177% ФОТ (от 784 598)", "", "177% ФОТ (от 784 598)", "", "", ""],
    [6, "", "Сметная прибыль 21% ФОТ", "", "", "", "", ""],
    [7, "", "177% ФОТ (от 784598) (Поз. 1)", "", "", "", "", ""],
    [8, "", "Итого Поз. 1", "", "", "", "", ""],
    [9, "", "Всего по смете", "", "", "", "", ""],
    [10, "", "Лимитированные затраты, в том числе ВЗиС и зимнее удорожание", "", "", "", "", ""],
    [11, "", "ПК 103 до ПК 103+546", "м", "103 103+546", "", "", ""],
    [12, "ФЕР01-02", "Устройство траншеи ПК 103 до ПК 103+546", "м", 546, 100, 10, 54600],
    ...(withHours ? [["13", "ЗТ", "Затраты труда рабочих", "чел.-ч", 880, 0, 0, 0] as Array<string | number>] : []),
  ];
  rows.forEach((values, index) => {
    values.forEach((value, column) => { ws.getCell(10 + index, column + 1).value = value; });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("15-column local estimate", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("keeps cipher, unit and rate apart and drops overhead, totals and pickets", async () => {
    const parsed = await parseLsrWorkbook(await lsr15Buffer(true));
    const gravel = parsed.find((row) => row.name.includes("щебен"));
    expect(gravel).toMatchObject({ code: "ФЕР01-01-013", unit: "м3", quantity: 1200, rate: 1500, isWorkItem: true });
    expect(gravel?.code).not.toBe(gravel?.name);
    expect(parsed.some((row) => isUnusableEstimateLine(row) || /накладн|прибыл|итого|всего по смете|лимитир/iu.test(row.name))).toBe(false);
    expect(parsed.some((row) => row.name.startsWith("ПК 103"))).toBe(false);
    expect(parsed.find((row) => row.name.includes("ПК 103 до ПК"))).toMatchObject({ unit: "м", quantity: 546, rate: 100, isWorkItem: true });
    expect(parsed.some((row) => row.unit === "чел.-ч" && row.quantity === 880)).toBe(true);
    const rollup = rollupWorkSections(parsed);
    expect(rollup.sections.map((section) => section.unit)).not.toContain("81.52");
    expect(rollup.sections.some((section) => /накладн|итого поз|^пк\s/iu.test(section.section))).toBe(false);
  });

  it("reparses a saved broken 15-column file into a 43/10/40 reference and a phased GPR", async () => {
    const bytes = await lsr15Buffer();
    const created = createManualProcurement("u-ruk", { title: "Тест 149 файлов", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const stored = await saveUpload("lsr15", "ЛСР 15 граф.xlsx", bytes);
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-lsr15",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "ЛСР 15 граф",
        fileName: "ЛСР 15 граф.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "trebuet_proverki",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: stored.storedPath,
        estimatePositions: [
          { id: "bad-1", code: "Устройство щебня", name: "Устройство щебня", unit: "81.52", quantity: 3, rate: 0, rateMissing: true },
          { id: "bad-2", code: "Постель", name: "Постель", unit: "22426.16", quantity: 4, rate: 0, rateMissing: true },
          { id: "bad-3", code: "Бурение", name: "Бурение", unit: "31.39", quantity: 5, rate: 0, rateMissing: true },
          { id: "bad-4", code: "НР", name: "Накладные расходы 177% ФОТ (от 784 598)", unit: "шт", quantity: 177784598, rate: 0 },
          { id: "bad-5", code: "СП", name: "Сметная прибыль 21% ФОТ", unit: "шт", quantity: 1, rate: 0 },
        ],
      });
      return data;
    });
    expect(await repairBrokenEstimateDocuments("u-ruk", created.id)).toBe(1);
    const repaired = readAppData().documents.find((item) => item.id === "doc-lsr15")!;
    expect(repaired.estimatePositions?.some((row) => row.unit === "м3" && row.rate === 1500)).toBe(true);
    expect(repaired.estimatePositions?.some((row) => /накладн|прибыл/iu.test(row.name))).toBe(false);
    const made = makeOfficialCalculationAndSchedule("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.id === made.calculationId)!;
    const direct = 1200 * 1500 + 400 * 900 + 600 * 80 + 240 * 3200 + 546 * 100;
    expect(draft.referenceReprice?.direct).toBe(direct);
    expect(draft.referenceReprice?.overhead).toBe(Math.round(direct * 0.43 * 100) / 100);
    expect(draft.referenceReprice?.reserve).toBeGreaterThan(0);
    expect(draft.referenceReprice?.profit).toBeGreaterThan(0);
    expect(draft.costSummary?.C0 ?? 0).not.toBeCloseTo(draft.referenceReprice!.C0, 0);
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    const withDuration = schedule.stages.filter((stage) => (stage.durationDays ?? 0) > 0);
    expect(withDuration.length).toBeGreaterThan(0);
    expect(new Set(schedule.stages.map((stage) => stage.start)).size).toBeGreaterThan(1);
    expect(withDuration.some((stage) => stage.dependsOn && stage.dependencyType === "FS")).toBe(true);
    expect(withDuration.some((stage) => (stage.benchmarkCrew ?? []).length > 0)).toBe(true);
    expect(withDuration.every((stage) => (stage.resources ?? []).every((resource) => !(resource.rate != null && resource.rate > 0)))).toBe(true);
    const original = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "customer_original")!;
    expect(original.positions.some((row) => row.name.includes("щебен") && row.rate === 1500)).toBe(true);
    expect(original.positions.some((row) => row.code === "CUST-TOTAL" && row.rate === 0)).toBe(false);
    mutateAppData((data) => {
      const draftRow = data.calculations.find((item) => item.id === made.calculationId)!;
      draftRow.positions.push({
        id: "stale-bad",
        costRole: "customer_source",
        sourceDocumentId: "doc-lsr15",
        sourcePositionId: "bad-1",
        code: "Устройство щебня",
        name: "Накладные расходы 177% ФОТ",
        unit: "81.52",
        quantity: 177784598,
        rate: 0,
        rateMissing: true,
      }, {
        id: "hand-row",
        costRole: "customer_source",
        priceSource: "manual",
        code: "РУЧ",
        name: "Ручная добавка заказчика",
        unit: "шт",
        quantity: 2,
        rate: 500,
      });
      return data;
    });
    makeOfficialCalculationAndSchedule("u-ruk", created.id);
    const again = readAppData().calculations.find((item) => item.id === made.calculationId)!;
    expect(again.positions.some((row) => row.unit === "81.52" || /накладн/iu.test(row.name))).toBe(false);
    expect(again.positions.some((row) => row.id === "hand-row" && row.rate === 500)).toBe(true);
  });

  it("keeps priced works in the customer original when an hour row has no price", async () => {
    const bytes = await lsr15Buffer(true);
    const created = createManualProcurement("u-ruk", { title: "ЛСР с часами", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const stored = await saveUpload("lsr15-hours", "ЛСР 15 граф.xlsx", bytes);
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-lsr15-hours",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "ЛСР 15 граф",
        fileName: "ЛСР 15 граф.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "trebuet_proverki",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: stored.storedPath,
        estimatePositions: [
          { id: "bad-h", code: "Часы", name: "Часы", unit: "81.52", quantity: 1, rate: 0, rateMissing: true },
          { id: "bad-h2", code: "НР", name: "Накладные расходы 10% ФОТ", unit: "шт", quantity: 1, rate: 0 },
        ],
      });
      return data;
    });
    await repairBrokenEstimateDocuments("u-ruk", created.id);
    makeOfficialCalculationAndSchedule("u-ruk", created.id);
    const original = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "customer_original")!;
    expect(original.positions.some((row) => row.rate === 1500 && row.unit === "м3")).toBe(true);
    expect(original.positions.some((row) => row.code === "CUST-TOTAL" && row.rate === 0)).toBe(false);
  });

  it("leaves an ordinary price column to the generic workbook reader", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Смета");
    ws.getRow(1).values = [null, "Наименование работ", "Ед.", "Количество", "Цена за ед"];
    ws.getRow(2).values = [null, "Монтаж опоры", "шт", 4, 2500];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await analyzeUpload("обычная-смета.xlsx", "xlsx", buf, { useLlm: false, heavyOcr: false });
    expect(parsed.positions[0]).toMatchObject({ name: "Монтаж опоры", unit: "шт", quantity: 4, rate: 2500 });
  });

  it("does not split a dotted date across citations", () => {
    expect(splitSentences("Срок подачи заявок до 15.12.2026. Далее работы.")).toEqual([
      "Срок подачи заявок до 15.12.2026.",
      "Далее работы.",
    ]);
    const scan = analysisFromScan("извещение.pdf", {
      status: "ok",
      text: "Срок подачи заявок до 15.12.2026. НМЦК 12.5 млн руб.",
      pages: ["Срок подачи заявок до 15.12.2026. НМЦК 12.5 млн руб."],
      pageCount: 1,
    });
    expect(scan.citations.some((item) => item.text.includes("15.12.2026"))).toBe(true);
    expect(scan.citations.some((item) => item.text.trim() === "12." || item.text.trim() === "2026")).toBe(false);
  });
});
