/**
 * Client reference catalogs (wave 3).
 * These rows are a lookup table. They are not written into Calculation.costSummary
 * and they do not build a GPR.
 */

export const CLIENT_NORM_KINDS = ["output", "labor", "tkm", "sites"] as const;

export type ClientNormKind = (typeof CLIENT_NORM_KINDS)[number];

export interface ClientNormWarning {
  code: string;
  text: string;
}

export interface ClientNormCatalogSummary {
  id: string;
  kind: ClientNormKind;
  title: string;
  shiftHours: number | null;
  counts: Record<string, number>;
  warnings: ClientNormWarning[];
  /** Always false: importing a catalog does not price a tender. */
  participatesInOfficialCost: false;
  importedAt: string;
}

export interface OutputNormRow {
  excelRow: number;
  section: string;
  workName: string;
  unit: string | null;
  soilName: string | null;
  soilGroup: string | null;
  mechanism: string | null;
  machineHoursNorm: number | null;
  crew: string | null;
  productivityPerHour: number | null;
  productivityPerShift11h: number | null;
  shiftHours: number;
}

export interface LaborNormRow {
  operationNumber: number;
  operationTitle: string;
  subsection: string | null;
  normOn: string | null;
  material: string | null;
  sizeLabel: string | null;
  size: string | null;
  unit: string | null;
  k: number | null;
  normPerShift11h: number | null;
  timeHoursPerUnit: number | null;
  shiftHours: number;
  timeMatches11OverShift: boolean;
  sourceAnomaly: string | null;
}

export interface HaulLegRow {
  excelRow: number;
  shoulderKm: number;
  tripsPerShift: number | null;
  tripsFormula: string | null;
  avgSpeedKmh: number | null;
  loadMinutes: number | null;
  unloadMinutes: number | null;
  tonnesPerShift: number | null;
  tonnesFormula: string | null;
  costPerTonneKm: number | null;
  costFormula: string | null;
  shiftHours: number;
}

export interface SiteBenchmarkRow {
  siteCode: string;
  kind: "plan" | "crew" | "operation" | "resolution" | "benchmark" | "typo";
  name: string;
  unit: string | null;
  fact: string | null;
  need: string | null;
  note: string | null;
  shiftHint: string | null;
  detail: Record<string, unknown>;
}

export interface ClientNormQuery {
  catalog: ClientNormKind;
  q?: string;
  work?: string;
  mechanism?: string;
  section?: string;
  size?: string;
  operation?: number;
  shoulder?: number;
  site?: string;
  limit?: number;
  offset?: number;
}

export function isClientNormKind(value: string | null | undefined): value is ClientNormKind {
  return CLIENT_NORM_KINDS.includes(value as ClientNormKind);
}

/** Case-fold for lookup only. Stored catalog strings stay as in the source file. */
export function foldNormSearch(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("ru-RU").replace(/\s+/g, " ").trim();
}

export function likePattern(value: string): string {
  const folded = foldNormSearch(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${folded}%`;
}
