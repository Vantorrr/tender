import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { buildStagesFromEstimatePositions, GPR_DATES_MISSING } from "@/lib/estimate-stages";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import type { CalcPosition } from "@/lib/types";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { buildCalculationXlsx } from "@/server/export";
import { parseGrandBuffer } from "@/server/grand-smeta";
import { createManualProcurement, createProcurementSchedule, recalcCalculation, recomputeCalculationCost, refreshProcurementAnalytics, sendProcurementToCalculation, updateCalculation } from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import { acceptVolumeDraft, draftVolumeSheet } from "@/server/volume-sheet";
import "./setup";

describe("wave 4 pricing, volumes and return quantities", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("prices burenie-like labour from the company directory and stays stable on a second refresh", async () => {
    const created = createManualProcurement("u-ruk", { title: "Ставки компании", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    const positions: CalcPosition[] = [
      { id: "work", code: "ФЕР05-01-055-05", name: "Бурение скважин", unit: "м", quantity: 716, rate: 0, isWorkItem: true },
      { id: "labor", code: "ЗТ", name: "Кладовщик", unit: "чел.-ч", quantity: 2, rate: 0, rateMissing: true, resourceKind: "labor" },
      { id: "generic", code: "ЗТ", name: "Затраты труда рабочих", unit: "чел.-ч", quantity: 3, rate: 0, rateMissing: true, resourceKind: "labor" },
      { id: "drivers", code: "ЗТм", name: "Затраты труда машинистов", unit: "чел.-ч", quantity: 4, rate: 0, rateMissing: true, resourceKind: "equipment" },
      { id: "water", code: "ФССЦ-01.7.03.01-0001", name: "Вода", unit: "м3", quantity: 5, rate: 0, rateMissing: true, resourceKind: "material" },
    ];
    updateCalculation("u-ruk", draft.id, { positions, resourceScheduleParams: draft.resourceScheduleParams ?? { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS } });
    const first = recalcCalculation("u-ruk", draft.id, "bazovyy");
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(priced.positions.find((position) => position.id === "labor")).toMatchObject({ rate: 881, rateMissing: false });
    expect(priced.positions.find((position) => position.id === "generic")?.rate).toBe(priced.resourceScheduleParams?.personHourRate);
    expect(priced.positions.find((position) => position.id === "drivers")?.rateMissing).toBe(true);
    expect(priced.positions.find((position) => position.id === "water")?.rateMissing).toBe(true);
    expect(priced.positions.find((position) => position.id === "work")?.isWorkItem).toBe(true);
    const second = recalcCalculation("u-ruk", draft.id, "bazovyy");
    const repeated = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(repeated.positions.map((position) => position.rate)).toEqual(priced.positions.map((position) => position.rate));
    expect(second.matched).toBe(first.matched);
  });

  it("builds an editable volume draft from a specification and a stub model", async () => {
    const created = createManualProcurement("u-ruk", { title: "Ведомость из ТЗ", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    const text = fs.readFileSync(path.join(process.cwd(), "fixtures/tz/burenie-vor.txt"));
    const uploaded = await saveUpload("tz-vor", "burenie-vor.txt", text);
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-tz-vor",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "Техническое задание",
        fileName: "burenie-vor.txt",
        fileType: "other",
        category: "tz",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: uploaded.storedPath,
      });
      return data;
    });
    await expect(draftVolumeSheet("u-ruk", "missing-calc")).rejects.toThrow(/Расчёт не найден/);
    const empty = createManualProcurement("u-ruk", { title: "Без ТЗ", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", empty.id);
    const emptyDraft = readAppData().calculations.find((item) => item.procurementId === empty.id && item.kind === "resource_draft")!;
    await expect(draftVolumeSheet("u-ruk", emptyDraft.id)).rejects.toThrow(/Нет текста технического задания/);
    const drafted = await draftVolumeSheet("u-ruk", draft.id, async () => JSON.stringify({
      rows: [{ work: "Бурение скважин", unit: "м", volume: 716, quote: "Бурение скважин 716 м" }],
    }));
    expect(drafted.rows[0]).toMatchObject({ work: "Бурение скважин", unit: "м", volume: 716, quote: "Бурение скважин 716 м" });
    expect(drafted.rows[0]?.rate).toBeNull();
  });

  it("writes absolute rounded return quantities into the resource sheet and the schedule", async () => {
    const parsed = await parseGrandBuffer(fs.readFileSync(path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx")));
    const positions: CalcPosition[] = (parsed?.positions ?? []).map((position, index) => ({
      id: `row-${index + 1}`,
      code: position.code,
      name: position.name,
      unit: position.unit,
      quantity: position.quantity,
      rate: 0,
      rateMissing: true,
      ...(position.isWorkItem ? { isWorkItem: true } : {}),
      ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
      ...(position.sectionName ? { sourceSectionName: position.sectionName } : {}),
      ...(position.workName ? { sourceWorkName: position.workName } : {}),
    }));
    const stages = buildStagesFromEstimatePositions(positions, "2026-11-21T00:00:00.000Z");
    const resources = stages.flatMap((stage) => stage.resources ?? []);
    const water = resources.find((resource) => resource.name.includes("Вода"));
    expect(water?.name.startsWith("Возврат:")).toBe(true);
    expect(water?.quantity).toBeGreaterThan(0);
    expect(resources.filter((resource) => resource.name.startsWith("Возврат:")).every((resource) => resource.quantity > 0)).toBe(true);
    const created = createManualProcurement("u-ruk", { title: "Возвраты в файле", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    updateCalculation("u-ruk", draft.id, { positions });
    createProcurementSchedule("u-ruk", created.id);
    mutateAppData((data) => {
      const schedule = data.schedules.find((item) => item.procurementId === created.id)!;
      schedule.calculationId = draft.id;
      schedule.stages = stages;
      return data;
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildCalculationXlsx(draft.id) as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Ресурсный состав");
    const rows = sheet?.getSheetValues().flatMap((row) => Array.isArray(row) ? [row.map((cell) => String(cell ?? "")).join(" | ")] : []) ?? [];
    const waterRow = rows.find((row) => row.includes("Вода"));
    expect(waterRow).toBeTruthy();
    expect(waterRow).not.toMatch(/-\s*7[,.]16|-\s*164[,.]68/);
    expect(rows.join("\n")).not.toMatch(/2648\.0544|33\.910799999999995|16\.5396/);
    expect(rows.join("\n")).toContain("Материалы");
    expect(rows.join("\n")).not.toMatch(/\b(?:labor|equipment|material|other)\b/);
    const calcSheet = workbook.getWorksheet("Расчёт");
    const calcText = calcSheet?.getSheetValues().flat().map((cell) => String(cell ?? "")).join(" ") ?? "";
    expect(calcText).not.toMatch(/16\.5396|33\.910799999999995/);
  });

  it("prices four burenie labour lines from the schedule fallback and none from a directory row", async () => {
    const parsed = await parseGrandBuffer(fs.readFileSync(path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx")));
    const created = createManualProcurement("u-ruk", { title: "Бурение ставки", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    const positions: CalcPosition[] = (parsed?.positions ?? []).map((position, index) => ({
      id: `row-${index + 1}`,
      code: position.code,
      name: position.name,
      unit: position.unit,
      quantity: position.quantity,
      rate: 0,
      rateMissing: !position.isWorkItem,
      ...(position.isWorkItem ? { isWorkItem: true } : {}),
      ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
    }));
    expect(positions).toHaveLength(24);
    updateCalculation("u-ruk", draft.id, { positions, resourceScheduleParams: { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS } });
    recalcCalculation("u-ruk", draft.id, "bazovyy");
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!.positions;
    expect(priced.filter((position) => position.rateBasis === "person_hour")).toHaveLength(4);
    expect(priced.filter((position) => position.rateBasis === "directory")).toHaveLength(0);
    expect(priced.filter((position) => position.rateMissing)).toHaveLength(16);
  });

  it("builds the schedule from the uploaded specification text", async () => {
    const created = createManualProcurement("u-ruk", { title: "График из ТЗ", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    updateCalculation("u-ruk", draft.id, {
      positions: [
        { id: "w1", code: "ФЕР-1", name: "Бурение", unit: "м", quantity: 10, rate: 0, isWorkItem: true, sourceSectionName: "Раздел 1", sourceWorkName: "Бурение" },
        { id: "w2", code: "ФЕР-2", name: "Монтаж", unit: "м", quantity: 4, rate: 0, isWorkItem: true, sourceSectionName: "Раздел 2", sourceWorkName: "Монтаж" },
      ],
    });
    const body = "Техническое задание. Начало работ 01.12.2026, окончание 20.12.2026.";
    const uploaded = await saveUpload("tz-gpr", "tz.txt", Buffer.from(body, "utf8"));
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-tz-gpr",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "Техническое задание",
        fileName: "tz.txt",
        fileType: "other",
        category: "tz",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: uploaded.storedPath,
      });
      return data;
    });
    createProcurementSchedule("u-ruk", created.id);
    const stages = readAppData().schedules.find((item) => item.procurementId === created.id)!.stages;
    expect(stages.length).toBeGreaterThan(1);
    expect(stages.some((stage) => stage.start === stage.end && stage.start === new Date().toISOString().slice(0, 10))).toBe(false);
    expect(stages[0]?.start).toBe("2026-12-01");
    expect(stages[stages.length - 1]?.end).toBe("2026-12-20");
    expect(readAppData().schedules.find((item) => item.procurementId === created.id)!.assumptions ?? []).not.toContain(GPR_DATES_MISSING);
  });

  it("adds an accepted priced volume line to the cost total exactly once", () => {
    const created = createManualProcurement("u-ruk", { title: "Ведомость в итоге", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true, resourceScheduleParams: draft.resourceScheduleParams ?? { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS } });
    const before = readAppData().calculations.find((item) => item.id === draft.id)!.costSummary?.C0 ?? 0;
    acceptVolumeDraft("u-ruk", draft.id, [{ work: "Кладовщик", unit: "чел.-ч", volume: 10, quote: "Кладовщик 10 чел.-ч", rate: null }]);
    recomputeCalculationCost("u-ruk", draft.id, { useResourceScheduleEconomics: true });
    const after = readAppData().calculations.find((item) => item.id === draft.id)!;
    const line = after.positions.find((position) => position.name === "Кладовщик")!;
    expect(line.rate).toBe(881);
    expect(line.rateMissing).toBe(false);
    expect((after.costSummary?.C0 ?? 0) - before).toBeCloseTo(10 * 881, 2);
  });

  it("spreads stages across a contract duration when the file has no calendar dates", async () => {
    const created = createManualProcurement("u-ruk", { title: "Срок договором", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    updateCalculation("u-ruk", draft.id, {
      positions: [
        { id: "a", code: "ФЕР-1", name: "Бурение", unit: "м", quantity: 1, rate: 0, isWorkItem: true, sourceSectionName: "Раздел 1", sourceWorkName: "Бурение" },
        { id: "b", code: "ФЕР-2", name: "Монтаж", unit: "м", quantity: 1, rate: 0, isWorkItem: true, sourceSectionName: "Раздел 2", sourceWorkName: "Монтаж" },
      ],
    });
    const uploaded = await saveUpload("contract-days", "dogovor.txt", Buffer.from("Срок выполнения: 90 календарных дней.", "utf8"));
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-contract-days",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "Договор",
        fileName: "dogovor.txt",
        fileType: "other",
        category: "contract",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: uploaded.storedPath,
      });
      return data;
    });
    createProcurementSchedule("u-ruk", created.id);
    const stages = readAppData().schedules.find((item) => item.procurementId === created.id)!.stages;
    const today = new Date().toISOString().slice(0, 10);
    expect(stages[0]?.start).toBe(today);
    expect(stages[stages.length - 1]?.end).not.toBe(today);
    expect(stages[0]?.start).not.toBe(stages[1]?.start);
  });

  it("renders the analytical note as a verdict and five blocks", () => {
    const first = refreshProcurementAnalytics("u-tender", "p-1");
    const note = readAppData().procurements.find((item) => item.id === "p-1")!.analytics!.summary;
    expect(first.unchanged).toBe(false);
    expect(note.startsWith("Вердикт ИИ:")).toBe(true);
    expect(note).toContain("Паспорт закупки и тайминг");
    expect(note).toContain("Условия участия и требования к заявке");
    expect(note).toContain("Сводная ведомость объёмов");
    expect(note).toContain("Расчёт себестоимости и экономика");
    expect(note).toContain("Риски и подводные камни");
    expect(refreshProcurementAnalytics("u-tender", "p-1").unchanged).toBe(true);
  });
});
