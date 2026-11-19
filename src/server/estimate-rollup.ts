export type WorkSectionRollup = {
  sections: Array<{ section: string; unit: string; quantity: number; rows: number }>;
  totalsByUnit: Array<{ unit: string; quantity: number; rows: number }>;
  titledCounts: Array<{ unit: string; quantity: number }>;
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isOverheadNorm(position: { code?: string; name?: string }): boolean {
  const code = position.code?.trim() ?? "";
  const name = position.name?.trim() ?? "";
  return /^(?:нр|сп)(?:$|[\s.-])/iu.test(code) || /^(?:нр|сп)(?:$|\s)/iu.test(name);
}

function isOverheadHeading(section: string): boolean {
  return /^(?:нр|сп)(?:\s|$)/iu.test(section.trim());
}

/** Sum every work line by section. Resource rows are used only when the file has no work lines. Overhead norms are not sections. */
export function rollupWorkSections(positions: Array<{
  sectionName?: string;
  name?: string;
  code?: string;
  unit?: string;
  quantity?: number;
  isWorkItem?: boolean;
}>): WorkSectionRollup {
  const works = positions.filter((position) => position.isWorkItem && !isOverheadNorm(position));
  const rows = (works.length ? works : positions.filter((position) => !isOverheadNorm(position))).filter((position) =>
    typeof position.quantity === "number" && Number.isFinite(position.quantity) && position.quantity !== 0
    && !isOverheadHeading(position.sectionName?.trim() || "")
  );
  const sections: WorkSectionRollup["sections"] = [];
  const index = new Map<string, number>();
  const titled = new Map<string, number>();
  const seenTitle = new Set<string>();
  for (const row of rows) {
    const section = row.sectionName?.trim() || "Без раздела";
    const unit = row.unit?.trim() || "ед.";
    const key = `${section}\u0001${unit}`;
    const at = index.get(key);
    if (at == null) {
      index.set(key, sections.length);
      sections.push({ section, unit, quantity: round(row.quantity!), rows: 1 });
    } else {
      const current = sections[at]!;
      current.quantity = round(current.quantity + row.quantity!);
      current.rows += 1;
    }
    if (!seenTitle.has(section)) {
      seenTitle.add(section);
      const match = section.match(/(\d[\d\s]*)\s*шт(?![а-яё])/iu);
      if (match) {
        const count = Number(match[1]!.replace(/\s/g, ""));
        if (Number.isFinite(count)) titled.set("шт", round((titled.get("шт") ?? 0) + count));
      }
    }
  }
  const totals = new Map<string, { quantity: number; rows: number }>();
  for (const section of sections) {
    const current = totals.get(section.unit) ?? { quantity: 0, rows: 0 };
    current.quantity = round(current.quantity + section.quantity);
    current.rows += section.rows;
    totals.set(section.unit, current);
  }
  return {
    sections,
    totalsByUnit: [...totals.entries()].map(([unit, value]) => ({ unit, quantity: value.quantity, rows: value.rows })),
    titledCounts: [...titled.entries()].map(([unit, quantity]) => ({ unit, quantity })),
  };
}
