import { classifyDirectCostBucket } from "@/lib/cost-engine";
import { mergeStageResources } from "@/lib/resource-merge";
import type { CalcPosition, GprStage, GprStageResource } from "@/lib/types";

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

/**
 * Only a duration of the works themselves («срок выполнения работ»).
 * Warranty, payment, acceptance and bid periods are not the schedule.
 */
export function calendarDurationDays(text: string): number | null {
  const normalized = normalizeScheduleText(text);
  const pattern = /(\d{1,4})\s+календарн\p{L}*\s+дн\p{L}*/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized))) {
    const days = Number(match[1]);
    if (!Number.isFinite(days) || days <= 0) continue;
    const window = normalized.slice(Math.max(0, match.index - 36), match.index + match[0].length + 16);
    if (/гарант|оплат|при[её]мк|аванс|обеспечен|штраф|неустойк|пен[ия]|подач/iu.test(window)) continue;
    if (!/срок\s+выполнен|выполнен\p{L}*\s+работ|производств\p{L}*\s+работ|срок\s+работ/iu.test(window)) continue;
    return days;
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
): GprStage[] {
  const sections = new Map<string, { sectionName: string; workName: string; positions: CalcPosition[] }>();
  for (const position of positions) {
    const section = position.sourceSectionName?.trim();
    const work = position.sourceWorkName?.trim();
    if (!section && !work) continue;
    const sectionName = section || work || "Прочие позиции";
    const workName = work || sectionName;
    const key = `${sectionName}\u0000${workName}`;
    const group = sections.get(key) ?? { sectionName, workName, positions: [] };
    group.positions.push(position);
    sections.set(key, group);
  }

  const groups = [...sections.values()];
  const today = now.slice(0, 10);
  return groups.map(({ sectionName, workName, positions: rows }, index) => {
    const stageId = `gs-est-${index + 1}`;
    const workPositions = rows.filter((position) => position.isWorkItem && position.name === workName);
    const workUnits = new Set(workPositions.map((position) => position.unit));
    const workVolume = workPositions.length > 0 && workUnits.size === 1
      ? workPositions.reduce((total, position) => total + position.quantity, 0)
      : null;
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

    const dates = datesForStage(index, groups.length, today, period ?? null);
    return {
      id: stageId,
      name: workName,
      ...(workName !== sectionName ? { sectionName, workName } : { sectionName }),
      start: dates.start,
      end: dates.end,
      sequence: index + 1,
      crewSize: 0,
      ...(workVolume != null ? { planVolume: workVolume, planUnit: workPositions[0].unit } : {}),
      resources: mergeStageResources(resources),
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
