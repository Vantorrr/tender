/**
 * Normative hours already written in a local estimate (ЗТ / маш.-ч).
 * They are a duration input for the GPR. They are not a price.
 */

export interface EstimateNormHours {
  sectionName: string;
  workName: string;
  laborHours: number;
  machineHours: number;
}

function fold(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/\s+/g, " ").trim();
}

export function foldStageKey(section: string, work: string): string {
  return `${fold(section)}\0${fold(work)}`;
}

function sectionNumber(section: string): string | null {
  return /^раздел\s+(\d+)/iu.exec(fold(section))?.[1] ?? null;
}

/** Worker hours, then machine hours, then operator hours. Null when the rows have none. */
export function hoursOnPositions(rows: Array<{
  name: string;
  unit: string;
  quantity: number;
  isWorkItem?: boolean;
}>): number | null {
  let labor = 0;
  let machine = 0;
  let operators = 0;
  for (const row of rows) {
    if (row.isWorkItem) continue;
    if (!(row.quantity > 0)) continue;
    const unit = row.unit.toLocaleLowerCase("ru-RU");
    if (!/ч/iu.test(unit)) continue;
    const name = row.name.trim().toLocaleLowerCase("ru-RU");
    if (/чел/iu.test(unit)) {
      if (name === "зтм" || name === "затраты труда машинистов" || /машинист/iu.test(name)) operators += row.quantity;
      else labor += row.quantity;
    } else if (/маш/iu.test(unit)) {
      machine += row.quantity;
    }
  }
  if (labor > 0) return labor;
  if (machine > 0) return machine;
  if (operators > 0) return operators;
  return null;
}

/** Hours for one stage. Rows already on the calculation win over a second read of the file. */
export function lookupNormHours(
  section: string,
  work: string,
  hints: EstimateNormHours[],
): number | null {
  if (!hints.length || !work.trim()) return null;
  const key = foldStageKey(section, work);
  const number = sectionNumber(section);
  const hit = hints.find((hint) => foldStageKey(hint.sectionName, hint.workName) === key)
    ?? hints.find((hint) => fold(hint.workName) === fold(work) && sectionNumber(hint.sectionName) === number);
  if (!hit) return null;
  if (hit.laborHours > 0) return hit.laborHours;
  if (hit.machineHours > 0) return hit.machineHours;
  return null;
}
