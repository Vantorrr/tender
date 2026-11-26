/**
 * Read ЗТ and machine-hour totals from a Grand Smeta workbook.
 * The rows stay out of the calculation: they only feed GPR duration.
 */
import * as XLSX from "xlsx";
import { foldStageKey, type EstimateNormHours } from "@/lib/estimate-norm-hours";

const WORK_CODE = /^(?:ЕНиР|ФЕР|ТЕР|ГЭСН)(?:м)?/iu;

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "object" && "w" in value && typeof value.w === "string") return value.w.replace(/\s+/g, " ").trim();
  return "";
}

function positive(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function readEstimateNormHours(bytes: Buffer): EstimateNormHours[] {
  const book = XLSX.read(bytes, { type: "buffer" });
  const sheetName = book.SheetNames[0];
  if (!sheetName) return [];
  const sheet = book.Sheets[sheetName];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
  const totals = new Map<string, EstimateNormHours>();
  let section = "";
  let work = "";
  for (const raw of rows) {
    const row = Array.isArray(raw) ? raw : [];
    const label = text(row[0]);
    const code = text(row[1]);
    const name = text(row[2]).slice(0, 240);
    const unit = text(row[5]);
    if (/^раздел\s/iu.test(label)) {
      section = label;
      work = "";
      continue;
    }
    if (/^\d+$/u.test(label) && WORK_CODE.test(code) && name) {
      work = name;
      continue;
    }
    if (!section || !work) continue;
    const quantity = positive(row[8]);
    if (quantity == null) continue;
    const folded = name.toLocaleLowerCase("ru-RU");
    const key = foldStageKey(section, work);
    const slot = totals.get(key) ?? { sectionName: section, workName: work, laborHours: 0, machineHours: 0 };
    if (folded === "зт" || folded === "затраты труда рабочих") slot.laborHours += quantity;
    else if (/^маш/iu.test(unit) && /ч/iu.test(unit)) slot.machineHours += quantity;
    totals.set(key, slot);
  }
  return [...totals.values()].filter((row) => row.laborHours > 0 || row.machineHours > 0);
}
