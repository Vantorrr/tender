/**
 * Validate directory import headers/rows for supported formats (xlsx/csv).
 * Bundle fallback is NOT treated as a successful user import.
 */
import type { AppData } from "@/lib/types";

export type DirectoryType = AppData["directories"][0]["type"];

const REQUIRED: Record<DirectoryType, string[]> = {
  normy: ["code", "name", "unit"],
  rascenki: ["code", "work", "unit", "rate"],
  ceny: ["code", "name"],
  park: ["code", "name"],
  profil: ["region"],
};

export type ImportValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  normalizedHeaders: string[];
};

export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\wа-яё]/gi, "");
}

export function validateDirectoryImport(
  type: DirectoryType,
  rows: Record<string, string | number>[],
  headers?: string[]
): ImportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!rows.length) {
    errors.push("Нет строк данных");
    return { ok: false, errors, warnings, normalizedHeaders: [] };
  }
  const keys = headers?.length
    ? headers.map(normalizeHeader)
    : Object.keys(rows[0] ?? {}).map(normalizeHeader);
  const required = REQUIRED[type] ?? ["name"];
  const missing = required.filter((r) => !keys.includes(r) && !keys.includes(normalizeHeader(r)));
  // Also accept common aliases
  const aliases: Record<string, string[]> = {
    work: ["name", "работа", "work"],
    rate: ["price", "ставка", "rate", "тариф"],
    name: ["name", "наименование", "работа", "work"],
    code: ["code", "код"],
    unit: ["unit", "ед", "единица"],
    region: ["region", "регион"],
  };
  const hasField = (req: string) => {
    if (keys.includes(req)) return true;
    const al = aliases[req] ?? [req];
    return al.some((a) => keys.includes(normalizeHeader(a)));
  };
  for (const r of required) {
    if (!hasField(r)) missing.push(r);
  }
  const uniqMissing = [...new Set(missing)];
  if (uniqMissing.length) {
    errors.push(
      `Нет обязательных колонок для «${type}»: ${uniqMissing.join(", ")}. Ожидались: ${required.join(", ")}`
    );
  }
  if (rows.length > 5000) {
    errors.push("Слишком много строк (>5000)");
  }
  let emptyRate = 0;
  if (type === "rascenki" || type === "ceny") {
    for (const row of rows) {
      const rate = row.rate ?? row.price ?? row.rate_1s_kpi10;
      if (rate === undefined || rate === "" || rate === null) emptyRate += 1;
    }
    if (emptyRate === rows.length) {
      warnings.push("Все строки без ставки/цены — импорт возможен, но расценки «нет данных»");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalizedHeaders: keys,
  };
}

/** Parse simple CSV (semicolon or comma) into row objects. */
export function parseDirectoryCsv(text: string): Record<string, string | number>[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(sep).map((h) => h.trim());
  const rows: Record<string, string | number>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep);
    const obj: Record<string, string | number> = {};
    let empty = true;
    headers.forEach((h, idx) => {
      const raw = (cols[idx] ?? "").trim();
      if (!raw) return;
      empty = false;
      const num = Number(raw.replace(",", "."));
      obj[h] = Number.isFinite(num) && /^-?\d/.test(raw) ? num : raw;
    });
    if (!empty) rows.push(obj);
  }
  return rows;
}
