/**
 * Commercial package duration from client output norms.
 * Days = volume / (output per 11h shift × shifts per day × mechanisms or crews).
 * A TZ window is a deadline, never an equal slice across estimate lines.
 * GESN hours stay a hint and do not become the stage length.
 * File 4 daily norms (ОРЧ, pipe, drilling on 88-127) staff the crew and,
 * when the file states a daily output, set the length. They are not a price.
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

export function planCommercialStage(input: {
  workName: string;
  unit: string | null;
  volume: number | null;
  shiftsPerDay: number;
  lookups: ShiftOutputCandidate[];
  gesnHoursHint: number | null;
}): CommercialStagePlan {
  const shifts = Number.isFinite(input.shiftsPerDay) && input.shiftsPerDay > 0 ? input.shiftsPerDay : 1;
  const kind = matchSiteWorkKind(input.workName);
  if (kind) {
    const site = sitePlan(kind, input.workName, input.unit, input.volume, input.gesnHoursHint);
    if (site) return site;
  }
  const picked = pickShiftOutput(input.workName, input.unit, input.lookups);
  if (picked.status === "ambiguous") {
    return emptyPlan(input.gesnHoursHint, "Несколько норм выработки, механизм или группа грунта не выбраны. Длительность не назначена.");
  }
  if (picked.status === "unique" && input.volume != null && input.volume > 0) {
    const formulaVolume = input.volume * picked.volume;
    const durationDays = durationDaysFromOutput({
      volume: formulaVolume,
      outputPerShift11h: picked.row.outputPerShift11h,
      shiftsPerDay: shifts,
      mechanisms: 1,
    });
    return {
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

export function durationFromStored(stage: {
  durationBasis?: DurationBasis | null;
  formulaVolume?: number | null;
  outputPerShift11h?: number | null;
  dailyOutput?: number | null;
  statedLinks?: number | null;
  statedShifts?: number | null;
  mechanismCount?: number | null;
  durationShifts?: number | null;
}): number | null {
  const volume = stage.formulaVolume;
  if (volume == null || !(volume > 0)) return null;
  if (stage.durationBasis === "output_shift") {
    return durationDaysFromOutput({
      volume,
      outputPerShift11h: stage.outputPerShift11h ?? 0,
      shiftsPerDay: stage.durationShifts ?? 0,
      mechanisms: stage.mechanismCount ?? 0,
    });
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

function isWeekend(iso: string, weekendDays: number[]): boolean {
  return weekendDays.includes(new Date(`${iso}T12:00:00Z`).getUTCDay());
}

/** A stage longer than this is rejected instead of walking the calendar day by day. */
export const MAX_SCHEDULE_DAYS = 20_000;

function alignToWorkday(iso: string, weekendDays: number[]): string {
  let cursor = iso;
  for (let step = 0; step < 14; step += 1) {
    if (!isWeekend(cursor, weekendDays)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new Error("Календарь не содержит рабочих дней");
}

/** Inclusive working-day end. A partial day occupies the next whole working day. */
export function endAfterWorkingDays(start: string, days: number, weekendDays: number[]): string {
  const need = Math.max(1, Math.ceil(days - 1e-9));
  if (!Number.isFinite(need) || need > MAX_SCHEDULE_DAYS) {
    throw new Error("Срок этапа слишком большой. Уменьшите объём или добавьте выработку.");
  }
  let cursor = alignToWorkday(start, weekendDays);
  let counted = 1;
  let steps = 0;
  while (counted < need) {
    cursor = addDays(cursor, 1);
    steps += 1;
    if (steps > need + 14) throw new Error("Календарь не содержит рабочих дней");
    if (!isWeekend(cursor, weekendDays)) counted += 1;
  }
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

export function deadlineView(input: {
  stages: Array<{
    start: string;
    end: string;
    durationBasis?: DurationBasis | null;
    durationDays?: number | null;
  }>;
  deadline: { start: string; end: string } | null;
  shiftsPerDay: number;
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
  const shiftAvailable = exceeds && input.shiftsPerDay < 2;
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
  if (previous == null || !(previousQty > 0) || !(nextQty > 0)) return previous ?? null;
  return previous * (nextQty / previousQty);
}
