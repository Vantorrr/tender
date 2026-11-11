import ExcelJS from "exceljs";
import { readAppData } from "@/server/db";
import { readUpload } from "@/server/uploads";
import { parseDocxBuffer, parseLegacyWordBuffer } from "@/server/docx-parse";
import { withAnySection, json } from "@/server/http";

const SECTIONS = ["dokumenty", "zakupki", "riski"] as const;

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toLocaleString("ru-RU");
  if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  if ("result" in value && value.result != null) return cellText(value.result as ExcelJS.CellValue);
  if ("text" in value && value.text) return String(value.text);
  return "";
}

export async function GET(req: Request) {
  return withAnySection(req, [...SECTIONS], async (user) => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return json({ error: "Не указан документ" }, 400);
    const doc = readAppData().documents.find((item) => item.id === id);
    if (!doc) return json({ error: "Документ не найден" }, 404);
    if (user.role !== "superadmin" && doc.orgId !== user.orgId) {
      return json({ error: "Нет доступа к данным другой организации" }, 403);
    }
    if (doc.fileType === "pdf") return json({ kind: "pdf" });
    const imageExtension = doc.fileName.toLowerCase().match(/\.(png|jpe?g|webp|tiff?|bmp)$/)?.[1];
    if (imageExtension) {
      if (!doc.storedPath) return json({ error: "Оригинальный файл недоступен" }, 404);
      return readUpload(doc.storedPath)
        ? json({ kind: "image" })
        : json({ error: "Файл не найден на диске" }, 404);
    }
    // RAR uploads are stored as `other` (the document type union intentionally
    // stays compatible with older rows), so detect archives by category too.
    if (doc.fileType === "zip" || doc.category === "archive") {
      return json({
        kind: "archive",
        files: doc.extractedFiles ?? [],
        errors: doc.extractionErrors ?? [],
      });
    }
    if (!doc.storedPath) return json({ error: "Оригинальный файл недоступен" }, 404);
    const bytes = readUpload(doc.storedPath);
    if (!bytes) return json({ error: "Файл не найден на диске" }, 404);

    if (doc.fileType === "docx" || doc.fileType === "doc") {
      const parsed = doc.fileType === "doc"
        ? await parseLegacyWordBuffer(bytes)
        : await parseDocxBuffer(bytes);
      if (!parsed) return json({ error: "Не удалось прочитать Word-документ" }, 422);
      return json({ kind: "docx", paragraphs: parsed.paragraphs.slice(0, 1000) });
    }

    if (doc.fileType === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
      const sheets = workbook.worksheets.slice(0, 20).map((sheet) => {
        const rows: string[][] = [];
        const lastRow = Math.min(sheet.rowCount, 500);
        const lastColumn = Math.min(sheet.columnCount, 30);
        for (let rowIndex = 1; rowIndex <= lastRow; rowIndex += 1) {
          const row = sheet.getRow(rowIndex);
          rows.push(Array.from({ length: lastColumn }, (_, index) => cellText(row.getCell(index + 1).value)));
        }
        return { name: sheet.name, rows };
      });
      return json({ kind: "xlsx", sheets });
    }

    return json({ kind: "unsupported", fileName: doc.fileName });
  });
}
