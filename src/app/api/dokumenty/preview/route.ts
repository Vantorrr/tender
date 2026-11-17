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
        const lastRow = Math.min(sheet.rowCount, 500);
        const usedVisibleColumns = new Set<number>();
        for (let rowIndex = 1; rowIndex <= lastRow; rowIndex += 1) {
          sheet.getRow(rowIndex).eachCell({ includeEmpty: false }, (cell) => {
            if (cell.value == null || cell.isMerged && cell.master.address !== cell.address) return;
            const columnNumber = cell.fullAddress.col;
            if (!sheet.getColumn(columnNumber).hidden) usedVisibleColumns.add(columnNumber);
          });
        }
        const usedColumnNumbers = [...usedVisibleColumns].sort((a, b) => a - b);
        const firstColumn = usedColumnNumbers[0] ?? 1;
        const lastColumn = usedColumnNumbers.at(-1) ?? Math.min(sheet.columnCount, 14);
        const sourceColumns = Array.from({ length: Math.max(1, lastColumn - firstColumn + 1) }, (_, index) => firstColumn + index)
          .filter((columnNumber) => !sheet.getColumn(columnNumber).hidden)
          .slice(0, 30);
        const visibleColumnIndex = new Map(sourceColumns.map((columnNumber, index) => [columnNumber, index]));
        const columns = sourceColumns.map((columnNumber) => {
          const column = sheet.getColumn(columnNumber);
          return { sourceIndex: columnNumber, width: Math.max(56, Math.min(360, Math.round((column.width ?? 10) * 7))) };
        });
        const merges: Array<{ row: number; column: number; rowSpan: number; colSpan: number }> = sheet.model.merges.flatMap((range) => {
          const [startAddress, endAddress] = range.split(":");
          if (!startAddress || !endAddress) return [];
          const start = sheet.getCell(startAddress);
          const end = sheet.getCell(endAddress);
          const startRow = start.fullAddress.row;
          const endRow = end.fullAddress.row;
          const startCol = start.fullAddress.col;
          const endCol = end.fullAddress.col;
          const startColumn = visibleColumnIndex.get(startCol);
          const visibleMergeColumns = sourceColumns.filter((column) => column >= startCol && column <= endCol).length;
          if (startRow > lastRow || startColumn == null || visibleMergeColumns < 2 && startRow === endRow) return [];
          return [{
            row: startRow - 1,
            column: startColumn,
            rowSpan: Math.min(endRow, lastRow) - startRow + 1,
            colSpan: Math.max(1, visibleMergeColumns),
          }];
        });
        // Excel lets long, unwrapped text flow over empty neighboring cells.
        // A browser table would wrap it into a very narrow column, so emulate
        // that behavior where the adjacent cells are genuinely empty.
        for (let rowIndex = 1; rowIndex <= lastRow; rowIndex += 1) {
          const row = sheet.getRow(rowIndex);
          for (let visibleIndex = 0; visibleIndex < sourceColumns.length - 1; visibleIndex += 1) {
            const sourceColumn = sourceColumns[visibleIndex];
            const cell = row.getCell(sourceColumn);
            if (cell.value == null || cell.isMerged || cell.alignment?.wrapText) continue;
            const value = cellText(cell.value).trim();
            const width = Math.max(56, Math.min(360, Math.round((sheet.getColumn(sourceColumn).width ?? 10) * 7)));
            if (value.length <= Math.max(12, width / 7 * 1.4)) continue;
            let span = 1;
            for (let nextIndex = visibleIndex + 1; nextIndex < sourceColumns.length && span < 8; nextIndex += 1) {
              const nextCell = row.getCell(sourceColumns[nextIndex]);
              if (nextCell.value != null || nextCell.isMerged) break;
              span += 1;
            }
            if (span > 1) merges.push({ row: rowIndex - 1, column: visibleIndex, rowSpan: 1, colSpan: span });
          }
        }
        const rows: Array<{ number: number; height?: number; cells: string[] }> = [];
        for (let rowIndex = 1; rowIndex <= lastRow; rowIndex += 1) {
          const row = sheet.getRow(rowIndex);
          rows.push({
            number: rowIndex,
            height: row.height ? Math.max(20, Math.min(180, Math.round(row.height * 1.33))) : undefined,
            cells: sourceColumns.map((columnNumber) => {
              const cell = row.getCell(columnNumber);
              return cell.isMerged && cell.master.address !== cell.address ? "" : cellText(cell.value);
            }),
          });
        }
        return { name: sheet.name, rows, columns, merges };
      });
      return json({ kind: "xlsx", sheets });
    }

    return json({ kind: "unsupported", fileName: doc.fileName });
  });
}
