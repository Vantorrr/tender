import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { buildStagesFromEstimatePositions } from "@/lib/estimate-stages";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import type { CalcPosition } from "@/lib/types";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { buildCalculationXlsx } from "@/server/export";
import { parseGrandBuffer } from "@/server/grand-smeta";
import { createManualProcurement, createProcurementSchedule, recalcCalculation, sendProcurementToCalculation, updateCalculation } from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import { draftVolumeSheet } from "@/server/volume-sheet";
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
  });
});
