import type ExcelJS from "exceljs";
import { isEstimateNoiseRow, isNumericUnit } from "@/lib/estimate-noise";

export type LsrPosition = {
  code: string;
  name: string;
  unit: string;
  quantity: number;
  rate: number;
  rateMissing?: boolean;
  isWorkItem?: boolean;
  resourceKind?: "labor" | "equipment" | "material";
  sectionName?: string;
  workName?: string;
};

type Columns = {
  code?: number;
  name?: number;
  unit?: number;
  quantity?: number;
  rate?: number;
  total?: number;
  dataStart: number;
};

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).replace(/\s+/g, " ").trim();
  }
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("").replace(/\s+/g, " ").trim();
    }
    if ("text" in value && value.text) return String(value.text).replace(/\s+/g, " ").trim();
    if ("result" in value && value.result != null) return cellText(value.result as ExcelJS.CellValue);
  }
  return "";
}

/** A measure is one number. Digits pulled out of a sentence are not a quantity. */
export function readMeasure(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cellText(value);
  if (!text || /[a-zа-яё%+]/iu.test(text)) return null;
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function fold(text: string): string {
  return text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

function ownText(ws: ExcelJS.Worksheet, row: number, col: number): string {
  return cellText(ws.getRow(row).getCell(col).value);
}

function columnText(ws: ExcelJS.Worksheet, row: number, col: number): string {
  return [0, 1]
    .map((offset) => ownText(ws, row + offset, col))
    .filter(Boolean)
    .join(" ");
}

function splitCipher(text: string): { code: string; name: string } {
  const match = text.match(/^((?:ФЕР|ТЕР|ГЭСН|ФССЦ|ТССЦ|ФСБЦ|ФСЭМ|ТСЭМ|ЕНиР)[\w.\-–]*)\s+(.+)$/iu);
  if (!match) return { code: "", name: text };
  return { code: match[1], name: match[2].trim() };
}

function detectColumns(ws: ExcelJS.Worksheet): Columns | null {
  const last = Math.min(ws.rowCount || 40, 40);
  for (let row = 1; row <= last; row += 1) {
    const joined = fold(Array.from({ length: 18 }, (_, index) => ownText(ws, row, index + 1)).join(" "));
    if (!/наименован/u.test(joined)) continue;
    if (!/ед|количеств|кол-во|\bкол\./u.test(joined)) continue;
    const cols: Columns = { dataStart: row + 1 };
    for (let col = 1; col <= 18; col += 1) {
      const text = fold(columnText(ws, row, col));
      if (!text) continue;
      if (!cols.name && /наименован/u.test(text) && !/обоснован|шифр/u.test(text)) cols.name = col;
      else if (!cols.code && /обоснован|шифр/u.test(text) && !/наименован/u.test(text)) cols.code = col;
      else if (!cols.name && /наименован/u.test(text)) cols.name = col;
      if (!cols.unit && /ед\.?\s*изм|единица\s+измер/u.test(text) && !/стоим|цен/u.test(text)) cols.unit = col;
      if (!cols.quantity && /количеств|кол-во|(?:^|\s)кол\./u.test(text) && !/стоим|цен/u.test(text)) cols.quantity = col;
      if (!cols.rate && /стоим\p{L}*\s+единиц|на\s+единицу|цена\s+за\s+ед/u.test(text) && /всего/u.test(text) && !/оплат|машин|материал/u.test(text)) cols.rate = col;
      if (!cols.total && /общ\p{L}*\s+стоим/u.test(text) && /всего/u.test(text)) cols.total = col;
    }
    if (cols.name && /обоснован|шифр/u.test(fold(columnText(ws, row, cols.name))) && !cols.code) cols.code = cols.name;
    if (!cols.rate && cols.quantity) {
      for (let col = cols.quantity + 1; col <= cols.quantity + 6; col += 1) {
        const text = fold(columnText(ws, row, col));
        if (/всего/u.test(text) && /стоим|единиц/u.test(text) && !/оплат|машин|материал/u.test(text)) {
          cols.rate = col;
          break;
        }
      }
    }
    if (!cols.name || !cols.unit || !cols.quantity || !cols.rate) continue;
    const lsrShape = /обоснован|шифр/u.test(joined) && /стоимост\p{L}*\s+единиц|на\s+единицу/u.test(joined);
    if (!lsrShape) continue;
    let start = row + 1;
    for (let probe = row + 1; probe <= row + 4; probe += 1) {
      const probeText = fold(Array.from({ length: 8 }, (_, index) => cellText(ws.getRow(probe).getCell(index + 1).value)).join(" "));
      if (/всего|оплат|эксплуатац|^[\d\s]+$/u.test(probeText) && !/фер|гэсн|тер/u.test(probeText)) start = probe + 1;
    }
    cols.dataStart = start;
    return cols;
  }
  return null;
}

function resourceKind(name: string, unit: string): LsrPosition["resourceKind"] | undefined {
  if (/чел\.?\s*[-.]?\s*ч|затрат\p{L}*\s+труда\s+рабоч/iu.test(`${name} ${unit}`)) return "labor";
  if (/маш\.?\s*[-.]?\s*ч|затрат\p{L}*\s+труда\s+машин/iu.test(`${name} ${unit}`)) return "equipment";
  return undefined;
}

/** 15-column local estimate. Null when the sheet is not that form. */
export function parseLsrWorksheet(ws: ExcelJS.Worksheet): LsrPosition[] | null {
  const columns = detectColumns(ws);
  if (!columns?.name || !columns.unit || !columns.quantity) return null;
  const positions: LsrPosition[] = [];
  let sectionName = "";
  let workName = "";
  const last = Math.min(ws.rowCount || 5000, 5000);
  for (let row = columns.dataStart; row <= last; row += 1) {
    const nameCell = cellText(ws.getRow(row).getCell(columns.name).value);
    const codeCell = columns.code && columns.code !== columns.name
      ? cellText(ws.getRow(row).getCell(columns.code).value)
      : "";
    if (/^раздел\b/iu.test(nameCell) && !codeCell) {
      sectionName = nameCell;
      workName = "";
      continue;
    }
    const combined = codeCell && codeCell !== nameCell ? { code: codeCell, name: nameCell } : splitCipher(nameCell || codeCell);
    const name = combined.name.trim();
    const code = combined.code.trim();
    if (!name || /^наименован/iu.test(name)) continue;
    if (isEstimateNoiseRow(name, code)) continue;
    const unit = cellText(ws.getRow(row).getCell(columns.unit).value);
    if (!unit || isNumericUnit(unit)) continue;
    const quantity = readMeasure(ws.getRow(row).getCell(columns.quantity).value);
    if (quantity == null || quantity === 0) continue;
    const priced = columns.rate ? readMeasure(ws.getRow(row).getCell(columns.rate).value) : null;
    const total = columns.total ? readMeasure(ws.getRow(row).getCell(columns.total).value) : null;
    const rate = priced != null && priced > 0
      ? priced
      : total != null && quantity !== 0
        ? Math.round((total / quantity) * 100) / 100
        : 0;
    const kind = resourceKind(name, unit);
    const work = !kind && /^(?:ФЕР|ТЕР|ГЭСН|ЕНиР)/iu.test(code);
    if (work) workName = name;
    positions.push({
      code: code || "ЛСР",
      name: name.slice(0, 240),
      unit,
      quantity,
      rate,
      ...(rate <= 0 ? { rateMissing: true } : {}),
      ...(work ? { isWorkItem: true } : {}),
      ...(kind ? { resourceKind: kind } : {}),
      ...(sectionName ? { sectionName } : {}),
      ...(workName ? { workName } : {}),
    });
    if (positions.length >= 2000) break;
  }
  return positions.length ? positions : null;
}

export async function parseLsrWorkbook(buf: Buffer): Promise<LsrPosition[]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const positions: LsrPosition[] = [];
  for (const ws of wb.worksheets) {
    const parsed = parseLsrWorksheet(ws);
    if (parsed?.length) positions.push(...parsed);
  }
  return positions;
}
