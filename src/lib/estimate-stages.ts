import {
  gesnHoursHint,
  constructionPhase,
  placeStagePhases,
  planCommercialStage,
  type ShiftOutputCandidate,
} from "@/lib/commercial-packages";
import { classifyDirectCostBucket, isWorkActivityName } from "@/lib/cost-engine";
import { hoursOnPositions, lookupNormHours, type EstimateNormHours } from "@/lib/estimate-norm-hours";
import { mergeStageResources } from "@/lib/resource-merge";
import type { CalcPosition, GprStage, GprStageResource } from "@/lib/types";

export interface CommercialStageOptions {
  weekendDays: number[];
  shiftsPerDay: number;
  hoursPerShift?: number;
  lookups: ShiftOutputCandidate[];
  /** ЗТ / маш.-ч read from the estimate file when the calculation rows omit them. */
  normHours?: EstimateNormHours[];
}

/**
 * One stage per estimate section and work.
 * Identical materials merge only inside that pair, so a row from another section stays put.
 */
export const GPR_DATES_MISSING = "Срок не указан в документах — проставьте даты на графике";

function ruOrIsoDate(value: string): string | null {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
  }
  const match = value.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const next = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${next}T00:00:00Z`);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day ? next : null;
}

/** «г.» after a year is an abbreviation, not the end of a sentence. */
function normalizeScheduleText(text: string): string {
  return text.replace(/(\d{4})\s*г\./giu, "$1");
}

/**
 * A work interval is an explicit range or a named start and finish.
 * Loose dates (a protocol, a bid deadline) do not become the schedule.
 */
export function periodFromDocumentText(text: string): { start: string; end: string } | null {
  const normalized = normalizeScheduleText(text);
  const range = /с\s+(\d{1,2}[./]\d{1,2}[./]\d{4})\s+по\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/iu.exec(normalized);
  if (range) {
    const around = normalized.slice(Math.max(0, range.index - 48), range.index + range[0].length + 48);
    const submissionOnly = /подач|заявк|протокол/iu.test(around) && !/работ|выполнен|производств/iu.test(around);
    const start = ruOrIsoDate(range[1]);
    const end = ruOrIsoDate(range[2]);
    if (!submissionOnly && start && end && start < end) return { start, end };
  }
  const startMatch = /начал\p{L}*(?:\s+работ\p{L}*)?\s+(\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{2}-\d{2})/iu.exec(normalized);
  const endMatch = /окончан\p{L}*(?:\s+работ\p{L}*)?\s+(\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{2}-\d{2})/iu.exec(normalized);
  if (startMatch && endMatch && /работ|выполнен|производств/iu.test(normalized)) {
    const start = ruOrIsoDate(startMatch[1]);
    const end = ruOrIsoDate(endMatch[1]);
    if (start && end && start < end) return { start, end };
  }
  return null;
}

const WORK_DURATION_CUE = /срок\s+выполнен|выполнен\p{L}*\s+работ|производств\p{L}*\s+работ|срок\s+работ/iu;
const OTHER_PERIOD_CUE = /(?<![\p{L}])(?:(?:пред|пере)?оплат|(?:пере)?обеспечен|гарант|при[её]мк|аванс|штраф|неустойк|пен[ия]|подач)\p{L}*(?![\p{L}])/iu;
const CALENDAR_DAYS = /(\d{1,4})\s+календарн\p{L}*\s+дн\p{L}*/iu;

/** One sentence. A date's dots and «г.» are not a sentence break. */
function scheduleSentences(text: string): string[] {
  return normalizeScheduleText(text)
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Only a duration of the works themselves («срок выполнения работ»).
 * Warranty, payment, acceptance and bid clauses are skipped even when they
 * also mention the works. An earlier advance in another clause does not cancel
 * the works period.
 */
export function calendarDurationDays(text: string): number | null {
  for (const sentence of scheduleSentences(text)) {
    let pendingWork = false;
    for (const clause of sentence.split(/[;,]\s*/u)) {
      const part = clause.trim();
      if (!part) continue;
      const blocked = OTHER_PERIOD_CUE.test(part);
      const work = WORK_DURATION_CUE.test(part);
      const match = CALENDAR_DAYS.exec(part);
      const days = match ? Number(match[1]) : 0;
      if (blocked) {
        pendingWork = false;
        continue;
      }
      if (days > 0 && (work || pendingWork)) return days;
      pendingWork = work;
    }
  }
  return null;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function datesForStage(
  index: number,
  count: number,
  today: string,
  period: { start: string; end: string } | null,
): { start: string; end: string } {
  if (!period || count <= 0) {
    const start = addDays(today, Math.max(0, index));
    return { start, end: start };
  }
  const span = Math.max(1, Math.round((Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86400000) + 1);
  const slice = Math.max(1, Math.floor(span / Math.max(count, 1)));
  const start = addDays(period.start, Math.min(index * slice, Math.max(0, span - 1)));
  const end = index === count - 1 ? period.end : addDays(start, Math.max(0, slice - 1));
  return end < start ? { start, end: start } : { start, end };
}

export function buildStagesFromEstimatePositions(
  positions: CalcPosition[],
  now: string,
  period?: { start: string; end: string } | null,
  options?: CommercialStageOptions,
): GprStage[] {
  const sections = new Map<string, { sectionName: string; workName: string; positions: CalcPosition[] }>();
  for (const position of positions) {
    const section = position.sourceSectionName?.trim();
    const work = position.sourceWorkName?.trim();
    const activity = !section && !work && isWorkActivityName(position.name) ? position.name.trim() : "";
    if (!section && !work && !activity) continue;
    const sectionName = section || work || activity || "Прочие позиции";
    const workName = work || activity || sectionName;
    const key = `${sectionName}\u0000${workName}`;
    const group = sections.get(key) ?? { sectionName, workName, positions: [] };
    group.positions.push(position);
    sections.set(key, group);
  }

  const groups = [...sections.values()];
  const today = now.slice(0, 10);
  const weekendDays = options?.weekendDays ?? [];
  const shiftsPerDay = options?.shiftsPerDay ?? 2;
  const hoursPerShift = options?.hoursPerShift && options.hoursPerShift > 0 ? options.hoursPerShift : 11;
  const lookups = options?.lookups ?? [];
  const normHourHints = options?.normHours ?? [];
  const anchor = period?.start ?? today;
  const drafted = groups.map(({ sectionName, workName, positions: rows }, index) => {
    const stageId = `gs-est-${index + 1}`;
    const workPositions = rows.filter((position) => position.isWorkItem && position.name === workName);
    const workUnits = new Set(workPositions.map((position) => position.unit));
    const workVolume = workPositions.length > 0 && workUnits.size === 1
      ? workPositions.reduce((total, position) => total + position.quantity, 0)
      : null;
    const volumeRows = rows.filter((position) => position.code === "ВОР");
    const volumeUnits = new Set(volumeRows.map((position) => position.unit));
    const volumeSheet = volumeRows.length > 0 && volumeUnits.size === 1
      ? volumeRows.reduce((total, position) => total + position.quantity, 0)
      : null;
    const physicalVolume = workVolume ?? volumeSheet;
    const physicalUnit = workVolume != null
      ? workPositions[0]?.unit ?? null
      : volumeSheet != null
        ? volumeRows[0]?.unit ?? null
        : null;
    const volumeRowIds = workVolume == null && volumeSheet != null ? volumeRows.map((position) => position.id) : [];
    const resources: GprStageResource[] = rows.flatMap((position) => {
      if (position.isWorkItem) return [];
      const code = position.code.toLocaleUpperCase("ru-RU");
      if (/^(?:НР|СП)(?:$|[-.\s])/iu.test(code)) return [];
      const unit = position.unit.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
      let kind: GprStageResource["kind"] | null = position.resourceKind ?? null;
      if (!kind && /автобус|bus|^BUS(?:[-\s]|$)/iu.test(`${code} ${position.name}`)) kind = "bus";
      else if (!kind && (/^(?:ФСЭМ|ТСЭМ|EQ(?:-|\s|$))/iu.test(code) || classifyDirectCostBucket(position) === "equipment")) kind = "equipment";
      else if (!kind && /^ФССЦПГ/iu.test(code)) kind = "other";
      else if (!kind && (/^(?:ФССЦ|ТССЦ|ФСБЦ|MAT(?:-|\s|$))/iu.test(code) || /щебен|геотекстил|песок|грунт|цемент|вод[аы]/iu.test(position.name) || classifyDirectCostBucket(position) === "materials")) kind = "material";
      else if (!kind && (/^(?:LAB(?:-|\s|$)|ОТ|ЗП)/iu.test(code) || classifyDirectCostBucket(position) === "labor")) kind = "labor";
      if (!kind) kind = "other";
      if (!Number.isFinite(position.quantity) || position.quantity === 0) return [];

      const quantityBasis: GprStageResource["quantityBasis"] = kind === "material" || kind === "other"
        ? "material_qty"
        : /(?:маш|чел|н)[\s.-]*ч/u.test(unit)
          ? "total_hours"
          : "uncertain";
      return [{
        id: `res-${stageId}-${position.id}`,
        sourceKey: position.id,
        kind,
        name: position.name,
        quantity: position.quantity,
        unit: position.unit,
        rate: position.rateMissing || !(Number.isFinite(position.rate) && position.rate > 0)
          ? null
          : position.rate,
        quantityBasis,
      }];
    });

    const resourcesMerged = mergeStageResources(resources);
    const normHours = hoursOnPositions(rows) ?? lookupNormHours(sectionName, workName, normHourHints);
    const plan = planCommercialStage({
      workName,
      unit: physicalUnit,
      volume: physicalVolume,
      shiftsPerDay,
      hoursPerShift,
      normHours,
      lookups,
      gesnHoursHint: gesnHoursHint(resourcesMerged),
    });
    return {
      id: stageId,
      name: workName,
      ...(workName !== sectionName ? { sectionName, workName } : { sectionName }),
      start: anchor,
      end: anchor,
      sequence: index + 1,
      crewSize: 0,
      ...(physicalVolume != null && physicalUnit ? { planVolume: physicalVolume, planUnit: physicalUnit } : {}),
      durationBasis: plan.durationBasis,
      ...(plan.durationDays != null ? { durationDays: plan.durationDays } : {}),
      ...(plan.formulaVolume != null ? { formulaVolume: plan.formulaVolume } : {}),
      ...(plan.formulaVolume != null && physicalVolume != null && physicalVolume > 0
        ? { formulaPerPhysical: plan.formulaVolume / physicalVolume }
        : {}),
      ...(volumeRowIds.length ? { volumeRowIds, volumeSource: "vor" as const } : {}),
      ...(workVolume != null ? { volumeSource: "estimate" as const } : {}),
      ...(plan.outputPerShift11h != null ? { outputPerShift11h: plan.outputPerShift11h } : {}),
      ...(plan.dailyOutput != null ? { dailyOutput: plan.dailyOutput } : {}),
      ...(plan.statedLinks != null ? { statedLinks: plan.statedLinks } : {}),
      ...(plan.statedShifts != null ? { statedShifts: plan.statedShifts } : {}),
      ...(plan.mechanismCount != null ? { mechanismCount: plan.mechanismCount } : {}),
      ...(plan.durationShifts != null ? { durationShifts: plan.durationShifts } : {}),
      ...(plan.gesnHoursHint != null ? { gesnHoursHint: plan.gesnHoursHint } : {}),
      ...(plan.benchmarkSource ? { benchmarkSource: plan.benchmarkSource } : {}),
      ...(plan.benchmarkCrew.length ? { benchmarkCrew: plan.benchmarkCrew } : {}),
      resources: resourcesMerged.length
        ? resourcesMerged
        : plan.benchmarkCrew.map((line, lineIndex) => ({
          id: `crew-${stageId}-${lineIndex + 1}`,
          kind: line.kind,
          name: line.role,
          quantity: line.count,
          unit: line.kind === "labor" ? "чел" : "шт",
          rate: null,
          quantityBasis: "count_per_shift" as const,
        })),
    };
  });
  const placed = placeStagePhases(anchor, weekendDays, drafted.map((stage) => ({
    phase: constructionPhase(stage.name, stage.sectionName ?? ""),
    durationDays: stage.durationDays ?? null,
  })));
  return drafted.map((stage, index) => {
    const spot = placed[index];
    const predecessor = spot?.dependsOn;
    return {
      ...stage,
      start: spot?.start ?? anchor,
      end: spot?.end ?? anchor,
      ...(predecessor != null ? { dependsOn: drafted[predecessor]?.id, dependencyType: "FS" as const } : {}),
    };
  });
}

export function signedQuantityBySection(
  rows: Array<{ section?: string; name: string; unit: string; quantity: number }>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = [
      (row.section ?? "").trim().toLocaleLowerCase("ru-RU"),
      row.name.replace(/^возврат:\s*/iu, "").trim().toLocaleLowerCase("ru-RU"),
      row.unit.trim().toLocaleLowerCase("ru-RU"),
    ].join("|");
    const signed = /^возврат:/iu.test(row.name) ? -Math.abs(row.quantity) : row.quantity;
    totals.set(key, (totals.get(key) ?? 0) + signed);
  }
  return totals;
}
