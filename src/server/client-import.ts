import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
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
      formula?: string;
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

/** Tracked fixtures first, then runtime data/client-imports overlay. */
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
  if (fs.existsSync(runtime) && fs.readdirSync(runtime).some((f) => f.endsWith(".xlsx"))) {
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
    const dest = path.join(runtime, f);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(fixtures, f), dest);
    }
  }
  return runtime;
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
    const t1 = cellVal(row.getCell(3));
    const t2 = cellVal(row.getCell(4));
    const t3 = cellVal(row.getCell(5));
    const t4 = cellVal(row.getCell(6));
    if (name && (n == null || n === "") && typeof name === "string") {
      category = name;
      return;
    }
    if (typeof name === "string" && name && typeof t1 === "number") {
      rows.push({
        code: `ATS-${n ?? rows.length + 1}`,
        category,
        name,
        unit: "руб/смена",
        rate_1s_kpi085: t1,
        rate_2s_kpi085: typeof t2 === "number" ? t2 : 0,
        rate_1s_kpi10: typeof t3 === "number" ? t3 : 0,
        rate_2s_kpi10: typeof t4 === "number" ? t4 : 0,
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
    const rate = cellVal(row.getCell(5));
    if (typeof role === "string" && role && typeof rate === "number") {
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
    const name = typeof b === "string" ? b : typeof a === "string" && !/^\d+$/.test(a) ? a : null;
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
};

/** Import client xlsx from fixtures/data into directories (current versions). */
export async function importClientDirectories(
  actorId = "u-super"
): Promise<ClientImportResult> {
  const dir = ensureClientImportFiles();
  if (!fs.existsSync(dir)) {
    throw new Error(`Нет папки импорта: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".xlsx"));
  // prefer named files, else file1/2/3
  const pick = (...names: string[]) => {
    for (const n of names) {
      const hit = files.find((f) => f.toLowerCase() === n.toLowerCase());
      if (hit) return path.join(dir, hit);
    }
    return null;
  };
  const equipPath =
    pick(
      "tarify-ats-dsm-2026.xlsx",
      "file1.xlsx",
      "41c4dbd444de7fe052be6d8a692b4b65_dee5.xlsx"
    ) ?? (files[0] ? path.join(dir, files[0]) : null);
  const laborPath =
    pick(
      "sebestoimost-normochas.xlsx",
      "file2.xlsx",
      "0610c459bbd4bb4672cce1316673ad25_b751.xlsx"
    ) ?? (files[1] ? path.join(dir, files[1]) : null);
  const fleetPath =
    pick(
      "park-tehniki.xlsx",
      "file3.xlsx",
      "5482c7bd4f29396b76a873428a9ccc5d_916f.xlsx"
    ) ?? (files[2] ? path.join(dir, files[2]) : null);

  if (!equipPath || !laborPath || !fleetPath) {
    throw new Error("Нужны 3 xlsx в data/client-imports (тарифы / нормо-час / парк)");
  }

  const equipment = await parseEquipmentTariffs(equipPath);
  const labor = await parseLaborRates(laborPath);
  const fleet = await parseFleetInventory(fleetPath);
  const now = new Date().toISOString();

  mutateAppData((data) => {
    const bump = (
      type: "ceny" | "rascenki" | "profil",
      name: string,
      rows: Record<string, string | number>[]
    ) => {
      data.directories = data.directories.map((d) =>
        d.type === type ? { ...d, current: false } : d
      );
      const same = data.directories.filter((d) => d.type === type);
      const version = Math.max(0, ...same.map((d) => d.version)) + 1;
      data.directories.push({
        id: `dir-${type}-client-${version}`,
        type,
        name,
        version,
        authorId: actorId,
        at: now,
        current: true,
        rows,
      });
    };

    bump(
      "ceny",
      "Тарифы АТС и ДСМ 2026 (клиент)",
      equipment
    );
    bump(
      "rascenki",
      "Себестоимость нормо-часа 2026 (клиент)",
      labor
    );
    bump(
      "profil",
      "Парк техники (клиент)",
      fleet
    );

    // refresh sample calc rates from client directories where codes match loosely
    const digger = equipment.find((e) =>
      String(e.name).toUpperCase().includes("JCB")
    );
    const welder = labor.find((l) =>
      String(l.work).toLowerCase().includes("электрогазосварщик")
    );
    const road = labor.find((l) =>
      String(l.work).toLowerCase().includes("дорожный")
    );
    data.calculations = data.calculations.map((c) => {
      if (c.id !== "c-1") return c;
      return {
        ...c,
        assumptions: [
          ...c.assumptions.filter((a) => !a.startsWith("Клиентские тарифы")),
          "Клиентские тарифы: АТС/ДСМ + нормо-час загружены из приказов 2026",
        ],
        positions: c.positions.map((p, idx) => {
          if (idx === 0 && road && typeof road.rate === "number") {
            return {
              ...p,
              name: String(road.work),
              unit: "н-ч",
              rate: road.rate as number,
              code: String(road.code),
            };
          }
          if (idx === 1 && welder && typeof welder.rate === "number") {
            return {
              ...p,
              name: String(welder.work),
              unit: "н-ч",
              rate: welder.rate as number,
              code: String(welder.code),
            };
          }
          if (idx === 2 && digger && typeof digger.price === "number") {
            return {
              ...p,
              name: `${digger.name} (смена)`,
              unit: "смена",
              rate: digger.price as number,
              code: String(digger.code),
            };
          }
          return p;
        }),
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
      detail: `Импорт клиента: техника ${equipment.length}, труд ${labor.length}, парк ${fleet.length}`,
    });
    data.notifications.unshift({
      id: `n-client-${Date.now()}`,
      userId: actorId,
      title: "Справочники обновлены",
      body: `Загружены клиентские тарифы АТС/ДСМ (${equipment.length}), нормо-час (${labor.length}), парк (${fleet.length}).`,
      read: false,
      at: now,
      href: "/cabinet/spravochniki",
    });
    return data;
  });

  return {
    equipment: equipment.length,
    labor: labor.length,
    fleet: fleet.length,
    files: [equipPath, laborPath, fleetPath].map((p) => path.basename(p)),
  };
}
