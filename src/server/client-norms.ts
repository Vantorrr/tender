/**
 * Idempotent import of the four client reference catalogs.
 * Writes only client_norm_* tables. Does not touch app_blob, cost summaries or GPR.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  foldNormSearch,
  isClientNormKind,
  likePattern,
  type ClientNormCatalogSummary,
  type ClientNormKind,
  type ClientNormQuery,
  type ClientNormWarning,
  type HaulLegRow,
  type LaborNormRow,
  type OutputNormRow,
  type SiteBenchmarkRow,
} from "@/lib/client-norms";

const FILES: Record<ClientNormKind, string> = {
  output: "01-normy-vyrabotki-zemlya-dorogi.json",
  labor: "02-normy-truda-metallokonstrukcii.json",
  tkm: "03-kalkulyator-t-km-tehnika.json",
  sites: "04-foto-rabochego-dnya-i-potrebnost-uchastkov.json",
};

const TABLE: Record<ClientNormKind, string> = {
  output: "client_output_norm",
  labor: "client_labor_norm",
  tkm: "client_haul_leg",
  sites: "client_site_benchmark",
};

export interface ClientNormImportReport {
  imported: string[];
  unchanged: string[];
  counts: Record<ClientNormKind, number>;
}

interface CatalogHeader {
  sourceLine: string;
  notes: unknown;
  [key: string]: unknown;
}

let fixtureHashCache: Record<string, string> | null = null;

export function clientNormsDir(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "fixtures", "client-norms");
}

function fixturePath(fileName: string): string {
  return path.join(clientNormsDir(), fileName);
}

function fixtureHashes(): Record<string, string> {
  if (fixtureHashCache) return fixtureHashCache;
  const hashes: Record<string, string> = {};
  for (const fileName of Object.values(FILES)) {
    const buf = fs.readFileSync(/*turbopackIgnore: true*/ fixturePath(fileName));
    hashes[fileName] = crypto.createHash("sha256").update(buf).digest("hex");
  }
  fixtureHashCache = hashes;
  return hashes;
}

function readFixture(kind: ClientNormKind): unknown {
  const fileName = FILES[kind];
  return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ fixturePath(fileName), "utf8")) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Справочник ${label}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Справочник ${label}: ожидался список`);
  return value;
}

function textOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mustNum(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Справочник: нет числа «${label}»`);
}

function searchBlob(parts: unknown[]): string {
  return parts
    .map((part) => (typeof part === "string" || typeof part === "number" ? foldNormSearch(String(part)) : ""))
    .filter(Boolean)
    .join(" ");
}

function warn(code: string, text: string): ClientNormWarning {
  return { code, text };
}

function withTx(db: DatabaseSync, fn: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the original error is the one that matters */
    }
    throw error;
  }
}

export function ensureClientNormTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_norm_catalog (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      shift_hours INTEGER,
      source_file TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      header_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS client_output_norm (
      catalog_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      excel_row INTEGER NOT NULL,
      section TEXT NOT NULL,
      work_name TEXT NOT NULL,
      unit TEXT,
      soil_name TEXT,
      soil_group TEXT,
      mechanism TEXT,
      machine_hours_norm REAL,
      crew TEXT,
      productivity_per_hour REAL,
      productivity_per_shift_11h REAL,
      shift_hours INTEGER NOT NULL,
      shift_equals_hour_times_11 INTEGER NOT NULL,
      section_fold TEXT NOT NULL,
      work_fold TEXT NOT NULL,
      mechanism_fold TEXT NOT NULL,
      search_text TEXT NOT NULL,
      PRIMARY KEY (catalog_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS client_labor_norm (
      catalog_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      operation_number INTEGER NOT NULL,
      operation_title TEXT NOT NULL,
      subsection TEXT,
      norm_on TEXT,
      material TEXT,
      size_label TEXT,
      size TEXT,
      unit TEXT,
      k REAL,
      norm_per_shift_11h REAL,
      time_hours_per_unit REAL,
      shift_hours INTEGER NOT NULL,
      time_matches INTEGER NOT NULL,
      source_anomaly TEXT,
      operation_fold TEXT NOT NULL,
      material_fold TEXT NOT NULL,
      size_fold TEXT NOT NULL,
      search_text TEXT NOT NULL,
      PRIMARY KEY (catalog_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS client_haul_leg (
      catalog_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      excel_row INTEGER NOT NULL,
      shoulder_km INTEGER NOT NULL,
      trips_per_shift REAL,
      trips_formula TEXT,
      avg_speed_kmh REAL,
      load_minutes REAL,
      unload_minutes REAL,
      tonnes_per_shift REAL,
      tonnes_formula TEXT,
      cost_per_tonne_km REAL,
      cost_formula TEXT,
      shift_hours INTEGER NOT NULL,
      search_text TEXT NOT NULL,
      PRIMARY KEY (catalog_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS client_site_benchmark (
      catalog_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      site_code TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      unit TEXT,
      fact TEXT,
      need TEXT,
      note TEXT,
      shift_hint TEXT,
      detail_json TEXT NOT NULL,
      work_fold TEXT NOT NULL,
      search_text TEXT NOT NULL,
      PRIMARY KEY (catalog_id, ordinal)
    );
  `);
}

function sourceLine(source: Record<string, unknown>): string {
  const parts = [
    typeof source.sheet === "string" ? `лист «${source.sheet}»` : "",
    typeof source.lastModifiedBy === "string" ? source.lastModifiedBy : "",
    typeof source.modified === "string" ? source.modified : "",
    typeof source.creationDate === "string" ? source.creationDate : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function saveCatalog(
  db: DatabaseSync,
  kind: ClientNormKind,
  id: string,
  title: string,
  shiftHours: number | null,
  counts: Record<string, number>,
  warnings: ClientNormWarning[],
  header: CatalogHeader,
  hash: string,
  insertRows: () => void,
) {
  const now = new Date().toISOString();
  withTx(db, () => {
    db.prepare("DELETE FROM client_norm_catalog WHERE id = ?").run(id);
    db.prepare(`DELETE FROM ${TABLE[kind]} WHERE catalog_id = ?`).run(id);
    insertRows();
    db.prepare(
      `INSERT INTO client_norm_catalog
        (id, kind, title, shift_hours, source_file, content_hash, counts_json, warnings_json, header_json, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      kind,
      title,
      shiftHours,
      FILES[kind],
      hash,
      JSON.stringify(counts),
      JSON.stringify(warnings),
      JSON.stringify(header),
      now,
    );
  });
}

function importOutput(db: DatabaseSync, hash: string) {
  const json = asRecord(readFixture("output"), "выработки");
  const id = String(json.id);
  const sections = asArray(json.sections, "разделы").map((item) => asRecord(item, "раздел"));
  const works = asArray(json.works, "виды работ");
  const rows = asArray(json.rows, "строки норм").map((item) => asRecord(item, "строка нормы"));
  const counts = asRecord(json.counts, "счётчики выработки");
  if (sections.length !== counts.sections) {
    throw new Error(`Разделы: в списке ${sections.length}, в счётчике ${String(counts.sections)}`);
  }
  if (works.length !== counts.works) {
    throw new Error(`Виды работ: в списке ${works.length}, в счётчике ${String(counts.works)}`);
  }
  if (rows.length !== counts.normRows || rows.length !== counts.rowsExported) {
    throw new Error(`Строки норм: ${rows.length}, счётчик ${String(counts.normRows)}`);
  }
  if (json.shiftHours !== 11) throw new Error("Нормы выработки заданы не за смену 11 ч");
  const notes = asArray(json.notes, "примечания выработки").map((item) => String(item));
  const warnings: ClientNormWarning[] = [
    warn(
      "not_official_cost",
      "Справочник выработки за 1 смену 11 часов. В официальную себестоимость и ГПР не записывается.",
    ),
    warn("shift_11h", "Производительность за смену хранится как в исходнике: за час × 11. Пересчёта «за 22 часа» нет."),
    ...notes.map((text) => warn("source_note", text)),
  ];
  const insert = db.prepare(
    `INSERT INTO client_output_norm (
      catalog_id, ordinal, excel_row, section, work_name, unit, soil_name, soil_group, mechanism,
      machine_hours_norm, crew, productivity_per_hour, productivity_per_shift_11h, shift_hours,
      shift_equals_hour_times_11, section_fold, work_fold, mechanism_fold, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  saveCatalog(
    db,
    "output",
    id,
    String(json.title),
    11,
    {
      sections: sections.length,
      works: works.length,
      rows: rows.length,
      shiftHours: 11,
      shiftIdentityMismatches: Number(counts.shiftIdentityMismatches ?? 0),
    },
    warnings,
    {
      sourceLine: sourceLine(asRecord(json.source, "источник выработки")),
      notes,
      sections: sections.map((section) => ({
        name: String(section.name),
        workCount: Number(section.workCount),
        normRowCount: Number(section.normRowCount),
      })),
    },
    hash,
    () => {
      rows.forEach((row, index) => {
        if (row.shiftHours !== 11) {
          throw new Error(`Строка ${String(row.excelRow)}: смена ${String(row.shiftHours)}, ожидалась 11 ч`);
        }
        const section = String(row.section ?? "");
        const workName = String(row.workName ?? "");
        const mechanism = textOrNull(row.mechanism);
        insert.run(
          id,
          index + 1,
          mustNum(row.excelRow, "excelRow"),
          section,
          workName,
          textOrNull(row.unit),
          textOrNull(row.soilName),
          textOrNull(row.soilGroup),
          mechanism,
          numOrNull(row.machineHoursNorm),
          textOrNull(row.crew),
          numOrNull(row.productivityPerHour),
          numOrNull(row.productivityPerShift11h),
          11,
          row.shiftEqualsHourTimes11 === true ? 1 : 0,
          foldNormSearch(section),
          foldNormSearch(workName),
          foldNormSearch(mechanism ?? ""),
          searchBlob([section, workName, row.unit, row.soilName, row.soilGroup, mechanism, row.crew]),
        );
      });
    },
  );
}

interface LaborSourceRow {
  material?: unknown;
  typoSize?: unknown;
  size?: unknown;
  unit?: unknown;
  k?: unknown;
  normPerShift11h?: unknown;
  timeHoursPerUnit?: unknown;
  timeMatches11OverShift?: unknown;
  sourceAnomaly?: unknown;
}

function laborFlat(json: Record<string, unknown>): Array<LaborSourceRow & {
  operationNumber: number;
  operationTitle: string;
  subsection: string | null;
  normOn: string | null;
}> {
  const operations = asArray(json.operations, "операции").map((item) => asRecord(item, "операция"));
  const flat: Array<LaborSourceRow & {
    operationNumber: number;
    operationTitle: string;
    subsection: string | null;
    normOn: string | null;
  }> = [];
  for (const operation of operations) {
    const push = (rows: unknown[], subsection: string | null, normOn: string | null) => {
      for (const row of rows) {
        flat.push({
          ...(asRecord(row, "строка нормы труда") as LaborSourceRow),
          operationNumber: Number(operation.number),
          operationTitle: String(operation.title),
          subsection,
          normOn,
        });
      }
    };
    if (Array.isArray(operation.rows)) push(operation.rows, null, textOrNull(operation.normOn));
    for (const sub of Array.isArray(operation.subsections) ? operation.subsections : []) {
      const block = asRecord(sub, "подоперация");
      push(asArray(block.rows, "строки подоперации"), String(block.title), textOrNull(block.normOn));
    }
  }
  return flat;
}

function importLabor(db: DatabaseSync, hash: string) {
  const json = asRecord(readFixture("labor"), "нормы труда");
  const id = String(json.id);
  const operations = asArray(json.operations, "операции").map((item) => asRecord(item, "операция"));
  const flat = laborFlat(json);
  const counts = asRecord(json.counts, "счётчики норм труда");
  if (operations.length !== counts.operations) {
    throw new Error(`Операции: ${operations.length}, счётчик ${String(counts.operations)}`);
  }
  if (flat.length !== counts.totalNormRows) {
    throw new Error(`Строки норм труда: ${flat.length}, счётчик ${String(counts.totalNormRows)}`);
  }
  if (json.shiftHours !== 11) throw new Error("Нормы труда заданы не за смену 11 ч");
  const notes = asArray(json.notes, "примечания норм труда").map((item) => asRecord(item, "примечание"));
  const anomalies = asArray(json.sourceAnomalies, "аномалии").map((item) => asRecord(item, "аномалия"));
  const note2 = notes.find((note) => note.number === 2);
  const warnings: ClientNormWarning[] = [
    warn(
      "not_official_cost",
      "Нормы труда на изготовление металлоконструкций за смену 11 часов. В себестоимость и ГПР не записываются.",
    ),
    warn("shift_11h", "Смена в таблице — 11 часов. Подсобные часы из оборванного примечания не подставлены."),
  ];
  for (const note of notes) {
    const text = String(note.text ?? "");
    if (note.complete === false) {
      warnings.push(warn(
        "note2_truncated",
        `${text} Продолжения в файле нет. Подсобные часы в таблицу не входят и сюда не добавлены.`,
      ));
    } else {
      warnings.push(warn("source_note", text));
    }
  }
  if (note2 && !String(note2.text ?? "").endsWith("в зависимости")) {
    throw new Error("Примечание 2 должно обрываться на «в зависимости» — продолжение не выдумывается");
  }
  for (const operation of operations) {
    if (typeof operation.explanationNote === "string") {
      warnings.push(warn("explanation_cut", operation.explanationNote));
    }
  }
  for (const anomaly of anomalies) {
    warnings.push(warn("scan_anomaly", String(anomaly.detail ?? "")));
  }
  const insert = db.prepare(
    `INSERT INTO client_labor_norm (
      catalog_id, ordinal, operation_number, operation_title, subsection, norm_on, material,
      size_label, size, unit, k, norm_per_shift_11h, time_hours_per_unit, shift_hours,
      time_matches, source_anomaly, operation_fold, material_fold, size_fold, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  saveCatalog(
    db,
    "labor",
    id,
    String(json.title),
    11,
    { operations: operations.length, rows: flat.length, shiftHours: 11, anomalies: anomalies.length },
    warnings,
    {
      sourceLine: sourceLine(asRecord(json.source, "источник норм труда")),
      notes: notes.map((note) => ({
        number: Number(note.number),
        text: String(note.text ?? ""),
        complete: note.complete === true,
        note: textOrNull(note.note),
      })),
      operations: operations.map((operation) => ({
        number: Number(operation.number),
        title: String(operation.title),
        normOn: textOrNull(operation.normOn),
        rowCount: Number(operation.rowCount),
        explanation: textOrNull(operation.explanation),
        explanationNote: textOrNull(operation.explanationNote),
        explanationNoteStar: textOrNull(operation.explanationNoteStar),
      })),
      anomalies: anomalies.map((anomaly) => ({
        where: textOrNull(anomaly.where),
        size: textOrNull(anomaly.size),
        detail: String(anomaly.detail ?? ""),
        k: numOrNull(anomaly.k),
        normPerShift11h: numOrNull(anomaly.normPerShift11h),
        timeHoursPerUnit: numOrNull(anomaly.timeHoursPerUnit),
      })),
    },
    hash,
    () => {
      flat.forEach((row, index) => {
        const material = textOrNull(row.material);
        const size = textOrNull(row.size);
        insert.run(
          id,
          index + 1,
          row.operationNumber,
          row.operationTitle,
          row.subsection,
          row.normOn,
          material,
          textOrNull(row.typoSize),
          size,
          textOrNull(row.unit),
          numOrNull(row.k),
          numOrNull(row.normPerShift11h),
          numOrNull(row.timeHoursPerUnit),
          11,
          row.timeMatches11OverShift === true ? 1 : 0,
          textOrNull(row.sourceAnomaly),
          foldNormSearch(row.operationTitle),
          foldNormSearch(material ?? ""),
          foldNormSearch(size ?? ""),
          searchBlob([
            row.operationTitle,
            row.subsection,
            row.normOn,
            material,
            row.typoSize,
            size,
            row.unit,
            row.sourceAnomaly,
          ]),
        );
      });
    },
  );
}

function formulaValue(value: unknown, label: string): { formula: string | null; computed: number | null } {
  const record = asRecord(value, label);
  return {
    formula: textOrNull(record.formula),
    computed: numOrNull(record.computed),
  };
}

function importTkm(db: DatabaseSync, hash: string) {
  const json = asRecord(readFixture("tkm"), "т·км");
  const id = String(json.id);
  const calculator = asRecord(json.calculator, "калькулятор");
  const hour = asRecord(calculator.equipmentHourCost, "час техники");
  const payload = asRecord(calculator.payloadTonnes, "груз");
  const hauls = asArray(calculator.hauls, "плечи").map((item) => asRecord(item, "плечо"));
  const counts = asRecord(json.counts, "счётчики т·км");
  const issue = asRecord(json.formulaIssue, "ошибка формулы");
  if (hauls.length !== counts.haulRows) {
    throw new Error(`Плечи: ${hauls.length}, счётчик ${String(counts.haulRows)}`);
  }
  if (hour.hoursPerShift !== 11) throw new Error("Калькулятор т·км задан не за смену 11 ч");
  if (issue.writtenFormula !== "=C5+C5*D5+(C5+D5)*E5") {
    throw new Error("Формула F5 в исходнике изменилась — импорт не подменяет её");
  }
  const total = formulaValue(hour.total, "итог часа");
  const resultTonnes = formulaValue(payload.resultTonnes, "итог тонн");
  const notes = asArray(json.notes, "примечания т·км").map((item) => String(item));
  const warnings: ClientNormWarning[] = [
    warn(
      "not_official_cost",
      "Калькулятор т·км и часа техники за смену 11 часов. В официальную себестоимость и ГПР не записывается.",
    ),
    warn("shift_11h", "Смена калькулятора — 11 часов. Это не общефирменный профиль и не ценник пакета."),
    warn("formula_f5", `Ячейка ${String(issue.cell)}: ${String(issue.writtenFormula)}. ${String(issue.problem)}`),
    warn("file_rates_not_company", String(issue.doNotTreatFileRatesAsCompanyPolicy)),
    ...notes.map((text) => warn("source_note", text)),
  ];
  const insert = db.prepare(
    `INSERT INTO client_haul_leg (
      catalog_id, ordinal, excel_row, shoulder_km, trips_per_shift, trips_formula, avg_speed_kmh,
      load_minutes, unload_minutes, tonnes_per_shift, tonnes_formula, cost_per_tonne_km, cost_formula,
      shift_hours, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  saveCatalog(
    db,
    "tkm",
    id,
    String(json.title),
    11,
    { hauls: hauls.length, shiftHours: 11 },
    warnings,
    {
      sourceLine: sourceLine(asRecord(json.source, "источник т·км")),
      notes,
      payloadTonnes: {
        capacityTonnes: numOrNull(payload.capacityTonnes),
        loadFactor: numOrNull(payload.loadFactor),
        resultTonnes: resultTonnes.computed,
        resultFormula: resultTonnes.formula,
      },
      equipmentHourCost: {
        tariff: numOrNull(hour.tariff),
        overheadRateInFile: numOrNull(hour.overheadRateInFile),
        profitRateInFile: numOrNull(hour.profitRateInFile),
        totalFormula: total.formula,
        totalComputed: total.computed,
        hoursPerShift: 11,
      },
      formulaIssue: {
        cell: String(issue.cell),
        writtenFormula: String(issue.writtenFormula),
        computedInFile: numOrNull(issue.computedInFile),
        problem: String(issue.problem),
        ifProfitOnTariffPlusOverhead: numOrNull(issue.ifProfitOnTariffPlusOverhead),
        doNotTreatFileRatesAsCompanyPolicy: String(issue.doNotTreatFileRatesAsCompanyPolicy),
      },
    },
    hash,
    () => {
      hauls.forEach((haul, index) => {
        const trips = formulaValue(haul.tripsPerShift, "рейсы");
        const tonnes = formulaValue(haul.tonnesPerShift, "тонны");
        const cost = formulaValue(haul.costPerTonneKm, "т·км");
        const shoulder = mustNum(haul.shoulderKm, "плечо");
        insert.run(
          id,
          index + 1,
          mustNum(haul.excelRow, "excelRow"),
          shoulder,
          trips.computed,
          trips.formula,
          numOrNull(haul.avgSpeedKmh),
          numOrNull(haul.loadMinutes),
          numOrNull(haul.unloadMinutes),
          tonnes.computed,
          tonnes.formula,
          cost.computed,
          cost.formula,
          11,
          searchBlob([shoulder, haul.avgSpeedKmh, trips.formula, tonnes.formula, cost.formula]),
        );
      });
    },
  );
}

function cellText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object") {
    const record = value as { computed?: unknown; value?: unknown };
    if (typeof record.computed === "number") return String(record.computed);
    if (typeof record.value === "number") return String(record.value);
    if (typeof record.value === "string") return record.value;
  }
  return null;
}

function monthLine(row: Record<string, unknown>): string {
  const labels: Array<[string, string]> = [
    ["jan", "январь"],
    ["feb", "февраль"],
    ["mar", "март"],
    ["apr", "апрель"],
    ["may", "май"],
  ];
  const parts: string[] = [];
  for (const [key, label] of labels) {
    if (!(key in row)) continue;
    const shown = cellText(row[key]);
    if (shown == null) continue;
    parts.push(`${label}: ${shown}`);
  }
  const plan = cellText(row.planFeb);
  if (plan != null) parts.push(`план февраль: ${plan}`);
  return parts.join(" · ");
}

interface SiteInsert {
  siteCode: string;
  kind: SiteBenchmarkRow["kind"];
  name: string;
  unit: string | null;
  fact: string | null;
  need: string | null;
  note: string | null;
  shiftHint: string | null;
  detail: Record<string, unknown>;
}

function pushSite(rows: SiteInsert[], row: SiteInsert) {
  rows.push(row);
}

function importSites(db: DatabaseSync, hash: string) {
  const json = asRecord(readFixture("sites"), "участки");
  const id = String(json.id);
  const timeStudy = asRecord(json.timeStudy, "фото рабочего дня");
  const siteNeeds = asRecord(json.siteNeeds, "потребность");
  const daily = asRecord(json.dailyNormsAndCrewBenchmarks, "суточные ориентиры");
  const pipeline = asRecord(daily.pipeline, "труба");
  const left = asRecord(daily.project_0_68_resolution, "0-68");
  const right = asRecord(daily.project_88_127_resolution, "88-127");
  const typo = asRecord(timeStudy.typo_118_hours_are_minutes, "C55");
  const counts = asRecord(json.counts, "счётчики участков");
  if (typo.cell !== "C55" || typo.valueInCell !== 118) {
    throw new Error("Пометка C55 должна сохранять значение 118 как в исходнике");
  }
  const notes = asArray(json.notes, "примечания участков").map((item) => String(item));
  const typos = asArray(json.knownSourceTypos, "опечатки").map((item) => asRecord(item, "опечатка"));
  const resolutions = asArray(timeStudy.resolutions, "резолюции").map((item) => asRecord(item, "резолюция"));
  const project68 = asRecord(siteNeeds.project_0_68, "0-68");
  const project88 = asRecord(siteNeeds.project_88_127, "88-127");
  const rows: SiteInsert[] = [];
  const brigades = asRecord(timeStudy.brigades, "бригады");
  for (const brigade of Object.values(brigades)) {
    const block = asRecord(brigade, "бригада");
    for (const member of asArray(block.composition, "состав")) {
      const person = asRecord(member, "состав бригады");
      pushSite(rows, {
        siteCode: "0-68",
        kind: "crew",
        name: String(person.role ?? ""),
        unit: "чел",
        fact: `звено 1: ${String(person.zveno1 ?? "")}; звено 2: ${String(person.zveno2 ?? "")}`,
        need: null,
        note: textOrNull(block.title),
        shiftHint: null,
        detail: { group: "Фото рабочего дня", raw: person },
      });
    }
  }
  const brigade1Rows = asArray(
    asRecord(timeStudy.brigade1_zveno1_operations, "бригада 1").rows,
    "операции бригады 1",
  );
  const brigade2Rows = asArray(
    asRecord(timeStudy.brigade2_zveno1_operations, "бригада 2").rows,
    "операции бригады 2",
  );
  if (brigade1Rows.length !== Number(counts.brigade1OperationRows)) {
    throw new Error(`Хронометраж бригады 1: ${brigade1Rows.length} строк`);
  }
  if (brigade2Rows.length !== Number(counts.brigade2OperationRows)) {
    throw new Error(`Хронометраж бригады 2: ${brigade2Rows.length} строк`);
  }
  const opBlocks: Array<[string, unknown]> = [
    ["Бригада 1, звено 1", timeStudy.brigade1_zveno1_operations],
    ["Бригада 2, звено 1", timeStudy.brigade2_zveno1_operations],
  ];
  for (const [brigade, blockValue] of opBlocks) {
    const block = asRecord(blockValue, brigade);
    for (const item of asArray(block.rows, brigade)) {
      const row = asRecord(item, "операция хронометража");
      const minutes = asRecord(row.deltaMinutes ?? {}, "минуты");
      const minuteText = cellText(minutes);
      pushSite(rows, {
        siteCode: "0-68",
        kind: "operation",
        name: String(row.name ?? ""),
        unit: "шт",
        fact: cellText(row.quantityPcs),
        need: null,
        note: [textOrNull(row.note), minuteText != null ? `∆ ${minuteText} мин` : null].filter(Boolean).join(" · ") || null,
        shiftHint: null,
        detail: { group: brigade, excelRow: row.excelRow, minutes },
      });
    }
  }
  pushSite(rows, {
    siteCode: "0-68",
    kind: "benchmark",
    name: "Смонтировано ОРЧ за сутки",
    unit: "шт/сутки",
    fact: String(daily.orchMountedPerDay_fromTimeStudy),
    need: null,
    note: "Из хронометража, не универсальный ценник",
    shiftHint: null,
    detail: { source: "timeStudy" },
  });
  pushSite(rows, {
    siteCode: "0-68",
    kind: "benchmark",
    name: "Нарощено опор за сутки",
    unit: "шт/сутки",
    fact: String(daily.supportsExtendedPerDay_fromTimeStudy),
    need: null,
    note: "Из хронометража, не универсальный ценник",
    shiftHint: null,
    detail: { source: "timeStudy" },
  });
  pushSite(rows, {
    siteCode: "0-68",
    kind: "benchmark",
    name: "Наращивание 1 ригеля на 1 звено",
    unit: "ч",
    fact: String(daily.extendingOneRigelHoursPerZveno),
    need: null,
    note: "Ячейка C38 делит сумму минут на 60",
    shiftHint: null,
    detail: { cell: "C38" },
  });
  pushSite(rows, {
    siteCode: "0-68",
    kind: "typo",
    name: String(typo.label ?? "C55"),
    unit: "час (подпись исходника)",
    fact: String(typo.valueInCell),
    need: null,
    note: String(typo.explanation ?? ""),
    shiftHint: "118 часов в подписи = 118 минут",
    detail: {
      cell: typo.cell,
      formula: typo.formula,
      valueIfDividedBy60Hours: typo.valueIfDividedBy60Hours,
    },
  });
  pushSite(rows, {
    siteCode: "0-68",
    kind: "benchmark",
    name: "Норма сварки трубы",
    unit: "стык / м",
    fact: `${String(pipeline.oneWelderJointsPerDay)} стыка = ${String(pipeline.oneWelderMetersPerDay)} м`,
    need: `${String(pipeline.fourWeldersJointsPerDay)} стыков = ${String(pipeline.fourWeldersMetersPerDay)} м в день`,
    note: String(pipeline.note ?? ""),
    shiftHint: null,
    detail: { pipeline },
  });
  pushSite(rows, {
    siteCode: "0-68",
    kind: "benchmark",
    name: "ОРЧ по резолюции",
    unit: "шт/сутки",
    fact: String(left.currentOutputOrchPerDay),
    need: String(left.planOrchPerDay),
    note: `План февраля: ${String(left.februaryPlanOrch)}. ${String(left.shiftsMentioned ?? "")}`,
    shiftHint: textOrNull(left.shiftsMentioned),
    detail: { resolution: left },
  });
  pushSite(rows, {
    siteCode: "88-127",
    kind: "benchmark",
    name: "ОРЧ по резолюции",
    unit: "шт/сутки",
    fact: String(right.currentOutputOrchPerDay),
    need: String(right.planOrchPerDay),
    note: `План февраля: ${String(right.februaryPlanOrch)}`,
    shiftHint: "день и ночь в тексте резолюции",
    detail: { resolution: right },
  });
  for (const resolution of resolutions) {
    pushSite(rows, {
      siteCode: String(resolution.project),
      kind: "resolution",
      name: String(resolution.label ?? ""),
      unit: null,
      fact: null,
      need: null,
      note: String(resolution.text ?? ""),
      shiftHint: /ноч/i.test(String(resolution.text ?? "")) ? "в тексте есть ночная смена" : null,
      detail: { verbatim: true },
    });
  }
  const projects: Array<[string, Record<string, unknown>]> = [
    ["0-68", project68],
    ["88-127", project88],
  ];
  for (const [code, project] of projects) {
    for (const item of asArray(project.planRows, `план ${code}`)) {
      const row = asRecord(item, "строка плана");
      pushSite(rows, {
        siteCode: code,
        kind: "plan",
        name: String(row.name ?? ""),
        unit: textOrNull(row.unit),
        fact: null,
        need: null,
        note: [monthLine(row), textOrNull(row.note)].filter(Boolean).join(" · ") || null,
        shiftHint: null,
        detail: { group: "План и факт", raw: row },
      });
    }
    const groups = Object.entries(project).filter(([, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return Array.isArray((value as { rows?: unknown }).rows);
    });
    for (const [groupKey, groupValue] of groups) {
      const group = asRecord(groupValue, groupKey);
      for (const item of asArray(group.rows, groupKey)) {
        const row = asRecord(item, "потребность");
        const role = String(row.role ?? "");
        pushSite(rows, {
          siteCode: code,
          kind: "crew",
          name: role,
          unit: null,
          fact: cellText(row.fact),
          need: cellText(row.need),
          note: textOrNull(row.note) ?? textOrNull(group.title),
          shiftHint: /ноч/i.test(role) ? "день и ночь в подписи исходника" : null,
          detail: { group: textOrNull(group.title) ?? groupKey, raw: row },
        });
      }
    }
  }
  if (Number(counts.projectsOnNeedsSheet) !== 2) {
    throw new Error("На листе потребности ожидались два шифра");
  }
  const warnings: ClientNormWarning[] = [
    warn("not_price_list", notes[0] ?? "Это эталон фактической выработки и составов, не универсальный ценник."),
    warn(
      "c55_minutes",
      `Ячейка C55 подписана «${String(typo.label)}», значение ${String(typo.valueInCell)}. ${String(typo.explanation)}`,
    ),
    warn(
      "day_and_night",
      notes[1] ?? "Дневная и ночная смены в резолюциях не перезаписывают профиль 2×11.",
    ),
    ...typos.map((item) => warn("source_typo", `${String(item.where)}: ${String(item.issue)}`)),
  ];
  const insert = db.prepare(
    `INSERT INTO client_site_benchmark (
      catalog_id, ordinal, site_code, kind, name, unit, fact, need, note, shift_hint,
      detail_json, work_fold, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  saveCatalog(
    db,
    "sites",
    id,
    String(json.title),
    null,
    {
      projects: 2,
      rows: rows.length,
      brigade1OperationRows: Number(counts.brigade1OperationRows),
      brigade2OperationRows: Number(counts.brigade2OperationRows),
      resolutions: resolutions.length,
    },
    warnings,
    {
      sourceLine: sourceLine(asRecord(json.source, "источник участков")),
      notes,
      typos: typos.map((item) => ({ where: String(item.where), issue: String(item.issue) })),
      daily,
      resolutions: resolutions.map((item) => ({
        project: String(item.project),
        label: String(item.label ?? ""),
        text: String(item.text ?? ""),
      })),
      typo118: {
        cell: String(typo.cell),
        label: String(typo.label),
        valueInCell: Number(typo.valueInCell),
        formula: String(typo.formula ?? ""),
        explanation: String(typo.explanation ?? ""),
        valueIfDividedBy60Hours: Number(typo.valueIfDividedBy60Hours),
      },
    },
    hash,
    () => {
      rows.forEach((row, index) => {
        insert.run(
          id,
          index + 1,
          row.siteCode,
          row.kind,
          row.name,
          row.unit,
          row.fact,
          row.need,
          row.note,
          row.shiftHint,
          JSON.stringify(row.detail),
          foldNormSearch(row.name),
          searchBlob([row.siteCode, row.kind, row.name, row.unit, row.fact, row.need, row.note, row.shiftHint]),
        );
      });
    },
  );
}

const IMPORTERS: Record<ClientNormKind, (db: DatabaseSync, hash: string) => void> = {
  output: importOutput,
  labor: importLabor,
  tkm: importTkm,
  sites: importSites,
};

export function clientNormTableCounts(db: DatabaseSync): Record<ClientNormKind, number> {
  ensureClientNormTables(db);
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  return {
    output: count("client_output_norm"),
    labor: count("client_labor_norm"),
    tkm: count("client_haul_leg"),
    sites: count("client_site_benchmark"),
  };
}

export function ensureClientNormCatalogs(
  db: DatabaseSync,
  options?: { force?: boolean },
): ClientNormImportReport {
  ensureClientNormTables(db);
  const hashes = fixtureHashes();
  const imported: string[] = [];
  const unchanged: string[] = [];
  for (const kind of Object.keys(FILES) as ClientNormKind[]) {
    const fileName = FILES[kind];
    const hash = hashes[fileName];
    const existing = db.prepare(
      "SELECT content_hash FROM client_norm_catalog WHERE kind = ?",
    ).get(kind) as { content_hash: string } | undefined;
    if (!options?.force && existing?.content_hash === hash) {
      unchanged.push(kind);
      continue;
    }
    IMPORTERS[kind](db, hash);
    imported.push(kind);
  }
  return { imported, unchanged, counts: clientNormTableCounts(db) };
}

function summaryFromRow(row: {
  id: string;
  kind: string;
  title: string;
  shift_hours: number | null;
  counts_json: string;
  warnings_json: string;
  imported_at: string;
}): ClientNormCatalogSummary {
  return {
    id: row.id,
    kind: row.kind as ClientNormKind,
    title: row.title,
    shiftHours: row.shift_hours,
    counts: JSON.parse(row.counts_json) as Record<string, number>,
    warnings: JSON.parse(row.warnings_json) as ClientNormWarning[],
    participatesInOfficialCost: false,
    importedAt: row.imported_at,
  };
}

export function listClientNormCatalogs(db: DatabaseSync): ClientNormCatalogSummary[] {
  ensureClientNormTables(db);
  const rows = db.prepare(
    `SELECT id, kind, title, shift_hours, counts_json, warnings_json, imported_at
     FROM client_norm_catalog ORDER BY id`,
  ).all() as Array<{
    id: string;
    kind: string;
    title: string;
    shift_hours: number | null;
    counts_json: string;
    warnings_json: string;
    imported_at: string;
  }>;
  return rows.map(summaryFromRow);
}

function andLike(column: string, value: string | undefined, clauses: string[], params: string[]) {
  if (!value?.trim()) return;
  clauses.push(`${column} LIKE ? ESCAPE '\\'`);
  params.push(likePattern(value));
}

function queryTokens(value: string | undefined, clauses: string[], params: string[]) {
  const tokens = foldNormSearch(value ?? "").split(" ").filter(Boolean);
  for (const token of tokens) {
    clauses.push("search_text LIKE ? ESCAPE '\\'");
    params.push(likePattern(token));
  }
}

export function queryClientNormCatalog(db: DatabaseSync, query: ClientNormQuery) {
  ensureClientNormTables(db);
  if (!isClientNormKind(query.catalog)) {
    throw new Error("Неизвестный справочник");
  }
  const catalogRow = db.prepare(
    `SELECT id, kind, title, shift_hours, counts_json, warnings_json, header_json, imported_at
     FROM client_norm_catalog WHERE kind = ?`,
  ).get(query.catalog) as {
    id: string;
    kind: string;
    title: string;
    shift_hours: number | null;
    counts_json: string;
    warnings_json: string;
    header_json: string;
    imported_at: string;
  } | undefined;
  if (!catalogRow) throw new Error("Справочник не импортирован");
  const requestedLimit = query.limit ?? 50;
  const requestedOffset = query.offset ?? 0;
  const limit = Number.isFinite(requestedLimit) ? Math.min(1000, Math.max(1, requestedLimit)) : 50;
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
  const clauses = ["catalog_id = ?"];
  const params: Array<string | number> = [catalogRow.id];
  queryTokens(query.q, clauses, params as string[]);
  if (query.catalog === "output") {
    if (query.section?.trim()) {
      clauses.push("section_fold = ?");
      params.push(foldNormSearch(query.section));
    }
    andLike("work_fold", query.work, clauses, params as string[]);
    andLike("mechanism_fold", query.mechanism, clauses, params as string[]);
  } else if (query.catalog === "labor") {
    if (query.operation != null) {
      clauses.push("operation_number = ?");
      params.push(query.operation);
    }
    andLike("material_fold", query.work, clauses, params as string[]);
    andLike("size_fold", query.size, clauses, params as string[]);
  } else if (query.catalog === "tkm") {
    if (query.shoulder != null) {
      clauses.push("shoulder_km = ?");
      params.push(query.shoulder);
    }
  } else {
    if (query.site?.trim()) {
      clauses.push("site_code = ?");
      params.push(query.site.trim());
    }
    andLike("work_fold", query.work, clauses, params as string[]);
  }
  const where = clauses.join(" AND ");
  const table = TABLE[query.catalog];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as { c: number }).c;
  const rawRows = db.prepare(
    `SELECT * FROM ${table} WHERE ${where} ORDER BY ordinal LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Array<Record<string, unknown>>;
  const facets = facetsFor(db, query.catalog, catalogRow.id);
  return {
    catalog: {
      ...summaryFromRow(catalogRow),
      header: JSON.parse(catalogRow.header_json) as Record<string, unknown>,
    },
    total,
    limit,
    offset,
    facets,
    rows: rawRows.map((row) => mapRow(query.catalog, row)),
    participatesInOfficialCost: false as const,
  };
}

function facetsFor(db: DatabaseSync, kind: ClientNormKind, catalogId: string) {
  if (kind === "output") {
    const sections = db.prepare(
      `SELECT section AS name, COUNT(*) AS count FROM client_output_norm
       WHERE catalog_id = ? GROUP BY section ORDER BY MIN(ordinal)`,
    ).all(catalogId) as Array<{ name: string; count: number }>;
    return { sections };
  }
  if (kind === "labor") {
    const operations = db.prepare(
      `SELECT operation_number AS number, operation_title AS title, COUNT(*) AS count
       FROM client_labor_norm WHERE catalog_id = ? GROUP BY operation_number, operation_title
       ORDER BY operation_number`,
    ).all(catalogId) as Array<{ number: number; title: string; count: number }>;
    return { operations };
  }
  if (kind === "tkm") {
    const shoulders = (db.prepare(
      `SELECT shoulder_km AS km FROM client_haul_leg WHERE catalog_id = ? ORDER BY shoulder_km`,
    ).all(catalogId) as Array<{ km: number }>).map((row) => row.km);
    return { shoulders };
  }
  const sites = db.prepare(
    `SELECT site_code AS code, COUNT(*) AS count FROM client_site_benchmark
     WHERE catalog_id = ? GROUP BY site_code ORDER BY site_code`,
  ).all(catalogId) as Array<{ code: string; count: number }>;
  return { sites };
}

function mapRow(kind: ClientNormKind, row: Record<string, unknown>): OutputNormRow | LaborNormRow | HaulLegRow | SiteBenchmarkRow {
  if (kind === "output") {
    return {
      excelRow: Number(row.excel_row),
      section: String(row.section),
      workName: String(row.work_name),
      unit: textOrNull(row.unit),
      soilName: textOrNull(row.soil_name),
      soilGroup: textOrNull(row.soil_group),
      mechanism: textOrNull(row.mechanism),
      machineHoursNorm: numOrNull(row.machine_hours_norm),
      crew: textOrNull(row.crew),
      productivityPerHour: numOrNull(row.productivity_per_hour),
      productivityPerShift11h: numOrNull(row.productivity_per_shift_11h),
      shiftHours: Number(row.shift_hours),
    };
  }
  if (kind === "labor") {
    return {
      operationNumber: Number(row.operation_number),
      operationTitle: String(row.operation_title),
      subsection: textOrNull(row.subsection),
      normOn: textOrNull(row.norm_on),
      material: textOrNull(row.material),
      sizeLabel: textOrNull(row.size_label),
      size: textOrNull(row.size),
      unit: textOrNull(row.unit),
      k: numOrNull(row.k),
      normPerShift11h: numOrNull(row.norm_per_shift_11h),
      timeHoursPerUnit: numOrNull(row.time_hours_per_unit),
      shiftHours: Number(row.shift_hours),
      timeMatches11OverShift: row.time_matches === 1,
      sourceAnomaly: textOrNull(row.source_anomaly),
    };
  }
  if (kind === "tkm") {
    return {
      excelRow: Number(row.excel_row),
      shoulderKm: Number(row.shoulder_km),
      tripsPerShift: numOrNull(row.trips_per_shift),
      tripsFormula: textOrNull(row.trips_formula),
      avgSpeedKmh: numOrNull(row.avg_speed_kmh),
      loadMinutes: numOrNull(row.load_minutes),
      unloadMinutes: numOrNull(row.unload_minutes),
      tonnesPerShift: numOrNull(row.tonnes_per_shift),
      tonnesFormula: textOrNull(row.tonnes_formula),
      costPerTonneKm: numOrNull(row.cost_per_tonne_km),
      costFormula: textOrNull(row.cost_formula),
      shiftHours: Number(row.shift_hours),
    };
  }
  return {
    siteCode: String(row.site_code),
    kind: String(row.kind) as SiteBenchmarkRow["kind"],
    name: String(row.name),
    unit: textOrNull(row.unit),
    fact: textOrNull(row.fact),
    need: textOrNull(row.need),
    note: textOrNull(row.note),
    shiftHint: textOrNull(row.shift_hint),
    detail: JSON.parse(String(row.detail_json)) as Record<string, unknown>,
  };
}

export function parseClientNormQuery(url: URL): ClientNormQuery | null {
  const catalog = url.searchParams.get("catalog");
  if (!catalog) return null;
  if (!isClientNormKind(catalog)) throw new Error("Неизвестный справочник");
  const operation = url.searchParams.get("operation");
  const shoulder = url.searchParams.get("shoulder");
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");
  return {
    catalog,
    q: url.searchParams.get("q") ?? undefined,
    work: url.searchParams.get("work") ?? undefined,
    mechanism: url.searchParams.get("mechanism") ?? undefined,
    section: url.searchParams.get("section") ?? undefined,
    size: url.searchParams.get("size") ?? undefined,
    operation: operation && Number.isInteger(Number(operation)) ? Number(operation) : undefined,
    shoulder: shoulder && Number.isInteger(Number(shoulder)) ? Number(shoulder) : undefined,
    site: url.searchParams.get("site") ?? undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  };
}
