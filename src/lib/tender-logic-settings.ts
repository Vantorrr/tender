/**
 * Company tender rules.
 * Unconfirmed Document 1 figures (margin 12–18%, floor 5–7%, reserve 3–7%) stay unset.
 * doc1_7plus1 is a named shift profile only: it is never written onto saved
 * resourceScheduleParams. EXCEL_RESOURCE_SCHEDULE_DEFAULTS stays the Excel sheet.
 * client_2x11_no_weekends is the default for a new official calculation and a new GPR.
 */
import { formatMoney } from "@/lib/format";
import {
  applyShiftProfileToParams,
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  type ResourceScheduleParams,
} from "@/lib/resource-schedule-model";
import { incompleteTotalText, scheduleParamsWithNorthernDefaults } from "@/lib/wave23";

export type ImportEstimateRowsMode = "translation_table" | "empty_packages";
export type ShiftProfile = "client_2x11_no_weekends" | "excel_current" | "doc1_7plus1";
export type NmckAtOrBelowCostPolicy = "warn" | "block";

export interface TenderLogicSettings {
  importEstimateRowsMode: ImportEstimateRowsMode;
  shiftProfile: ShiftProfile;
  nmckAtOrBelowCostPolicy: NmckAtOrBelowCostPolicy;
}

export const DEFAULT_TENDER_LOGIC_SETTINGS: TenderLogicSettings = {
  importEstimateRowsMode: "translation_table",
  shiftProfile: "client_2x11_no_weekends",
  nmckAtOrBelowCostPolicy: "warn",
};

/** Separate preset. No resource-schedule numbers live here, so it cannot move a saved calculation. */
export const DOC1_7PLUS1_SHIFT_PROFILE = {
  id: "doc1_7plus1" as const,
  label: "Документ 1: режим 7+1",
  appliesToSavedResourceScheduleParams: false as const,
};

export const SHIFT_PROFILE_OPTIONS: Array<{
  id: ShiftProfile;
  label: string;
  detail: string;
}> = [
  {
    id: "client_2x11_no_weekends",
    label: "2×11 без выходных",
    detail: "2 смены персонала, 2 смены техники, 11 часов, календарь без выходных",
  },
  {
    id: "excel_current",
    label: "Текущий Excel",
    detail: "2 смены персонала, 1 смена техники, 11 часов, выходные суббота и воскресенье",
  },
  {
    id: "doc1_7plus1",
    label: "Документ 1: режим 7+1",
    detail: "Именованный профиль. На параметры расчёта не записывается.",
  },
];

/** Params for a calculation that does not have them yet. Never a rewrite of a saved set. */
export function resourceParamsForNewCalculation(profile: ShiftProfile): ResourceScheduleParams {
  return scheduleParamsWithNorthernDefaults(
    applyShiftProfileToParams(profile, EXCEL_RESOURCE_SCHEDULE_DEFAULTS),
  );
}

/**
 * Calendar for a brand-new GPR. Excel and 7+1 keep the previous scaffold
 * (caller leaves the calendar unset). The client profile has no weekends.
 */
export function calendarForNewSchedule(profile: ShiftProfile): {
  weekendDays: number[];
  hoursPerShift: number;
  shiftsPerDay: number;
  timezone: string;
} | undefined {
  if (profile !== "client_2x11_no_weekends") return undefined;
  return {
    weekendDays: [],
    hoursPerShift: 11,
    shiftsPerDay: 2,
    timezone: "Asia/Krasnoyarsk",
  };
}

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
const SHIFT_PROFILES = new Set<ShiftProfile>(["client_2x11_no_weekends", "excel_current", "doc1_7plus1"]);
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

export function nmckAtOrBelowCostWarning(policy: NmckAtOrBelowCostPolicy): string {
  const decision = "Отказ автоматически не ставится: решение об участии принимает директор.";
  const reason = "НМЦК не выше полной себестоимости (прямые, накладные и непредвиденные). При такой предельной цене работы неэффективны: цена не покрывает себестоимость.";
  if (policy === "block") {
    return `${reason} Политика компании — не продолжать подачу, пока цифры не разойдутся. ${decision}`;
  }
  return `${reason} Это предупреждение. ${decision}`;
}

/** Official lines when they exist. Otherwise the customer-estimate reprice, so a filled package is not shown as zero. */
export function displayedEconomicsSummary<T extends { method?: string; C0?: number }>(
  official: T | null | undefined,
  reference: T | null | undefined,
): T | null | undefined {
  const officialEmpty = !official || (official.method ?? "").includes("no-commercial-rows") || !((official.C0 ?? 0) > 0);
  if (officialEmpty && reference && (reference.C0 ?? 0) > 0) return reference;
  return official;
}

export function committeeValueText(value: number | null | undefined, money = false): string {
  if (value == null || !Number.isFinite(value)) return COMMITTEE_UNSET;
  return money ? formatMoney(value) : String(value);
}
