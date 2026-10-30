import clientBundle from "@/lib/client-directories.json";
import type { CalcPosition, DirectoryVersion } from "@/lib/types";

export type ClientBundle = {
  generatedAt: string;
  source: string[];
  equipment: Record<string, string | number>[];
  labor: Record<string, string | number>[];
  fleet: Record<string, string | number>[];
};

export const CLIENT_BUNDLE = clientBundle as ClientBundle;

export function clientDirectoryVersions(
  authorId = "u-super",
  at = "2026-10-30T10:00:00Z"
): DirectoryVersion[] {
  return [
    {
      id: "dir-ceny-client-1",
      type: "ceny",
      name: "Тарифы АТС и ДСМ 2026 (клиент)",
      version: 1,
      authorId,
      at,
      current: true,
      rows: CLIENT_BUNDLE.equipment,
    },
    {
      id: "dir-rascenki-client-1",
      type: "rascenki",
      name: "Себестоимость нормо-часа 2026 (клиент)",
      version: 1,
      authorId,
      at,
      current: true,
      rows: CLIENT_BUNDLE.labor,
    },
    {
      id: "dir-park-client-1",
      type: "park",
      name: "Парк техники (клиент)",
      version: 1,
      authorId,
      at,
      current: true,
      rows: CLIENT_BUNDLE.fleet,
    },
  ];
}

export function findLabor(predicate: (work: string) => boolean) {
  return CLIENT_BUNDLE.labor.find((r) => predicate(String(r.work ?? "")));
}

export function findEquipment(predicate: (name: string) => boolean) {
  return CLIENT_BUNDLE.equipment.find((r) => predicate(String(r.name ?? "")));
}

/** Демо-позиции c-1 на клиентских ставках с согласованными объёмами. */
export function clientSchoolPositions(): CalcPosition[] {
  const road = findLabor((w) => w.toLowerCase().includes("дорожный"));
  const welder = findLabor((w) =>
    w.toLowerCase().includes("электрогазосварщик")
  );
  const digger = findEquipment((n) => n.toUpperCase().includes("JCB"));
  const positions: CalcPosition[] = [];
  if (road) {
    positions.push({
      id: "cp-1",
      code: String(road.code),
      name: String(road.work),
      unit: "н-ч",
      quantity: 2400,
      rate: Number(road.rate),
    });
  }
  if (welder) {
    positions.push({
      id: "cp-2",
      code: String(welder.code),
      name: String(welder.work),
      unit: "н-ч",
      quantity: 320,
      rate: Number(welder.rate),
    });
  }
  if (digger) {
    positions.push({
      id: "cp-3",
      code: String(digger.code),
      name: String(digger.name),
      unit: "маш-час",
      quantity: 480,
      rate: Number(digger.price ?? digger.rate_1s_kpi085),
    });
  }
  const works = positions.reduce((s, p) => s + p.quantity * p.rate, 0);
  positions.push({
    id: "cp-4",
    code: "НР",
    name: "Накладные расходы 15%",
    unit: "руб",
    quantity: 1,
    rate: Math.round(works * 0.15),
  });
  positions.push({
    id: "cp-5",
    code: "СП",
    name: "Сметная прибыль 8%",
    unit: "руб",
    quantity: 1,
    rate: Math.round(works * 0.08),
  });
  return positions;
}

const DEFAULT_PROFIL_ROWS: Record<string, string | number>[] = [
  { region: "Москва", okpd: "41.20", maxNmck: 200000000 },
  { region: "Московская область", okpd: "41.20", maxNmck: 300000000 },
  { region: "Тула", okpd: "42.21", maxNmck: 150000000 },
];

function looksLikeFleetDir(d: DirectoryVersion): boolean {
  if (/парк/i.test(d.name)) return true;
  const row = d.rows[0];
  return Boolean(row && ("qty" in row || row.unit === "ед."));
}

/** Чинит старый импорт, когда парк писал в type=profil. */
export function restoreProcurementProfile(
  directories: DirectoryVersion[],
  authorId = "u-super"
): DirectoryVersion[] {
  const now = new Date().toISOString();
  let next = directories.map((d) => {
    if (d.type === "profil" && d.current && looksLikeFleetDir(d)) {
      return { ...d, current: false, name: `${d.name} (архив→парк)` };
    }
    return d;
  });
  const hasGoodProfil = next.some(
    (d) =>
      d.type === "profil" &&
      d.current &&
      d.rows.some((r) => "region" in r || "okpd" in r)
  );
  if (!hasGoodProfil) {
    next = next.map((d) =>
      d.type === "profil" ? { ...d, current: false } : d
    );
    const same = next.filter((d) => d.type === "profil");
    const version = Math.max(0, ...same.map((d) => d.version), 0) + 1;
    next.push({
      id: `dir-profil-${version}`,
      type: "profil",
      name: "Профиль закупок АльфаСтрой",
      version,
      authorId,
      at: now,
      current: true,
      rows: DEFAULT_PROFIL_ROWS,
    });
  }
  return next;
}

export function mergeClientDirectoriesInto(
  directories: DirectoryVersion[],
  authorId = "u-super"
): DirectoryVersion[] {
  const now = new Date().toISOString();
  let next = restoreProcurementProfile(directories, authorId);
  const incoming = clientDirectoryVersions(authorId, now);
  next = next.map((d) => {
    if (d.type === "ceny" || d.type === "rascenki" || d.type === "park") {
      return { ...d, current: false };
    }
    return d;
  });
  for (const dir of incoming) {
    const same = next.filter((d) => d.type === dir.type);
    const version = Math.max(0, ...same.map((d) => d.version), 0) + 1;
    next = next.filter((d) => d.id !== dir.id);
    next.push({
      ...dir,
      id: `dir-${dir.type}-client-${version}`,
      version,
      at: now,
      authorId,
      current: true,
    });
  }
  return next;
}

export function rateFromRow(
  row: Record<string, string | number>,
  rateKey?: string
): number | null {
  if (rateKey && typeof row[rateKey] === "number") {
    return row[rateKey] as number;
  }
  if (typeof row.rate === "number") return row.rate;
  if (typeof row.price === "number") return row.price;
  if (typeof row.rate_1s_kpi085 === "number") return row.rate_1s_kpi085;
  return null;
}

export function resolveDirectoryRate(
  directories: DirectoryVersion[],
  code: string
): { rate: number; name?: string; unit?: string; dirId: string } | null {
  const order: DirectoryVersion["type"][] = [
    "rascenki",
    "ceny",
    "park",
    "normy",
    "profil",
  ];
  for (const type of order) {
    const dir = directories.find((d) => d.type === type && d.current);
    if (!dir) continue;
    const row = dir.rows.find(
      (r) => String(r.code ?? r.sku ?? "") === code
    );
    if (!row) continue;
    const rate = rateFromRow(row);
    if (rate == null) continue;
    return {
      rate,
      name: String(row.name ?? row.work ?? code),
      unit: row.unit != null ? String(row.unit) : undefined,
      dirId: dir.id,
    };
  }
  return null;
}
