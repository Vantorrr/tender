import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  CLIENT_BUNDLE,
  clientSchoolPositions,
  mergeClientDirectoriesInto,
  type ClientBundle,
} from "@/lib/client-dirs";
import { config } from "@/server/config";
import { mutateAppData } from "@/server/db";

function cellVal(cell: ExcelJS.Cell): string | number | null {
  const v = cell.value as unknown;
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && v !== null) {
    const o = v as {
      result?: unknown;
      text?: string;
      richText?: { text: string }[];
      hyperlink?: string;
    };
    if (o.result != null) {
      if (typeof o.result === "number") return o.result;
      if (typeof o.result === "string") return o.result.trim();
    }
    if (Array.isArray(o.richText)) {
      return o.richText.map((x) => x.text).join("").trim();
    }
    if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
    if (typeof o.hyperlink === "string" && !o.text) {
      return o.hyperlink.trim();
    }
  }
  const s = String(v).trim();
  return s === "[object Object]" ? null : s;
}

function asNumber(v: string | number | null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function clientImportsDir() {
  const runtime = path.join(
    /*turbopackIgnore: true*/ config.dataDir,
    "client-imports"
  );
  const fixtures = path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    "fixtures",
    "client-imports"
  );
  if (
    fs.existsSync(runtime) &&
    fs.readdirSync(runtime).some((f) => f.endsWith(".xlsx"))
  ) {
    return runtime;
  }
  return fixtures;
}

export function ensureClientImportFiles(): string {
  const fixtures = path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    "fixtures",
    "client-imports"
  );
  const runtime = path.join(
    /*turbopackIgnore: true*/ config.dataDir,
    "client-imports"
  );
  if (!fs.existsSync(fixtures)) return runtime;
  fs.mkdirSync(runtime, { recursive: true });
  for (const f of fs.readdirSync(fixtures).filter((x) => x.endsWith(".xlsx"))) {
    fs.copyFileSync(path.join(fixtures, f), path.join(runtime, f));
  }
  return runtime;
}

function sniffKind(text: string): "equipment" | "labor" | "fleet" | null {
  const t = text.toLowerCase();
  if (t.includes("тариф") && (t.includes("атс") || t.includes("дсм"))) {
    return "equipment";
  }
  if (t.includes("нормо-час") || t.includes("нормочас") || t.includes("себестоимость одного")) {
    return "labor";
  }
  if (t.includes("легковые") || t.includes("парк") || t.includes("а/м")) {
    return "fleet";
  }
  return null;
}

async function sheetFingerprint(filePath: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const parts: string[] = [];
  for (let r = 1; r <= Math.min(12, ws.rowCount); r++) {
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cellVal(cell);
      if (v != null) parts.push(String(v));
    });
  }
  return parts.join(" | ");
}

export async function parseEquipmentTariffs(
  filePath: string
): Promise<Record<string, string | number>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows: Record<string, string | number>[] = [];
  let category = "";
  ws.eachRow((row, r) => {
    if (r < 10) return;
    const n = cellVal(row.getCell(1));
    const name = cellVal(row.getCell(2));
    const t1 = asNumber(cellVal(row.getCell(3)));
    const t2 = asNumber(cellVal(row.getCell(4)));
    const t3 = asNumber(cellVal(row.getCell(5)));
    const t4 = asNumber(cellVal(row.getCell(6)));
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

export async function parseLaborRates(
  filePath: string
): Promise<Record<string, string | number>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows: Record<string, string | number>[] = [];
  ws.eachRow((row, r) => {
    if (r < 9) return;
    const category = cellVal(row.getCell(1));
    const n = cellVal(row.getCell(2));
    const role = cellVal(row.getCell(3));
    const dept = cellVal(row.getCell(4));
    const rate = asNumber(cellVal(row.getCell(5)));
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

export async function parseFleetInventory(
  filePath: string
): Promise<Record<string, string | number>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  let category = "";
  const counts = new Map<string, { category: string; name: string; qty: number }>();
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

export type ClientImportResult = {
  equipment: number;
  labor: number;
  fleet: number;
  files: string[];
  source: "xlsx" | "bundle";
};

async function resolveClientFiles(dir: string): Promise<{
  equipPath: string;
  laborPath: string;
  fleetPath: string;
}> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".xlsx"));
  const byName = (names: string[]) => {
    for (const n of names) {
      const hit = files.find((f) => f.toLowerCase() === n.toLowerCase());
      if (hit) return path.join(dir, hit);
    }
    return null;
  };

  let equipPath = byName([
    "tarify-ats-dsm-2026.xlsx",
    "file1.xlsx",
    "41c4dbd444de7fe052be6d8a692b4b65_dee5.xlsx",
  ]);
  let laborPath = byName([
    "sebestoimost-normochas.xlsx",
    "file2.xlsx",
    "0610c459bbd4bb4672cce1316673ad25_b751.xlsx",
  ]);
  let fleetPath = byName([
    "park-tehniki.xlsx",
    "file3.xlsx",
    "5482c7bd4f29396b76a873428a9ccc5d_916f.xlsx",
  ]);

  if (!equipPath || !laborPath || !fleetPath) {
    const classified: Partial<
      Record<"equipment" | "labor" | "fleet", string>
    > = {};
    for (const f of files) {
      const fp = path.join(dir, f);
      const kind = sniffKind(await sheetFingerprint(fp));
      if (kind && !classified[kind]) classified[kind] = fp;
    }
    equipPath = equipPath ?? classified.equipment ?? null;
    laborPath = laborPath ?? classified.labor ?? null;
    fleetPath = fleetPath ?? classified.fleet ?? null;
  }

  if (!equipPath || !laborPath || !fleetPath) {
    throw new Error(
      "Нужны 3 xlsx: тарифы АТС/ДСМ, нормо-час, парк техники (по имени или содержимому)"
    );
  }
  return { equipPath, laborPath, fleetPath };
}

function applyBundleToApp(
  actorId: string,
  bundle: Pick<ClientBundle, "equipment" | "labor" | "fleet">,
  files: string[],
  source: "xlsx" | "bundle"
): ClientImportResult {
  const now = new Date().toISOString();
  mutateAppData((data) => {
    data.directories = mergeClientDirectoriesInto(data.directories, actorId).map(
      (d) => {
        if (d.type === "ceny" && d.current) {
          return { ...d, rows: bundle.equipment, at: now, authorId: actorId };
        }
        if (d.type === "rascenki" && d.current) {
          return { ...d, rows: bundle.labor, at: now, authorId: actorId };
        }
        if (d.type === "park" && d.current) {
          return { ...d, rows: bundle.fleet, at: now, authorId: actorId };
        }
        return d;
      }
    );

    const rasc = data.directories.find((d) => d.type === "rascenki" && d.current);
    const school = clientSchoolPositions();
    data.calculations = data.calculations.map((c) => {
      if (c.id !== "c-1") return c;
      return {
        ...c,
        positions: school,
        directoryVersionId: rasc?.id ?? c.directoryVersionId,
        assumptions: [
          "Клиентские тарифы АТС/ДСМ и нормо-час 2026 (приказ)",
          "Объёмы: 2400 н-ч дорожных, 320 н-ч сварки, 480 маш-час JCB",
          "НР 15% и СП 8% от трудозатрат и техники",
        ],
        updatedAt: now,
      };
    });

    data.auditLog.unshift({
      id: `aud-client-import-${Date.now()}`,
      at: now,
      actorId,
      action: "import",
      entity: "directory",
      entityId: "client-xlsx",
      detail: `Импорт клиента (${source}): техника ${bundle.equipment.length}, труд ${bundle.labor.length}, парк ${bundle.fleet.length}`,
    });
    data.notifications.unshift({
      id: `n-client-${Date.now()}`,
      userId: actorId,
      title: "Справочники обновлены",
      body: `Загружены клиентские тарифы АТС/ДСМ (${bundle.equipment.length}), нормо-час (${bundle.labor.length}), парк (${bundle.fleet.length}).`,
      read: false,
      at: now,
      href: "/cabinet/spravochniki",
    });
    return data;
  });

  return {
    equipment: bundle.equipment.length,
    labor: bundle.labor.length,
    fleet: bundle.fleet.length,
    files,
    source,
  };
}

/** Импорт из XLSX на диске; при отсутствии файлов — из committed JSON-бандла. */
export async function importClientDirectories(
  actorId = "u-super"
): Promise<ClientImportResult> {
  try {
    const dir = ensureClientImportFiles();
    if (fs.existsSync(dir)) {
      const { equipPath, laborPath, fleetPath } = await resolveClientFiles(dir);
      const equipment = await parseEquipmentTariffs(equipPath);
      const labor = await parseLaborRates(laborPath);
      const fleet = await parseFleetInventory(fleetPath);
      if (equipment.length < 10 || labor.length < 10 || fleet.length < 5) {
        throw new Error(
          `Слишком мало строк после разбора: техника ${equipment.length}, труд ${labor.length}, парк ${fleet.length}`
        );
      }
      return applyBundleToApp(
        actorId,
        { equipment, labor, fleet },
        [equipPath, laborPath, fleetPath].map((p) => path.basename(p)),
        "xlsx"
      );
    }
  } catch (err) {
    console.warn("[tk] xlsx import fallback to bundle:", err);
  }

  return applyBundleToApp(
    actorId,
    CLIENT_BUNDLE,
    CLIENT_BUNDLE.source.map((s) => path.basename(s)),
    "bundle"
  );
}

/** Синхронное применение committed-бандла (seed / migrate). */
export function applyClientBundleSync(actorId = "u-super"): ClientImportResult {
  return applyBundleToApp(
    actorId,
    CLIENT_BUNDLE,
    CLIENT_BUNDLE.source.map((s) => path.basename(s)),
    "bundle"
  );
}
