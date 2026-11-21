/** One need per procurement, material, unit, work and source. The window is not time-limited. */
export function supplyNeedKey(input: {
  materialName?: string;
  unit?: string;
  workName?: string;
  source?: string;
}): string {
  const norm = (value: string | undefined) =>
    (value ?? "").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  return [norm(input.materialName), norm(input.unit), norm(input.workName), norm(input.source || "manual")].join("|");
}
