import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import "./setup";

async function workbookBuffer(withPosition: boolean): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Смета");
  sheet.addRow(["Шифр", "Наименование", "Ед.", "Количество"]);
  if (withPosition) sheet.addRow(["01-01-001", "Разработка грунта", "м³", 12]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function workbookFile(withPosition: boolean, name: string): Promise<File> {
  const bytes = new Uint8Array(await workbookBuffer(withPosition));
  return new File([bytes.buffer], name);
}

async function postFile(file: File) {
  const form = new FormData();
  form.set("file", file);
  form.set("calcId", "c-1");
  const { POST } = await import("@/app/api/smeta/route");
  return POST(new Request("http://local/api/smeta", {
    method: "POST",
    headers: { authorization: `Bearer ${createSession("u-super")}` },
    body: form,
  }));
}

describe("estimate software exchange import", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("rejects file extensions the XLSX parser cannot handle", async () => {
    const existingIds = readAppData().smetaExchanges.map((item) => item.id);
    const response = await postFile(new File(["code,name,quantity"], "estimate.csv"));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/только XLSX/i) });
    expect(readAppData().smetaExchanges.map((item) => item.id)).toEqual(existingIds);
  });

  it("shows a useful error and saves no exchange when a workbook has no positions", async () => {
    const existingIds = readAppData().smetaExchanges.map((item) => item.id);
    const response = await postFile(await workbookFile(false, "empty.xlsx"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/не найдены сметные позиции/i) });
    expect(readAppData().smetaExchanges.map((item) => item.id)).toEqual(existingIds);
  });

  it("imports recognized positions and returns the updated exchange history", async () => {
    const existingCount = readAppData().smetaExchanges.length;
    const response = await postFile(await workbookFile(true, "estimate.xlsx"));

    expect(response.status).toBe(200);
    expect(readAppData().smetaExchanges).toHaveLength(existingCount + 1);
    expect(readAppData().smetaExchanges[0]).toMatchObject({
      name: "Импорт estimate.xlsx",
      positionsMapped: 1,
      confirmed: false,
    });
    const body = await response.json();
    expect(body.data.smetaExchanges[0].positionsMapped).toBe(1);
  });
});
