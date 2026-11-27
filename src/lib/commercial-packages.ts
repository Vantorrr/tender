/**
 * Commercial package duration from client output norms.
 * Days = volume / (output per 11h shift × shifts per day × mechanisms or crews).
 * A TZ window is a deadline, never an equal slice across estimate lines.
 * GESN hours stay a hint and do not become the stage length.
 * File 4 daily norms (ОРЧ, pipe, extension) staff the crew and,
 * when the file states a daily output, set the length. They are not a price.
 * Drilling has no daily rate in file 4. Estimate labor hours (ЗТ) then
 * become days as hours / (11 h × shifts). A TZ window is still not sliced.
 */
import { foldNormSearch } from "@/lib/client-norms";

export const GPR_DURATION_FROM_OUTPUT =
  "Длительность этапов посчитана из выработки за смену 11 часов, числа смен и числа механизмов. Срок ТЗ не делится поровну по строкам сметы.";

export const GPR_GESN_HINT_ONLY =
  "Часы ГЭСН остаются в подсказке и не становятся длительностью ГПР.";

export const GPR_UNCONFIRMED_DURATION =
  "Для части этапов нет однозначной выработки. Их дата не растянута на срок ТЗ.";

export const GPR_CREW_FROM_FILE4 =
  "Комплектация совпавших работ взята из эталона файла 4 (фото рабочего дня и потребность участков) и подписана источником. Это не ставка.";

export const GPR_NORM_HOURS_SOURCE =
  "Нормативные часы сметы (ЗТ), смена 11 ч. Срок ТЗ по строкам сметы не делится.";

export type DurationBasis = "output_shift" | "site_daily" | "unconfirmed";
export type SiteWorkKind = "orch" | "pipe" | "drilling" | "extension";

export interface BenchmarkCrewLine {
  role: string;
  count: number;
  kind: "labor" | "equipment";
}

export interface ShiftOutputCandidate {
  catalog: "output" | "labor";
  workName: string;
  unit: string | null;
  outputPerShift11h: number;
  mechanism: string | null;
  soilName: string | null;
  material: string | null;
  size: string | null;
  source: string;
}

export interface CommercialStagePlan {
  durationBasis: DurationBasis;
  durationDays: number | null;
  formulaVolume: number | null;
  outputPerShift11h: number | null;
  dailyOutput: number | null;
  statedLinks: number | null;
  statedShifts: number | null;
  mechanismCount: number | null;
  durationShifts: number | null;
  benchmarkSource: string | null;
  benchmarkCrew: BenchmarkCrewLine[];
  gesnHoursHint: number | null;
  note: string | null;
}

const FILE4 = "04 фото рабочего дня и потребность участков";

const ORCH_CREW_068: BenchmarkCrewLine[] = [
  { role: "Сварщики", count: 2, kind: "labor" },
  { role: "Монтажники", count: 12, kind: "labor" },
  { role: "Подсобные рабочие", count: 2, kind: "labor" },
  { role: "Дизельные подстанции", count: 1, kind: "equipment" },
];

const ORCH_CREW_88127: BenchmarkCrewLine[] = [
  { role: "Сварщики", count: 1, kind: "labor" },
  { role: "Монтажники", count: 5, kind: "labor" },
  { role: "Подсобные рабочие", count: 5, kind: "labor" },
  { role: "Водитель вахтовки", count: 2, kind: "labor" },
  { role: "Машинист экскаватора", count: 2, kind: "labor" },
  { role: "Вахтовка", count: 1, kind: "equipment" },
  { role: "Экскаватор", count: 1, kind: "equipment" },
];

const PIPE_CREW: BenchmarkCrewLine[] = [
  { role: "Сварщики", count: 4, kind: "labor" },
  { role: "Монтажники", count: 10, kind: "labor" },
  { role: "Подсобные рабочие", count: 2, kind: "labor" },
  { role: "Дизельные подстанции", count: 2, kind: "equipment" },
  { role: "Машинист КМУ", count: 1, kind: "labor" },
  { role: "Машинист трубоукладчика", count: 3, kind: "labor" },
  { role: "Дизелист", count: 1, kind: "labor" },
  { role: "Трубоукладчик", count: 1, kind: "equipment" },
  { role: "Бензовоз", count: 1, kind: "equipment" },
];

const DRILLING_CREW: BenchmarkCrewLine[] = [
  { role: "Машинист экскаватора", count: 2, kind: "labor" },
  { role: "Водитель вахтовки", count: 2, kind: "labor" },
  { role: "Экскаватор", count: 1, kind: "equipment" },
  { role: "Вахтовка", count: 1, kind: "equipment" },
];

export function durationDaysFromOutput(input: {
  volume: number;
  outputPerShift11h: number;
  shiftsPerDay: number;
  mechanisms: number;
}): number | null {
  const { volume, outputPerShift11h, shiftsPerDay, mechanisms } = input;
  if (![volume, outputPerShift11h, shiftsPerDay, mechanisms].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  return volume / (outputPerShift11h * shiftsPerDay * mechanisms);
}

export function matchSiteWorkKind(name: string): SiteWorkKind | null {
  const text = foldNormSearch(name);
  if (/бурен/u.test(text)) return "drilling";
  if (/трубопровод|монтаж трубы|сварк\p{L}*\s+труб|стык\p{L}*\s+труб/u.test(text)) return "pipe";
  if (/наращ/u.test(text)) return "extension";
  if (/орч|опорн\p{L}*\s+рам|монтаж опор/u.test(text)) return "orch";
  return null;
}

function siteHint(name: string): "0-68" | "88-127" | null {
  if (/88\s*[-–]\s*127/u.test(name)) return "88-127";
  if (/0\s*[-–]\s*68/u.test(name)) return "0-68";
  return null;
}

function foldUnit(unit: string): string {
  return foldNormSearch(unit)
    .replace(/м³/gu, "м3")
    .replace(/м²/gu, "м2")
    .replace(/[\s.]/gu, "");
}

/** Scale a physical volume into the norm's unit. Null means the units do not match. */
export function volumeInNormUnits(volume: number, workUnit: string | null, normUnit: string | null): number | null {
  if (!Number.isFinite(volume) || volume <= 0) return null;
  if (!workUnit || !normUnit) return volume;
  const left = foldUnit(workUnit);
  const right = foldUnit(normUnit);
  if (!left || !right) return volume;
  if (left === right) return volume;
  const pairs: Array<[string, string, number]> = [
    ["м3", "1000м3", 1 / 1000],
    ["1000м3", "м3", 1000],
    ["шт", "100шт", 1 / 100],
    ["100шт", "шт", 100],
    ["м", "км", 1 / 1000],
    ["км", "м", 1000],
    ["га", "1га", 1],
    ["1га", "га", 1],
  ];
  const hit = pairs.find(([from, to]) => from === left && to === right);
  return hit ? volume * hit[2] : null;
}

function namesOverlap(query: string, work: string): boolean {
  const left = foldNormSearch(query);
  const right = foldNormSearch(work).replace(/\s*\([^)]*\)\s*/gu, " ").replace(/\s+/g, " ").trim();
  if (right.length < 6 || left.length < 6) return false;
  return left.includes(right) || right.includes(left);
}

function narrowByField(
  rows: ShiftOutputCandidate[],
  query: string,
  field: "mechanism" | "soilName" | "material" | "size",
): ShiftOutputCandidate[] {
  const foldedQuery = foldNormSearch(query);
  const hits = rows.filter((row) => {
    const value = row[field];
    if (!value) return false;
    const folded = foldNormSearch(value);
    return folded.length >= 4 && foldedQuery.includes(folded);
  });
  if (!hits.length) return rows;
  const longest = hits.reduce((best, row) => (
    foldNormSearch(row[field] ?? "").length > foldNormSearch(best[field] ?? "").length ? row : best
  ));
  const bestLength = foldNormSearch(longest[field] ?? "").length;
  return hits.filter((row) => foldNormSearch(row[field] ?? "").length === bestLength);
}

export function pickShiftOutput(
  workName: string,
  unit: string | null,
  rows: ShiftOutputCandidate[],
): { status: "unique"; row: ShiftOutputCandidate; volume: number } | { status: "ambiguous" } | { status: "none" } {
  const named = rows.filter((row) => namesOverlap(workName, row.workName));
  if (!named.length) return { status: "none" };
  const compatible = named.flatMap((row) => {
    const volume = volumeInNormUnits(1, unit, row.unit);
    return volume == null ? [] : [row];
  });
  if (!compatible.length) return { status: "none" };
  let pool = narrowByField(compatible, workName, "mechanism");
  pool = narrowByField(pool, workName, "soilName");
  pool = narrowByField(pool, workName, "material");
  pool = narrowByField(pool, workName, "size");
  const first = pool[0]?.outputPerShift11h;
  if (first == null || !pool.every((row) => Math.abs(row.outputPerShift11h - first) < 1e-6)) {
    return { status: "ambiguous" };
  }
  const volume = volumeInNormUnits(1, unit, pool[0].unit);
  if (volume == null) return { status: "none" };
  const soils = new Set(pool.map((row) => row.soilName).filter(Boolean));
  const source = soils.size > 1
    ? `${pool[0].source}, выработка совпала по группам грунта`
    : pool[0].source;
  return { status: "unique", row: { ...pool[0], source }, volume };
}

function orchCrew(name: string): BenchmarkCrewLine[] {
  return siteHint(name) === "88-127" ? ORCH_CREW_88127 : ORCH_CREW_068;
}

function emptyPlan(gesnHoursHint: number | null, note: string | null, crew: BenchmarkCrewLine[] = [], source: string | null = null): CommercialStagePlan {
  return {
    durationBasis: "unconfirmed",
    durationDays: null,
    formulaVolume: null,
    outputPerShift11h: null,
    dailyOutput: null,
    statedLinks: null,
    statedShifts: null,
    mechanismCount: null,
    durationShifts: null,
    benchmarkSource: source,
    benchmarkCrew: crew,
    gesnHoursHint,
    note,
  };
}

function heuristicDaily(name: string, unit: string | null): { perDay: number; normUnit: string } | null {
  const text = foldNormSearch(name);
  const foldedUnit = foldUnit(unit ?? "");
  const area = foldedUnit.includes("м2");
  const rules: Array<{ test: RegExp; perDay: number; normUnit: string }> = [
    { test: /бурен|скважин/u, perDay: 24, normUnit: "м" },
    { test: /землян|транше|котлован|разработк\p{L}*\s+грунт/u, perDay: 180, normUnit: "м3" },
    { test: /щебен|песок|песчан|геомат|геореш/u, perDay: area ? 300 : 120, normUnit: area ? "м2" : "м3" },
    { test: /фундамент/u, perDay: 8, normUnit: "м3" },
    { test: /кабел/u, perDay: 60, normUnit: "м" },
    { test: /заземл/u, perDay: 6, normUnit: "шт" },
  ];
  return rules.find((rule) => rule.test.test(text)) ?? null;
}

function heuristicCrew(name: string): BenchmarkCrewLine[] {
  const text = foldNormSearch(name);
  if (/бурен|скважин/u.test(text)) return DRILLING_CREW;
  if (/землян|транше|котлован|щебен|песок|геомат/u.test(text)) {
    return [
      { role: "Машинист экскаватора", count: 2, kind: "labor" },
      { role: "Экскаватор", count: 1, kind: "equipment" },
    ];
  }
  if (/кабел|заземл/u.test(text)) return [{ role: "Электромонтажники", count: 4, kind: "labor" }];
  if (/фундамент/u.test(text)) return [{ role: "Монтажники", count: 4, kind: "labor" }, { role: "Экскаватор", count: 1, kind: "equipment" }];
  return [];
}

/** Orientation for a common construction line when the estimate has volume but no ЗТ and no catalog row. */
function planFromWorkHeuristic(input: {
  workName: string;
  unit: string | null;
  volume: number | null;
  shifts: number;
  gesnHoursHint: number | null;
}): CommercialStagePlan | null {
  const rule = heuristicDaily(input.workName, input.unit);
  if (!rule || input.volume == null) return null;
  const scaled = volumeInNormUnits(input.volume, input.unit, rule.normUnit);
  if (scaled == null) return null;
  const durationDays = scaled / rule.perDay;
  if (!(durationDays >= 1)) return null;
  const shifts = input.shifts > 0 ? input.shifts : 1;
  return {
    durationBasis: "output_shift",
    durationDays,
    formulaVolume: scaled,
    outputPerShift11h: rule.perDay / shifts,
    dailyOutput: rule.perDay,
    statedLinks: 1,
    statedShifts: 1,
    mechanismCount: 1,
    durationShifts: shifts,
    benchmarkSource: `Ориентир типовой работы: ${rule.perDay} ${rule.normUnit}/день при смене 11 ч × ${shifts}. Это не цена и не нарезка срока ТЗ.`,
    benchmarkCrew: heuristicCrew(input.workName),
    gesnHoursHint: input.gesnHoursHint,
    note: "Суточный ориентир уже включает число смен и повторно на календарь не умножается.",
  };
}

function planFromNormHours(input: {
  hours: number | null | undefined;
  hoursPerShift: number;
  shifts: number;
  gesnHoursHint: number | null;
  crew: BenchmarkCrewLine[];
}): CommercialStagePlan | null {
  const hours = input.hours ?? 0;
  const shiftHours = input.hoursPerShift;
  const shifts = input.shifts;
  if (!(hours > 0) || !(shiftHours > 0) || !(shifts > 0)) return null;
  const raw = hours / (shiftHours * shifts);
  if (!(raw > 0) || !Number.isFinite(raw)) return null;
  const durationDays = raw < 1 ? 1 : raw;
  return {
    durationBasis: "output_shift",
    durationDays,
    formulaVolume: hours,
    outputPerShift11h: shiftHours,
    dailyOutput: null,
    statedLinks: 1,
    statedShifts: 1,
    mechanismCount: 1,
    durationShifts: shifts,
    benchmarkSource: GPR_NORM_HOURS_SOURCE,
    benchmarkCrew: input.crew,
    gesnHoursHint: input.gesnHoursHint,
    note: raw < 1
      ? "Нормативных часов меньше одной смены на звено. Этап поставлен на 1 день. Срок ТЗ по строкам сметы не делится."
      : "Длительность = нормативные часы сметы / (часы смены × число смен). Срок ТЗ по строкам сметы не делится.",
  };
}

export function planCommercialStage(input: {
  workName: string;
  unit: string | null;
  volume: number | null;
  shiftsPerDay: number;
  hoursPerShift?: number;
  /** Worker or machine hours from the estimate. Not the GESN hint. */
  normHours?: number | null;
  lookups: ShiftOutputCandidate[];
  gesnHoursHint: number | null;
}): CommercialStagePlan {
  const shifts = Number.isFinite(input.shiftsPerDay) && input.shiftsPerDay > 0 ? input.shiftsPerDay : 1;
  const hoursPerShift = Number.isFinite(input.hoursPerShift) && (input.hoursPerShift ?? 0) > 0 ? input.hoursPerShift! : 11;
  const kind = matchSiteWorkKind(input.workName);
  const site = kind ? sitePlan(kind, input.workName, input.unit, input.volume, input.gesnHoursHint) : null;
  if (site && (site.durationDays ?? 0) > 0) return site;
  const picked = pickShiftOutput(input.workName, input.unit, input.lookups);
  if (picked.status === "unique" && input.volume != null && input.volume > 0) {
    const formulaVolume = input.volume * picked.volume;
    const durationDays = durationDaysFromOutput({
      volume: formulaVolume,
      outputPerShift11h: picked.row.outputPerShift11h,
      shiftsPerDay: shifts,
      mechanisms: 1,
    });
    if ((durationDays ?? 0) > 0) return {
      durationBasis: "output_shift",
      durationDays,
      formulaVolume,
      outputPerShift11h: picked.row.outputPerShift11h,
      dailyOutput: null,
      statedLinks: 1,
      statedShifts: 1,
      mechanismCount: 1,
      durationShifts: shifts,
      benchmarkSource: picked.row.source,
      benchmarkCrew: [],
      gesnHoursHint: input.gesnHoursHint,
      note: null,
    };
  }
  const fromHours = planFromNormHours({
    hours: input.normHours,
    hoursPerShift,
    shifts,
    gesnHoursHint: input.gesnHoursHint,
    crew: site?.benchmarkCrew ?? [],
  });
  if (fromHours) return fromHours;
  const heuristic = planFromWorkHeuristic({
    workName: input.workName,
    unit: input.unit,
    volume: input.volume,
    shifts,
    gesnHoursHint: input.gesnHoursHint,
  });
  if (heuristic) return heuristic;
  if (picked.status === "ambiguous") {
    return emptyPlan(input.gesnHoursHint, "Несколько норм выработки, механизм или группа грунта не выбраны. Длительность не назначена.");
  }
  if (site) return site;
  return emptyPlan(
    input.gesnHoursHint,
    input.gesnHoursHint != null
      ? "Часы сметы сохранены как подсказка. Длительность по ним не считается."
      : null,
  );
}

function sitePlan(
  kind: SiteWorkKind,
  workName: string,
  unit: string | null,
  volume: number | null,
  gesnHoursHint: number | null,
): CommercialStagePlan | null {
  if (kind === "drilling") {
    return emptyPlan(
      gesnHoursHint,
      "Суточной нормы бурения в файле 4 нет. Длительность не назначена.",
      DRILLING_CREW,
      `${FILE4}, шифр 88-127: бурение. Состав техники с листа потребности, отдельной суточной нормы нет.`,
    );
  }
  if (kind === "pipe") {
    const scaled = volumeInNormUnits(volume ?? 0, unit, "м");
    const source = `${FILE4}, шифр 0-68: 1 сварщик делает 3 стыка = 30 м, 4 сварщика 12 стыков = 120 м в день`;
    if (scaled == null || volume == null) {
      return emptyPlan(gesnHoursHint, "Норма трубы задана в метрах. Единица работы не совпала, длительность не назначена.", PIPE_CREW, source);
    }
    return {
      durationBasis: "site_daily",
      durationDays: scaled / 120,
      formulaVolume: scaled,
      outputPerShift11h: null,
      dailyOutput: 120,
      statedLinks: 4,
      statedShifts: 1,
      mechanismCount: 4,
      durationShifts: 1,
      benchmarkSource: source,
      benchmarkCrew: PIPE_CREW,
      gesnHoursHint,
      note: "120 м в день уже суточная норма четырёх сварщиков и на число смен повторно не умножается.",
    };
  }
  const crew = orchCrew(workName);
  const site = siteHint(workName) === "88-127" ? "88-127" : "0-68";
  const daily = kind === "orch" ? 4 : 4;
  const label = kind === "orch"
    ? `${FILE4}, шифр ${site}: фото рабочего дня, 4 смонтированных ОРЧ за день`
    : `${FILE4}: 4 нарощенных опоры за день. Состав — потребность шифра ${site}.`;
  const scaled = volumeInNormUnits(volume ?? 0, unit, "шт");
  if (scaled == null || volume == null) {
    return emptyPlan(gesnHoursHint, "Суточная норма задана в штуках. Единица работы не совпала, длительность не назначена.", crew, label);
  }
  return {
    durationBasis: "site_daily",
    durationDays: scaled / daily,
    formulaVolume: scaled,
    outputPerShift11h: null,
    dailyOutput: daily,
    statedLinks: 1,
    statedShifts: 1,
    mechanismCount: 1,
    durationShifts: 1,
    benchmarkSource: label,
    benchmarkCrew: crew,
    gesnHoursHint,
    note: "Суточная норма файла 4 не умножается повторно на смены календаря.",
  };
}

function floorNormHourDay(days: number | null, benchmarkSource?: string | null): number | null {
  if (days == null || !(days > 0) || days >= 1) return days;
  return (benchmarkSource ?? "").startsWith("Нормативные часы сметы") ? 1 : days;
}

export function durationFromStored(stage: {
  durationBasis?: DurationBasis | null;
  formulaVolume?: number | null;
  outputPerShift11h?: number | null;
  dailyOutput?: number | null;
  statedLinks?: number | null;
  statedShifts?: number | null;
  mechanismCount?: number | null;
  durationShifts?: number | null;
  benchmarkSource?: string | null;
}): number | null {
  const volume = stage.formulaVolume;
  if (volume == null || !(volume > 0)) return null;
  if (stage.durationBasis === "output_shift") {
    return floorNormHourDay(durationDaysFromOutput({
      volume,
      outputPerShift11h: stage.outputPerShift11h ?? 0,
      shiftsPerDay: stage.durationShifts ?? 0,
      mechanisms: stage.mechanismCount ?? 0,
    }), stage.benchmarkSource);
  }
  if (stage.durationBasis === "site_daily") {
    const daily = stage.dailyOutput ?? 0;
    const statedLinks = stage.statedLinks ?? 0;
    const statedShifts = stage.statedShifts ?? 0;
    const links = stage.mechanismCount ?? 0;
    const shifts = stage.durationShifts ?? 0;
    if (![daily, statedLinks, statedShifts, links, shifts].every((value) => value > 0)) return null;
    const scale = (links / statedLinks) * (shifts / statedShifts);
    if (!(scale > 0)) return null;
    return volume / (daily * scale);
  }
  return null;
}

export type AccelerationLever = "shift" | "mechanism";

export function applyLeverToStored<T extends {
  durationBasis?: DurationBasis | null;
  durationDays?: number | null;
  formulaVolume?: number | null;
  outputPerShift11h?: number | null;
  dailyOutput?: number | null;
  statedLinks?: number | null;
  statedShifts?: number | null;
  mechanismCount?: number | null;
  durationShifts?: number | null;
}>(stage: T, lever: AccelerationLever): T {
  if (stage.durationBasis !== "output_shift" && stage.durationBasis !== "site_daily") return stage;
  const next = { ...stage };
  if (lever === "shift") {
    if ((next.durationShifts ?? 1) >= 2) return stage;
    next.durationShifts = 2;
  } else {
    next.mechanismCount = (next.mechanismCount ?? next.statedLinks ?? 1) + 1;
  }
  next.durationDays = durationFromStored(next);
  return next;
}

const HOUR_UNIT = /(?:маш|чел|н)\s*[.\u00b7\-]*\s*ч/iu;

export function gesnHoursHint(resources: Array<{ quantity: number; unit: string; quantityBasis?: string | null }>): number | null {
  let sum = 0;
  let any = false;
  for (const resource of resources) {
    if (resource.quantityBasis !== "total_hours") continue;
    if (!HOUR_UNIT.test(resource.unit)) continue;
    if (!Number.isFinite(resource.quantity)) continue;
    sum += Math.abs(resource.quantity);
    any = true;
  }
  if (!any) return null;
  return Math.round(sum * 1000) / 1000;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A stage longer than this is rejected. The date itself is not walked day by day. */
export const MAX_SCHEDULE_DAYS = 20_000;

/** Physical VOR quantity above this is a validation error, not a schedule. */
export const MAX_VOR_VOLUME = 1e12;

function weekday(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function uniqueWeekdays(weekendDays: number[]): number[] {
  return [...new Set(weekendDays.filter((day) => day >= 0 && day <= 6))];
}

function alignToWorkday(iso: string, weekendDays: number[]): string {
  const weekend = uniqueWeekdays(weekendDays);
  if (weekend.length >= 7) throw new Error("Календарь не содержит рабочих дней");
  let cursor = iso;
  for (let step = 0; step < 7; step += 1) {
    if (!weekend.includes(weekday(cursor))) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new Error("Календарь не содержит рабочих дней");
}

/**
 * Inclusive working-day end in constant time.
 * No weekends: start plus ceil(days) − 1.
 * Saturday and Sunday off: full weeks of 7 calendar days plus a remainder of 0–4,
 * with the remainder pushed past the weekend when it would land there.
 */
export function endAfterWorkingDays(start: string, days: number, weekendDays: number[]): string {
  const need = Math.max(1, Math.ceil(days - 1e-9));
  if (!Number.isFinite(need) || need > MAX_SCHEDULE_DAYS) {
    throw new Error("Срок этапа слишком большой. Уменьшите объём или добавьте выработку.");
  }
  const aligned = alignToWorkday(start, weekendDays);
  const weekend = uniqueWeekdays(weekendDays);
  const extra = need - 1;
  if (weekend.length === 0) return addDays(aligned, extra);
  const workdaysPerWeek = 7 - weekend.length;
  if (workdaysPerWeek <= 0) throw new Error("Календарь не содержит рабочих дней");
  const weeks = Math.floor(extra / workdaysPerWeek);
  let remainder = extra % workdaysPerWeek;
  if (weekend.length === 2 && weekend.includes(0) && weekend.includes(6)) {
    const startDow = weekday(aligned);
    if (startDow + remainder > 5) remainder += 2;
    return addDays(aligned, weeks * 7 + remainder);
  }
  let cursor = addDays(aligned, weeks * 7);
  let left = remainder;
  for (let step = 0; left > 0 && step < 14; step += 1) {
    cursor = addDays(cursor, 1);
    if (!weekend.includes(weekday(cursor))) left -= 1;
  }
  if (left > 0) throw new Error("Календарь не содержит рабочих дней");
  return cursor;
}

/**
 * Confirmed durations chain on working days.
 * A stage without a duration stays on the current day and does not consume the deadline.
 */
export function placeByDuration(
  anchor: string,
  weekendDays: number[],
  durations: Array<number | null>,
): Array<{ start: string; end: string }> {
  let cursor = alignToWorkday(anchor, weekendDays);
  return durations.map((duration) => {
    if (duration == null || !(duration > 0)) {
      const day = alignToWorkday(cursor, weekendDays);
      return { start: day, end: day };
    }
    const start = alignToWorkday(cursor, weekendDays);
    const end = endAfterWorkingDays(start, duration, weekendDays);
    cursor = addDays(end, 1);
    return { start, end };
  });
}

const PHASE_RULES: Array<{ phase: number; test: RegExp }> = [
  { phase: 0, test: /подготов|геодез|мобилиз|разбивк/iu },
  { phase: 4, test: /заземл/iu },
  { phase: 3, test: /кабел|лоток|трубопровод/iu },
  { phase: 2, test: /щебен|песок|песч|геомат|геореш|основан|подушк|подсып/iu },
  { phase: 3, test: /фундамент|свай/iu },
  { phase: 1, test: /(?<![а-яё])земл|транше|котлован|(?<![а-яё])бурен|скважин/iu },
  { phase: 4, test: /(?<![а-яё])электро|обвяз|(?<![а-яё])монтаж/iu },
  { phase: 5, test: /испытан|благоустр|сдача|покраск/iu },
];

/** Technological phase. A more specific word wins, so «кабель в траншее» stays a cable route. */
export function constructionPhase(name: string, section = ""): number {
  const text = `${section} ${name}`;
  return PHASE_RULES.find((rule) => rule.test.test(text))?.phase ?? 3;
}

/**
 * Stages of one phase start together. The next phase starts the day after
 * the longest predecessor. A stage without duration does not push the phase.
 */
export function placeStagePhases(
  anchor: string,
  weekendDays: number[],
  rows: Array<{ phase: number; durationDays: number | null }>,
): Array<{ start: string; end: string; dependsOn: number | null }> {
  const aligned = placeByDuration(anchor, weekendDays, [null])[0]?.start ?? anchor;
  const order = [...new Set(rows.map((row) => row.phase))].sort((left, right) => left - right);
  const spots: Array<{ start: string; end: string; dependsOn: number | null }> = rows.map(() => ({
    start: aligned,
    end: aligned,
    dependsOn: null,
  }));
  let cursor = aligned;
  let previousIndex: number | null = null;
  for (const phase of order) {
    const indexes = rows.flatMap((row, index) => row.phase === phase ? [index] : []);
    let phaseEnd = cursor;
    let moved = false;
    for (const index of indexes) {
      const duration = rows[index]?.durationDays ?? null;
      if (duration != null && duration > 0) {
        const end = endAfterWorkingDays(cursor, duration, weekendDays);
        spots[index] = { start: cursor, end, dependsOn: previousIndex };
        if (end > phaseEnd) phaseEnd = end;
        moved = true;
      } else {
        spots[index] = { start: cursor, end: cursor, dependsOn: previousIndex };
      }
    }
    if (moved) cursor = alignToWorkday(addDays(phaseEnd, 1), weekendDays);
    if (indexes.length) previousIndex = indexes[0] ?? previousIndex;
  }
  return spots;
}

export function inclusiveCalendarDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 1;
  return Math.round((to - from) / 86400000) + 1;
}

export interface DeadlineView {
  applicable: boolean;
  incomplete: boolean;
  pathDays: number | null;
  deadlineDays: number | null;
  overrunDays: number | null;
  shiftAvailable: boolean;
  mechanismAvailable: boolean;
  message: string;
}

/**
 * Shifts that the deadline lever should trust.
 * A stage that already stored durationShifts wins over a missing calendar.
 * A missing calendar is 2, the same default a new package is planned with.
 */
export function shiftsForDeadline(
  stages: Array<{ durationShifts?: number | null }>,
  calendarShifts?: number | null,
): number {
  const planned = stages
    .map((stage) => stage.durationShifts)
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  if (planned.length) return Math.min(...planned);
  if (calendarShifts != null && Number.isFinite(calendarShifts) && calendarShifts > 0) return calendarShifts;
  return 2;
}

export function deadlineView(input: {
  stages: Array<{
    start: string;
    end: string;
    durationBasis?: DurationBasis | null;
    durationDays?: number | null;
    durationShifts?: number | null;
  }>;
  deadline: { start: string; end: string } | null;
  shiftsPerDay?: number | null;
}): DeadlineView {
  const tagged = input.stages.some((stage) => stage.durationBasis != null);
  if (!tagged) {
    return {
      applicable: false,
      incomplete: false,
      pathDays: null,
      deadlineDays: null,
      overrunDays: null,
      shiftAvailable: false,
      mechanismAvailable: false,
      message: "",
    };
  }
  const known = input.stages.filter((stage) => (stage.durationDays ?? 0) > 0 && stage.start && stage.end);
  const incomplete = input.stages.some((stage) => stage.durationBasis === "unconfirmed" || (stage.durationBasis != null && !(stage.durationDays && stage.durationDays > 0)));
  const deadlineDays = input.deadline ? inclusiveCalendarDays(input.deadline.start, input.deadline.end) : null;
  if (!known.length) {
    return {
      applicable: true,
      incomplete: true,
      pathDays: null,
      deadlineDays,
      overrunDays: null,
      shiftAvailable: false,
      mechanismAvailable: false,
      message: deadlineDays != null
        ? "Срок ТЗ есть, но ни один этап не получил длительность по выработке. Срок по строкам сметы не нарезан."
        : "Длительность по выработке не назначена, и срок ТЗ в документах не найден.",
    };
  }
  const start = known.map((stage) => stage.start).sort()[0];
  const end = known.map((stage) => stage.end).sort().at(-1) ?? start;
  const pathDays = inclusiveCalendarDays(start, end);
  const overrunDays = deadlineDays == null ? null : Math.max(0, pathDays - deadlineDays);
  const exceeds = overrunDays != null && overrunDays > 0;
  const shiftAvailable = exceeds && shiftsForDeadline(input.stages, input.shiftsPerDay) < 2;
  const mechanismAvailable = exceeds;
  let message: string;
  if (deadlineDays == null) {
    message = `Критический путь по выработке — ${pathDays} сут. Срок ТЗ в документах не найден, сравнение не делается.`;
  } else if (exceeds) {
    message = `Критический путь ${pathDays} сут. при сроке ТЗ ${deadlineDays} сут. Превышение ${overrunDays} сут.`;
  } else if (incomplete) {
    message = `Известная часть пути — ${pathDays} сут. при сроке ТЗ ${deadlineDays} сут. Сравнение неполное: есть этапы без выработки.`;
  } else {
    message = `Критический путь ${pathDays} сут. укладывается в срок ТЗ ${deadlineDays} сут.`;
  }
  return {
    applicable: true,
    incomplete,
    pathDays,
    deadlineDays,
    overrunDays,
    shiftAvailable,
    mechanismAvailable,
    message,
  };
}

export function volumeStatusLabel(status: "unconfirmed" | "confirmed" | undefined): string {
  return status === "confirmed" ? "подтверждено" : "не подтверждено";
}

export function scaleFormulaVolume(previous: number | null | undefined, previousQty: number, nextQty: number): number | null {
  if (!(nextQty > 0)) return 0;
  if (previous == null || !(previousQty > 0)) return previous ?? null;
  return previous * (nextQty / previousQty);
}

/** A stage belongs to this VOR row, not to a same-named work in another section. */
export function stageTracksVolumeRow(
  stage: {
    volumeRowIds?: string[] | null;
    volumeSource?: "vor" | "estimate" | null;
    sectionName?: string | null;
    workName?: string | null;
    name: string;
  },
  position: { id: string; name: string; sourceSectionName?: string | null },
): boolean {
  if (stage.volumeSource === "estimate") return false;
  if (stage.volumeRowIds?.length) return stage.volumeRowIds.includes(position.id);
  if (foldNormSearch(stage.workName ?? stage.name) !== foldNormSearch(position.name)) return false;
  const stageSection = foldNormSearch(stage.sectionName ?? "");
  const rowSection = foldNormSearch(position.sourceSectionName ?? "");
  if (stageSection || rowSection) return stageSection === rowSection;
  return true;
}

/**
 * New formula volume for one physical quantity.
 * Zero clears the length and keeps the per-unit factor.
 * A later positive quantity rebuilds the numerator from that factor.
 */
export function formulaAfterVolumeChange(
  stage: {
    durationBasis?: DurationBasis | null;
    formulaVolume?: number | null;
    planVolume?: number | null;
    formulaPerPhysical?: number | null;
    outputPerShift11h?: number | null;
    dailyOutput?: number | null;
    statedLinks?: number | null;
    statedShifts?: number | null;
    mechanismCount?: number | null;
    durationShifts?: number | null;
    benchmarkSource?: string | null;
  },
  nextPhysical: number,
): { formulaVolume: number; durationDays: number | null; formulaPerPhysical: number | null; planVolume: number } {
  const stored = stage.formulaPerPhysical;
  const derived = stage.planVolume != null && stage.planVolume > 0 && stage.formulaVolume != null
    ? stage.formulaVolume / stage.planVolume
    : null;
  const per = stored != null && stored > 0 ? stored : derived;
  if (!(nextPhysical > 0)) {
    return { formulaVolume: 0, durationDays: 0, formulaPerPhysical: per, planVolume: 0 };
  }
  const formulaVolume = per != null ? nextPhysical * per : nextPhysical;
  return {
    formulaVolume,
    durationDays: durationFromStored({ ...stage, formulaVolume }),
    formulaPerPhysical: per,
    planVolume: nextPhysical,
  };
}
