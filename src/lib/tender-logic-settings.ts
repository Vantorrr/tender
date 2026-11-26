/**
 * Company tender rules for wave 1.
 * Unconfirmed figures (target margin 12–18%, floor 5–7% and similar) stay unset.
 * doc1_7plus1 is a named shift profile only: it is never written onto saved
 * resourceScheduleParams, and EXCEL_RESOURCE_SCHEDULE_DEFAULTS stays the Excel sheet.
 */
import { formatMoney } from "@/lib/format";
import { incompleteTotalText } from "@/lib/wave23";

export type ImportEstimateRowsMode = "translation_table" | "empty_packages";
export type ShiftProfile = "excel_current" | "doc1_7plus1";
export type NmckAtOrBelowCostPolicy = "warn" | "block";

export interface TenderLogicSettings {
  importEstimateRowsMode: ImportEstimateRowsMode;
  shiftProfile: ShiftProfile;
  nmckAtOrBelowCostPolicy: NmckAtOrBelowCostPolicy;
}

export const DEFAULT_TENDER_LOGIC_SETTINGS: TenderLogicSettings = {
  importEstimateRowsMode: "translation_table",
  shiftProfile: "excel_current",
  nmckAtOrBelowCostPolicy: "warn",
};

/** Separate preset. No resource-schedule numbers live here, so it cannot move a saved calculation. */
export const DOC1_7PLUS1_SHIFT_PROFILE = {
  id: "doc1_7plus1" as const,
  label: "Документ 1: режим 7+1",
  appliesToSavedResourceScheduleParams: false as const,
};

export const LEGACY_ESTIMATE_SEEDED_COST = "legacy_estimate_seeded_cost";
export const ESTIMATE_ROWS_AS_SOURCE_SHEET = "estimate_rows_as_source_sheet";
export const REFERENCE_REPRICE_NOT_COST = "reference_reprice_not_cost";

export const LEGACY_ESTIMATE_COST_BANNER =
  "Черновик создан по старой логике, когда строки сметы считались себестоимостью. Сохранённые цифры не пересчитаны. Новый импорт так больше не работает.";

export const REFERENCE_REPRICE_DISCLAIMER =
  "Справочная переоценка ресурсов сметы заказчика по ставкам компании. Это не черновая себестоимость.";

export const GPR_FROM_CUSTOMER_SECTIONS =
  "Этапы сгруппированы по разделам сметы заказчика, это не коммерческий ГПР и не подтверждение себестоимости.";

export const COMMITTEE_UNSET = "не задано, ждём правило компании";

const IMPORT_MODES = new Set<ImportEstimateRowsMode>(["translation_table", "empty_packages"]);
const SHIFT_PROFILES = new Set<ShiftProfile>(["excel_current", "doc1_7plus1"]);
const NMCK_POLICIES = new Set<NmckAtOrBelowCostPolicy>(["warn", "block"]);

export function resolveTenderLogicSettings(
  org?: { tenderLogic?: Partial<TenderLogicSettings> | null } | null,
): TenderLogicSettings {
  const override = org?.tenderLogic ?? {};
  return {
    importEstimateRowsMode: IMPORT_MODES.has(override.importEstimateRowsMode as ImportEstimateRowsMode)
      ? override.importEstimateRowsMode as ImportEstimateRowsMode
      : DEFAULT_TENDER_LOGIC_SETTINGS.importEstimateRowsMode,
    shiftProfile: SHIFT_PROFILES.has(override.shiftProfile as ShiftProfile)
      ? override.shiftProfile as ShiftProfile
      : DEFAULT_TENDER_LOGIC_SETTINGS.shiftProfile,
    nmckAtOrBelowCostPolicy: NMCK_POLICIES.has(override.nmckAtOrBelowCostPolicy as NmckAtOrBelowCostPolicy)
      ? override.nmckAtOrBelowCostPolicy as NmckAtOrBelowCostPolicy
      : DEFAULT_TENDER_LOGIC_SETTINGS.nmckAtOrBelowCostPolicy,
  };
}

type CostRole = "commercial" | "customer_source";

export function isLegacyEstimateSeededCost(calc: { dataFlags?: string[] } | null | undefined): boolean {
  return Boolean(calc?.dataFlags?.includes(LEGACY_ESTIMATE_SEEDED_COST));
}

export function officialCostPositions<T extends { costRole?: CostRole }>(positions: T[]): T[] {
  return positions.filter((position) => position.costRole !== "customer_source");
}

export function customerSourcePositions<T extends { costRole?: CostRole }>(positions: T[]): T[] {
  return positions.filter((position) => position.costRole === "customer_source");
}

export function positionFeedsOfficialCost(position: {
  costRole?: CostRole;
  isWorkItem?: boolean;
  code?: string;
  rateMissing?: boolean;
  rate?: number;
  quantity?: number;
}): boolean {
  if (position.costRole === "customer_source") return false;
  if (position.isWorkItem || position.code === "НР" || position.code === "СП") return false;
  return !position.rateMissing && Number.isFinite(position.rate) && (position.rate ?? 0) > 0 && position.quantity !== 0;
}

export type NmckVsCost = "unknown" | "above_cost" | "at_or_below_cost";

export interface CommitteeSnapshot {
  nmck: number | null;
  /** Confirmed official commercial total only. A reference reprice is never this figure. */
  fullCost: number | null;
  targetMarginPercent: number | null;
  floorMarginPercent: number | null;
  nmckVsCost: NmckVsCost;
}

export function buildCommitteeSnapshot(input: {
  nmck: number | null | undefined;
  officialCost: number | null | undefined;
  officialConfirmed: boolean;
}): CommitteeSnapshot {
  const nmck = input.nmck != null && Number.isFinite(input.nmck) ? input.nmck : null;
  const fullCost = input.officialConfirmed && input.officialCost != null && Number.isFinite(input.officialCost)
    ? input.officialCost
    : null;
  let nmckVsCost: NmckVsCost = "unknown";
  if (nmck != null && fullCost != null) {
    nmckVsCost = nmck <= fullCost ? "at_or_below_cost" : "above_cost";
  }
  return {
    nmck,
    fullCost,
    targetMarginPercent: null,
    floorMarginPercent: null,
    nmckVsCost,
  };
}

/** Money for an official tile. An unconfirmed zero is a sentence, never «0 ₽». */
export function officialMoneyText(
  amount: number | null | undefined,
  missingRates: number,
  totalsIncomplete: boolean,
): string {
  const phrase = incompleteTotalText(amount, missingRates);
  if (phrase) return phrase;
  if (totalsIncomplete && (amount == null || !Number.isFinite(amount) || amount === 0)) {
    return "Себестоимость не рассчитана: нет коммерческих строк со ставками";
  }
  if (amount == null || !Number.isFinite(amount)) return "нет подтверждённого итога";
  return formatMoney(amount);
}

export function committeeValueText(value: number | null | undefined, money = false): string {
  if (value == null || !Number.isFinite(value)) return COMMITTEE_UNSET;
  return money ? formatMoney(value) : String(value);
}
