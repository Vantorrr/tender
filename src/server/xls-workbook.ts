/**
 * Excel 97–2003 BIFF8 (.xls) via SheetJS. ExcelJS reads only OOXML.
 * The bytes are converted to an .xlsx buffer and then follow the existing parser.
 */
import * as XLSX from "xlsx";

export function isLegacyXlsName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".xls") && !fileName.toLowerCase().endsWith(".xlsx");
}

/** OLE compound document, the container of a binary .xls workbook. */
export function isOleCompound(bytes: Buffer): boolean {
  return bytes.length >= 8
    && bytes[0] === 0xd0
    && bytes[1] === 0xcf
    && bytes[2] === 0x11
    && bytes[3] === 0xe0;
}

export function convertXlsToXlsx(bytes: Buffer): Buffer {
  if (!isOleCompound(bytes)) {
    throw new Error("Файл .xls не является книгой Excel 97–2003");
  }
  const book = XLSX.read(bytes, { type: "buffer", cellDates: true });
  if (!book.SheetNames.length) {
    throw new Error("В книге Excel нет листов");
  }
  const out = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(out as Uint8Array) as Buffer;
}
