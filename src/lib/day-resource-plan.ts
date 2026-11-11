/**
 * Day-details resource plan lines: only stages linked to the selected work.
 * No silent fallback to the whole GPR.
 */
import type { DailyResourceLine, GprStage } from "@/lib/types";

export function stageMatchesWork(s: GprStage, workName: string): boolean {
  const w = workName.trim();
  if (!w) return false;
  if ((s.workNames?.length ? s.workNames : [s.workName]).some((name) => name?.trim() === w)) return true;
  if (s.name.trim() === w) return true;
  // Soft includes only when workName is a clear substring of the stage name
  // (e.g. «Демонтаж перегородок» ↔ «Демонтаж и подготовка оснований» — NOT automatic;
  // require workName link for product correctness).
  return false;
}

export function stagesForWork(
  stages: GprStage[],
  workName: string,
  date?: string
): GprStage[] {
  const linked = stages.filter((s) => stageMatchesWork(s, workName));
  if (!linked.length) return [];
  if (!date) return linked;
  const covering = linked.filter((s) => s.start <= date && s.end >= date);
  // Date outside linked stages → still empty for that day (honest «нет данных»)
  return covering;
}

/** Labor only — bus is transport, never «Люди». */
export function planResourceLinesForDay(
  stages: GprStage[],
  date: string,
  workName: string
): DailyResourceLine[] {
  const stagesUse = stagesForWork(stages, workName, date);
  const lines: DailyResourceLine[] = [];
  const seen = new Set<string>();
  for (const st of stagesUse) {
    for (const r of st.resources ?? []) {
      if (r.kind !== "labor" && r.kind !== "material" && r.kind !== "equipment" && r.kind !== "bus") {
        continue;
      }
      const key = `${r.kind}|${r.name}|${r.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({
        kind: r.kind,
        sourceResourceId: r.id,
        name: r.name,
        unit:
          r.unit ||
          (r.kind === "labor" ? "чел" : r.kind === "material" ? "ед." : "ед."),
        planQty: r.quantity,
        factQty: null,
      });
    }
  }
  return lines;
}
