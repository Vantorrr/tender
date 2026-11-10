import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { parseClientMaterialsXlsx } from "@/server/export";
import "./setup";

describe("client materials workbook import", () => {
  it("reads material rows from the client template instead of the first worksheet", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Титульный лист").addRow(["not an estimate"]);
    const sheet = workbook.addWorksheet("Материалы");
    sheet.getRow(14).values = [
      "Работа ГПР", "Раздел", "Код ВОР", "Подраздел", "Наименование работы",
      "Материал / конструкция", "Кол-во по ВОР", "Ед. ВОР", "Кол-во для цены",
      "Ед. цены", "Цена за ед., руб.", "Стоимость МТР, руб.", "Новая стоимость материалов",
    ];
    sheet.getRow(15).values = [
      "Отсыпка грунта", "АД", "АД-02", "Земляное полотно", "Устройство основания",
      "Скальный грунт 0-500", 10, "м³", 18, "т", 750,
      { formula: "I15*K15", result: 13500 }, { formula: "L15*1.1", result: 14850 },
    ];
    sheet.getRow(16).values = [
      "Отсыпка грунта", "АД", "АД-02", "Земляное полотно", "Устройство основания",
      "Местный материал", 1, "м³", 1, "м³", 0, 0, 0,
    ];
    const result = await parseClientMaterialsXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(result).toEqual([
      {
        sourceRow: 15,
        sourceCode: "АД-02",
        workName: "Отсыпка грунта",
        section: "АД",
        materialName: "Скальный грунт 0-500",
        quantity: 18,
        unit: "т",
        rate: 750,
      },
      {
        sourceRow: 16,
        sourceCode: "АД-02",
        workName: "Отсыпка грунта",
        section: "АД",
        materialName: "Местный материал",
        quantity: 1,
        unit: "м³",
        rate: null,
      },
    ]);
  });

  it("imports and replaces linked material rows in the selected GPR", async () => {
    closeDb();
    ensureReady();
    const before = readAppData();
    const schedule = before.schedules.find((item) => item.stages.length > 0)!;
    const stage = schedule.stages[0];
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Материалы");
    sheet.getRow(14).values = [
      "Работа ГПР", "Раздел", "Код ВОР", "Подраздел", "Наименование работы",
      "Материал / конструкция", "Кол-во по ВОР", "Ед. ВОР", "Кол-во для цены",
      "Ед. цены", "Цена за ед., руб.", "Стоимость МТР, руб.", "Новая стоимость материалов",
    ];
    const workbookWorkName = `${stage.name} клиентская работа`;
    sheet.getRow(15).values = [workbookWorkName, "АД", "АД-02", "", "", "Щебень", 5, "м³", 7, "т", 1200, 8400, 9240];
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const file = new File([bytes], "client.xlsx");
    const { POST } = await import("@/app/api/gpr/materials/route");
    const previewForm = new FormData();
    previewForm.set("scheduleId", schedule.id);
    previewForm.set("file", file);
    previewForm.set("preview", "1");
    const preview = await POST(new Request("http://local/api/gpr/materials", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-super")}` },
      body: previewForm,
    }));
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      rows: 1,
      works: [{ workName: workbookWorkName, matches: [] }],
      stages: expect.arrayContaining([{ id: stage.id, name: stage.name }]),
    });
    const form = new FormData();
    form.set("scheduleId", schedule.id);
    form.set("file", file);
    form.set("stageMap", JSON.stringify({ [workbookWorkName]: stage.id }));
    const response = await POST(new Request("http://local/api/gpr/materials", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-super")}` },
      body: form,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imported: 1, stages: 1 });
    const importedSchedule = readAppData().schedules.find((item) => item.id === schedule.id)!;
    const imported = importedSchedule.stages[0].resources?.find((resource) => resource.name === "Щебень");
    expect(imported).toMatchObject({
      kind: "material",
      quantity: 7,
      unit: "т",
      rate: 1200,
      quantityBasis: "material_qty",
    });
  });
});
