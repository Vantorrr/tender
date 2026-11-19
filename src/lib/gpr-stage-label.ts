/** Visible GPR stage name: section number first, so identical works stay distinct. */
export function gprStageLabel(stage: {
  name: string;
  sectionName?: string;
  workName?: string;
}): { text: string; title: string; numbered: boolean } {
  const section = stage.sectionName?.trim() ?? "";
  const work = (stage.workName?.trim() || stage.name).trim();
  const title = section && section !== work ? `${section} — ${work}` : work || stage.name;
  if (!section || section === stage.name) return { text: stage.name, title, numbered: false };
  const numbered = section.match(/^раздел\s+(\d+)\.?\s*(.*)$/iu);
  if (!numbered) {
    const text = section.length > 56 ? `${section.slice(0, 54).trim()}…` : section;
    return { text, title, numbered: false };
  }
  const rest = numbered[2].replace(/\s+\d+\s*шт\.?$/iu, "").trim();
  const short = rest.length > 42 ? `${rest.slice(0, 40).trim()}…` : rest;
  return { text: short ? `${numbered[1]}. ${short}` : `Раздел ${numbered[1]}`, title, numbered: true };
}
