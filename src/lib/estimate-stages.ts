import { classifyDirectCostBucket } from "@/lib/cost-engine";
import { mergeStageResources } from "@/lib/resource-merge";
import type { CalcPosition, GprStage, GprStageResource } from "@/lib/types";

/**
 * One stage per estimate section and work.
 * Identical materials merge only inside that pair, so a row from another section stays put.
 */
export function buildStagesFromEstimatePositions(
  positions: CalcPosition[],
  now: string,
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

  return [...sections.values()].map(({ sectionName, workName, positions: rows }, index) => {
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

    return {
      id: stageId,
      name: workName,
      ...(workName !== sectionName ? { sectionName, workName } : { sectionName }),
      start: now.slice(0, 10),
      end: now.slice(0, 10),
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
    totals.set(key, (totals.get(key) ?? 0) + row.quantity);
  }
  return totals;
}
