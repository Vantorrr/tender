export type WorkSectionRollup = {
  sections: Array<{ section: string; unit: string; quantity: number; rows: number }>;
  totalsByUnit: Array<{ unit: string; quantity: number; rows: number }>;
  titledCounts: Array<{ unit: string; quantity: number }>;
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function isOverheadPosition(position: { code?: string; name?: string }): boolean {
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
  const works = positions.filter((position) => position.isWorkItem && !isOverheadPosition(position));
  const rows = (works.length ? works : positions.filter((position) => !isOverheadPosition(position))).filter((position) =>
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

const VOLUME_SKIP = new Set(["раздел", "работ", "работы", "работа", "итого", "всего", "смета", "позиц"]);

function volumeStems(name: string): string[] {
  return (name.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").match(/[а-я]{4,}/gu) ?? [])
    .map((word) => word.slice(0, 5))
    .filter((stem) => stem.length >= 4 && !VOLUME_SKIP.has(stem));
}

/** A quantity keeps the work named in the section heading. A norm line cannot rename it. */
export function alignVolumeToSections(text: string, rollup: WorkSectionRollup): string {
  const claims = [
    ...rollup.sections.map((section) => ({ quantity: section.quantity, unit: section.unit, name: section.section })),
    ...rollup.sections.flatMap((section) => {
      const match = section.section.match(/(\d[\d\s]*)\s*шт(?![а-яё])/iu);
      if (!match) return [];
      const quantity = Number(match[1]!.replace(/\s/g, ""));
      return Number.isFinite(quantity) ? [{ quantity, unit: "шт", name: section.section }] : [];
    }),
  ];
  let next = text;
  for (const claim of claims) {
    const stems = volumeStems(claim.name);
    if (!stems.length) continue;
    const qty = String(Math.trunc(claim.quantity));
    const pattern = new RegExp(`(?:[А-Яа-яЁёA-Za-z-]{3,}\\s+){0,6}${qty}(?:[.,]\\d+)?\\s*(?:шт|м2|м3|м|т|кг)\\.?\\s*(?:[А-Яа-яЁёA-Za-z-]{3,}\\s*){0,4}`, "giu");
    next = next.replace(pattern, (phrase, offset: number) => {
      const window = next.slice(Math.max(0, offset - 48), offset + phrase.length + 48).toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
      if (stems.some((stem) => window.includes(stem))) return phrase;
      return `${claim.name}: ${claim.quantity} ${claim.unit}`;
    });
  }
  return next;
}

const WORK_TERM = /(?:установк\w*|бурени\w*|скважин\w*|свайн\w*|свай\w*|монтаж\w*|демонтаж\w*|укладк\w*|прокладк\w*|разработк\w*|погружен\w*|забивк\w*|бетонирован\w*|разборк\w*|изоляц\w*|сварк\w*)/giu;

function workStem(term: string): string {
  const folded = term.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  if (folded.startsWith("свай")) return "свай";
  if (folded.startsWith("сква")) return "сква";
  return folded.slice(0, 5);
}

function tidyWorkGap(text: string): string {
  return text
    .replace(/(?:включая|а также)\s+(?=и\b|[,.]|$)/giu, "")
    .replace(/\s+и\s+(?=[,.]|$)/giu, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/,\s*(?=[,.]|$)/g, "")
    .trim();
}

/** A work word stays only when the section list and the cited excerpt both contain it. */
export function stripWorkTypesOutsideSources(text: string, quote: string, sectionNames: string[]): string {
  const sections = sectionNames.join("\n").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const quoted = quote.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  return tidyWorkGap(text.replace(WORK_TERM, (term) => {
    const stem = workStem(term);
    return sections.includes(stem) && quoted.includes(stem) ? term : "";
  }));
}
