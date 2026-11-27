import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { analyzeUpload, parseGrandBuffer } from "@/server/grand-smeta";
import { createManualProcurement, makeOfficialCalculationAndSchedule, recomputeCalculationCost, sendProcurementToCalculation } from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import "./setup";

const BURENIE_C0 = 280939759.9;
const BURENIE_PRICE = 393315663.86;

async function mergedLsrBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ЛСР");
  ws.getCell("A1").value = "Наименование программного продукта";
  ws.getCell("G1").value = "ГРАНД-Смета";
  ws.getCell("A5").value = "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЁТ № 15-01";
  ws.getCell("A6").value = "Устройство площадки";
  ws.getCell("A7").value = "Наименование субъекта";
  ws.getCell("G7").value = "Ямало-Ненецкий автономный округ";
  ws.getCell("A8").value = "Наименование зоны";
  ws.getCell("G8").value = "I зона";
  const header = 12;
  ["№ п/п", "Обоснование", "Наименование работ и затрат", "Ед. изм.", "Кол.", "Стоимость единицы", "Общая стоимость", "Затраты труда рабочих, чел.-ч"]
    .forEach((text, index) => {
      const col = index < 6 ? index + 1 : index === 6 ? 10 : 15;
      ws.getCell(header, col).value = text;
    });
  ws.mergeCells(header, 6, header, 9);
  ws.mergeCells(header, 10, header, 14);
  ["Всего", "Оплата труда", "Эксплуатация машин", "Материалы", "Всего", "Оплата труда", "Эксплуатация машин", "Материалы", "ЗП машинистов"]
    .forEach((text, index) => { ws.getCell(header + 1, 6 + index).value = text; });
  const blank = ["", "", "", "", "", "", "", "", ""];
  const rows: Array<Array<string | number>> = [
    ["", "", "Раздел 1. Земляные", "", "", ...blank],
    [1, "ФЕР01-01-001", "Устройство траншеи ПК 103 до ПК 103+546", "м", 546, 412.5, 100, 50, 20, 546 * 412.5, 1, 1, 1, 1, 40],
    [2, "ФЕР08-02", "Прокладка кабеля", "м", 120, 2150, 10, 10, 10, 120 * 2150, 1, 1, 1, 1, 8],
    [3, "ГЭСН01-01", "Разработка грунта", "м3", 80, 18750, 10, 10, 10, 80 * 18750, 1, 1, 1, 1, 12],
    ["", "ЗТ", "Затраты труда рабочих", "чел.-ч", 40, 0, ...blank.slice(0, 8)],
    ["", "ЗТм", "Затраты труда машинистов", "маш.-ч", 12, 0, ...blank.slice(0, 8)],
    ["", "", "Накладные расходы 177% ФОТ (от 784 598)", "", "", ...blank],
    ["", "", "Сметная прибыль 21% ФОТ", "", "", ...blank],
    ["", "", "177% ФОТ (от 784598) (Поз. 1)", "", "", ...blank],
    ["", "", "Итого Поз. 1", "", "", ...blank],
    ["", "", "Временные здания и сооружения (ВЗиС)", "", "", ...blank],
    ["", "", "Зимнее удорожание", "", "", ...blank],
    ["", "", "ПК 103 до ПК 103+546", "м", "103 103+546", ...blank.slice(0, 8)],
  ];
  rows.forEach((values, index) => {
    values.forEach((value, column) => { ws.getCell(header + 2 + index, column + 1).value = value; });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("merged 15-column LSR with a GRAND title", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("reads the merged header through analyzeUpload and keeps GRAND metadata", async () => {
    const parsed = await analyzeUpload("лср-15-граф.xlsx", "xlsx", await mergedLsrBuffer(), { useLlm: false, heavyOcr: false });
    const trench = parsed.positions.find((row) => row.name.includes("траншеи"));
    const cable = parsed.positions.find((row) => row.name.includes("кабел"));
    const earth = parsed.positions.find((row) => row.name.includes("грунта"));
    expect(trench).toMatchObject({ code: "ФЕР01-01-001", unit: "м", quantity: 546, rate: 412.5 });
    expect(cable).toMatchObject({ code: "ФЕР08-02", unit: "м", quantity: 120, rate: 2150 });
    expect(earth).toMatchObject({ code: "ГЭСН01-01", unit: "м3", quantity: 80, rate: 18750 });
    expect(parsed.positions.some((row) => row.unit === "чел.-ч" && row.quantity === 40)).toBe(true);
    expect(parsed.positions.some((row) => row.unit === "маш.-ч" && row.quantity === 12)).toBe(true);
    expect(parsed.positions.some((row) => /накладн|прибыл|фот|итого|взис|зимн|пк 103 до пк/iu.test(row.name) && !row.name.includes("траншеи"))).toBe(false);
    const sum = parsed.positions.reduce((total, row) => total + row.quantity * row.rate, 0);
    expect(sum).toBeCloseTo(546 * 412.5 + 120 * 2150 + 80 * 18750, 2);
    expect(parsed.analysis.vendor).toMatch(/ГРАНД-Смета/);
    expect(parsed.analysis.estimateNumber).toMatch(/15-01/);
    expect(parsed.analysis.workName).toMatch(/Устройство площадки/);
    expect(parsed.analysis.region).toMatch(/Ямало/);
    expect(parsed.analysis.zone).toMatch(/I зона/);
  });

  it("rebuilds a zero CUST-TOTAL original when a priced LSR is already on the procurement", () => {
    const created = createManualProcurement("u-ruk", { title: "Битый оригинал", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-priced",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "ЛСР",
        fileName: "lsr.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: "uploads/lsr.xlsx",
        estimatePositions: [
          { id: "work-1", code: "ФЕР01", name: "Устройство щебня", unit: "м3", quantity: 4, rate: 500 },
        ],
      });
      data.calculations.unshift({
        id: "c-broken-original",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "Смета заказчика (оригинал)",
        status: "gotovo",
        kind: "customer_original",
        immutable: true,
        positions: [{ id: "old-total", code: "CUST-TOTAL", name: "Итог", unit: "компл", quantity: 1, rate: 0, rateMissing: true, sourceDocumentId: "doc-priced" }],
        assumptions: [],
        scenario: "bazovyy",
        scenarioFactor: 1,
        participateDecision: null,
        directoryVersionId: "dir-rascenki-1",
        version: 1,
        authorId: "u-ruk",
        updatedAt: new Date().toISOString(),
        changeLog: [],
      });
      const card = data.procurements.find((item) => item.id === created.id)!;
      card.originalCalculationId = "c-broken-original";
      return data;
    });
    makeOfficialCalculationAndSchedule("u-ruk", created.id);
    const original = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "customer_original")!;
    expect(original.id).not.toBe("c-broken-original");
    expect(original.positions.some((row) => row.name.includes("щебн") && row.unit === "м3" && row.rate === 500)).toBe(true);
    expect(original.positions.some((row) => row.code === "CUST-TOTAL" && row.rate === 0)).toBe(false);
  });

  it("does not rebuild a priced original when another estimate file has only hours", () => {
    const created = createManualProcurement("u-ruk", { title: "Не трогать живой оригинал", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-priced-keep",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "Со ставкой",
        fileName: "priced.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: "uploads/priced.xlsx",
        estimatePositions: [
          { id: "keep-1", code: "ФЕР01", name: "Устройство щебня", unit: "м3", quantity: 4, rate: 500 },
        ],
      }, {
        id: "doc-hours-keep",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "Часы",
        fileName: "hours.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: "uploads/hours.xlsx",
        estimatePositions: [
          { id: "keep-h", code: "ЗТ", name: "Затраты труда рабочих", unit: "чел.-ч", quantity: 8, rate: 0, rateMissing: true },
        ],
      });
      return data;
    });
    makeOfficialCalculationAndSchedule("u-ruk", created.id);
    const first = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "customer_original")!;
    makeOfficialCalculationAndSchedule("u-ruk", created.id);
    const second = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "customer_original")!;
    expect(second.id).toBe(first.id);
    expect(second.positions.some((row) => row.rate === 500)).toBe(true);
  });

  it("does not rebuild a CUST-TOTAL original that already stores a positive total", () => {
    const totaled = createManualProcurement("u-ruk", { title: "Итог со ставкой", region: "Ямал" });
    const totaledCard = readAppData().procurements.find((item) => item.id === totaled.id)!;
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-lump",
        orgId: totaledCard.orgId,
        procurementId: totaled.id,
        title: "Итог",
        fileName: "lump.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: "uploads/lump.xlsx",
        analysis: {
          vendor: "",
          region: "",
          zone: "",
          estimateNumber: "",
          workName: "Смета без строк",
          basis: "",
          priceLevel: "",
          costThousand: 12,
          positionCount: 1,
          profileMatch: false,
        },
        estimatePositions: [
          { id: "lump-1", code: "ФЕР09", name: "Работа без ставки", unit: "м", quantity: 3, rate: 0, rateMissing: true },
        ],
      });
      return data;
    });
    makeOfficialCalculationAndSchedule("u-ruk", totaled.id);
    const lumpFirst = readAppData().calculations.find((item) => item.procurementId === totaled.id && item.kind === "customer_original")!;
    expect(lumpFirst.positions.some((row) => row.code === "CUST-TOTAL" && row.rate === 12000)).toBe(true);
    makeOfficialCalculationAndSchedule("u-ruk", totaled.id);
    const lumpSecond = readAppData().calculations.find((item) => item.procurementId === totaled.id && item.kind === "customer_original")!;
    expect(lumpSecond.id).toBe(lumpFirst.id);
    expect(lumpSecond.positions.some((row) => row.code === "CUST-TOTAL" && row.rate === 12000)).toBe(true);
  });

  it("keeps the burenie reference total when the workbook is read through analyzeUpload", async () => {
    const filePath = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    const bytes = fs.readFileSync(filePath);
    const grand = await parseGrandBuffer(bytes);
    const uploaded = await analyzeUpload("ls-02-02-01-burenie.xlsx", "xlsx", bytes, { useLlm: false, heavyOcr: false });
    expect(uploaded.positions.map((row) => [row.code, row.unit, row.quantity, row.rate])).toEqual(
      (grand?.positions ?? []).map((row) => [row.code, row.unit, row.quantity, row.rate]),
    );
    const created = createManualProcurement("u-ruk", { title: "Бурение инвариант", region: "Ямал", nmck: 500_000_000 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    const stored = await saveUpload("burenie-lsr", "ls-02-02-01-burenie.xlsx", bytes);
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-burenie-lsr",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "ЛС бурение",
        fileName: "ls-02-02-01-burenie.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: stored.storedPath,
        estimatePositions: uploaded.positions.map((position, index) => ({
          id: `b-${index + 1}`,
          code: position.code,
          name: position.name,
          unit: position.unit,
          quantity: position.quantity,
          rate: position.rate,
          ...(position.rateMissing ? { rateMissing: true } : {}),
          ...(position.isWorkItem ? { isWorkItem: true } : {}),
          ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
          ...(position.sectionName ? { sectionName: position.sectionName } : {}),
          ...(position.workName ? { workName: position.workName } : {}),
        })),
      });
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    recomputeCalculationCost("u-ruk", draft.id, {
      resourceScheduleParams: draft.resourceScheduleParams,
      useResourceScheduleEconomics: true,
    });
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(priced.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(priced.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);
  });
});
