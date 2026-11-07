#!/usr/bin/env node
/**
 * Пересборка src/lib/client-directories.json из fixtures/client-imports/*.xlsx
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "fixtures", "client-imports");
const out = path.join(root, "src", "lib", "client-directories.json");

function cellVal(cell) {
  const v = cell.value;
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && v !== null) {
    if (v.result != null) {
      if (typeof v.result === "number") return v.result;
      if (typeof v.result === "string") return v.result.trim();
    }
    if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join("").trim();
    if (typeof v.text === "string" && v.text.trim()) return v.text.trim();
  }
  const s = String(v).trim();
  return s === "[object Object]" ? null : s;
}
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function parseEquipment(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows = [];
  let category = "";
  ws.eachRow((row, r) => {
    if (r < 10) return;
    const n = cellVal(row.getCell(1));
    const name = cellVal(row.getCell(2));
    const t1 = num(cellVal(row.getCell(3)));
    const t2 = num(cellVal(row.getCell(4)));
    const t3 = num(cellVal(row.getCell(5)));
    const t4 = num(cellVal(row.getCell(6)));
    if (name && (n == null || n === "") && typeof name === "string") {
      category = name;
      return;
    }
    if (typeof name === "string" && name && t1 != null) {
      rows.push({
        code: `ATS-${n ?? rows.length + 1}`,
        category,
        name,
        unit: "руб/маш-час",
        rate_1s_kpi085: t1,
        rate_2s_kpi085: t2 ?? 0,
        rate_1s_kpi10: t3 ?? 0,
        rate_2s_kpi10: t4 ?? 0,
        price: t1,
      });
    }
  });
  return rows;
}

async function parseLabor(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow((row, r) => {
    if (r < 9) return;
    const category = cellVal(row.getCell(1));
    const n = cellVal(row.getCell(2));
    const role = cellVal(row.getCell(3));
    const dept = cellVal(row.getCell(4));
    const rate = num(cellVal(row.getCell(5)));
    if (typeof role === "string" && role && rate != null) {
      rows.push({
        code: `LAB-${n ?? rows.length + 1}`,
        category: typeof category === "string" ? category : "",
        work: role,
        department: typeof dept === "string" ? dept : "",
        unit: "руб/н-ч",
        rate,
      });
    }
  });
  return rows;
}

async function parseFleet(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  let category = "";
  const counts = new Map();
  ws.eachRow((row) => {
    const a = cellVal(row.getCell(1));
    const b = cellVal(row.getCell(2));
    if (typeof a === "string" && a && a === b) {
      category = a.replace(/\s+/g, " ").trim();
      return;
    }
    const name =
      typeof b === "string"
        ? b
        : typeof a === "string" && !/^\d+$/.test(a)
          ? a
          : null;
    if (!name) return;
    const key = `${category}||${name}`;
    const cur = counts.get(key);
    if (cur) cur.qty += 1;
    else counts.set(key, { category, name, qty: 1 });
  });
  let i = 1;
  return [...counts.values()].map((x) => ({
    code: `FLEET-${i++}`,
    category: x.category,
    name: x.name,
    qty: x.qty,
    unit: "ед.",
  }));
}

const equipment = await parseEquipment(path.join(dir, "tarify-ats-dsm-2026.xlsx"));
const labor = await parseLabor(path.join(dir, "sebestoimost-normochas.xlsx"));
const fleet = await parseFleet(path.join(dir, "park-tehniki.xlsx"));
const payload = {
  generatedAt: new Date().toISOString(),
  source: [
    "fixtures/client-imports/tarify-ats-dsm-2026.xlsx",
    "fixtures/client-imports/sebestoimost-normochas.xlsx",
    "fixtures/client-imports/park-tehniki.xlsx",
  ],
  equipment,
  labor,
  fleet,
};
fs.writeFileSync(out, JSON.stringify(payload));
console.log(
  `→ ${out}\n  equipment ${equipment.length} · labor ${labor.length} · fleet ${fleet.length}`
);
