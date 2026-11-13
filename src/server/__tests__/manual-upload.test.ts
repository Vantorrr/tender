import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { analyzeUpload } from "@/server/grand-smeta";
import { detectArchiveFormat } from "@/server/safe-archive";
import "./setup";

describe("manual procurement file upload", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("keeps a file in the procurement card even when its workbook format cannot be read", async () => {
    const procurement = readAppData().procurements.find((item) => item.orgId === "org-alfa")!;
    const form = new FormData();
    form.set("procurementId", procurement.id);
    form.set("category", "estimate");
    form.set("file", new File(["not an xlsx workbook"], "broken.xlsx"));
    const { POST } = await import("@/app/api/dokumenty/route");
    const response = await POST(new Request("http://local/api/dokumenty", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-super")}` },
      body: form,
    }));

    expect(response.status).toBe(200);
    const uploaded = readAppData().documents.find((document) => document.procurementId === procurement.id && document.fileName === "broken.xlsx");
    expect(uploaded).toMatchObject({
      status: "trebuet_proverki",
    });
    expect(uploaded?.storedPath).toBeTruthy();
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, uploaded!.storedPath!))).toBe(true);
    expect(readAppData().procurements.find((item) => item.id === procurement.id)?.analytics).toBeTruthy();
  });

  it("extracts citations and material rows from a normal client XLSX workbook", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Материалы");
    sheet.getRow(3).values = ["Заказчик", "АО Северная дорога", "Срок подачи", "30.11.2026"];
    sheet.getRow(14).values = [
      "Работа ГПР", "Раздел", "Код ВОР", "Подраздел", "Наименование работы",
      "Материал / конструкция", "Кол-во по ВОР", "Ед. ВОР", "Кол-во для цены",
      "Ед. цены", "Цена за ед., руб.", "Стоимость МТР, руб.", "Новая стоимость материалов",
    ];
    sheet.getRow(15).values = ["Отсыпка грунта", "АД", "АД-02", "Земляное полотно", "Устройство основания", "Щебень С4", 10, "м³", 14, "т", 2400, 33600, 36960];
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(detectArchiveFormat("client-materials.xlsx", bytes)).toBe("none");
    expect(detectArchiveFormat("client-pack.zip", bytes)).toBe("zip");
    const analysis = await analyzeUpload("client-materials.xlsx", "xlsx", bytes);

    expect(analysis.citations.some((citation) => citation.sheet === "Материалы" && citation.cell?.includes("15"))).toBe(true);
    expect(analysis.positions).toContainEqual({ code: "АД-02", name: "Щебень С4", unit: "т", quantity: 14, rate: 2400 });
    expect(analysis.analysis.profileMatch).toBe(false);
    expect(analysis.analyticalNote).toMatch(/Книга прочитана как обычный Excel/);

    const procurement = readAppData().procurements.find((item) => item.orgId === "org-alfa")!;
    const form = new FormData();
    form.set("procurementId", procurement.id);
    form.set("category", "estimate");
    form.set("file", new File([bytes], "client-materials.xlsx"));
    const { POST } = await import("@/app/api/dokumenty/route");
    const response = await POST(new Request("http://local/api/dokumenty", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-super")}` },
      body: form,
    }));
    expect(response.status).toBe(200);
    const uploaded = readAppData().documents.find((document) => document.procurementId === procurement.id && document.fileName === "client-materials.xlsx");
    expect(uploaded?.citations.some((citation) => citation.sheet === "Материалы")).toBe(true);
    expect(uploaded?.estimatePositions).toHaveLength(1);
    expect(readAppData().procurements.find((item) => item.id === procurement.id)?.analytics?.citations.length).toBeGreaterThan(0);
  });
});
