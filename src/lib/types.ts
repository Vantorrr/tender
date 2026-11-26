import type { EconomicsLineKey, EconomicsManual } from "@/lib/client-economics";
import type { TenderLogicSettings } from "@/lib/tender-logic-settings";

export type Role =
  | "superadmin"
  | "rukovoditel"
  | "tender"
  | "smetchik"
  | "otvetstvennyy"
  | "admin";

export type CardStatus =
  | "zagruzheno"
  | "v_rabote"
  | "gotovo"
  | "trebuet_proverki"
  | "oshibka";

export type ReviewStatus =
  | "novaya"
  | "na_rassmotrenii"
  | "odobrena"
  | "otklonena"
  | "dublirovana";

export type SectionKey =
  | "zakupki"
  | "dokumenty"
  | "raschety"
  | "gpr"
  | "dengi"
  | "riski"
  | "proizvodstvo"
  | "spravochniki"
  | "polzovateli"
  | "admin"
  | "instrukciya"
  | "obmen";

export interface Organization {
  id: string;
  name: string;
  inn: string;
  active: boolean;
  /** Shareable join code for self-registration (not a privilege token). */
  joinCode?: string;
  /** Optional company rules. Missing fields use the module defaults. */
  tenderLogic?: Partial<TenderLogicSettings>;
}

export interface SupplierDirectoryEntry {
  id: string;
  orgId: string;
  name: string;
  email: string;
  materialKeywords: string[];
  regions: string[];
  website?: string;
  note?: string;
  /** User who added the supplier. Missing on older rows. */
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationCompanyCard {
  orgId: string;
  fileName: string;
  storedPath: string;
  fileSize: number;
  uploadedAt: string;
  uploadedBy: string;
}

export interface User {
  id: string;
  email: string;
  password?: string;
  /** scrypt salt:hash. Никогда не отдаётся клиенту. */
  secretKeyHash?: string;
  /** Только в сиде до хеширования. В базе не хранится. */
  secretKey?: string;
  /** Признак для клиента: ключ выдан. Сам ключ не хранится. */
  hasSecretKey?: boolean;
  name: string;
  role: Role;
  orgId: string;
  blocked: boolean;
  sections: SectionKey[];
  createdAt: string;
}

export interface RoleHistoryEntry {
  id: string;
  userId: string;
  fromRole: Role | null;
  toRole: Role;
  changedBy: string;
  at: string;
  comment: string;
}

export interface NotificationItem {
  id: string;
  userId: string;
  title: string;
  body: string;
  read: boolean;
  at: string;
  href?: string;
}

export type ProjectChatScreen = "procurement" | "calculation" | "gpr" | "production";

export interface ProjectChatSource {
  id: string;
  label: string;
  quote: string;
  href?: string;
}

export interface ProjectChatMessage {
  id: string;
  orgId: string;
  procurementId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  screen: ProjectChatScreen;
  sources?: ProjectChatSource[];
  createdAt: string;
}

export type WorkTypeCode =
  | "дорожные"
  | "общестрой"
  | "инженерные сети"
  | "благоустройство"
  | "спецработы"
  | "прочее";

export type ParticipateRecommendation =
  | "participate"
  | "do_not_participate"
  | "insufficient_data";

export interface ProjectAnalytics {
  recommendation: ParticipateRecommendation;
  summary: string;
  missingInputs: string[];
  citationIds: string[];
  citations: Citation[];
  /** Short, source-validated conclusions; raw source excerpts stay secondary in the UI. */
  findings?: Array<{
    topic: string;
    importance: "critical" | "high" | "medium" | "info";
    text: string;
    quote: string;
    citationIds: string[];
    sourceFiles: string[];
    /** Effect on cost, or «не указано в документах» when the quote has no figure. */
    costImpact?: string;
    /** Effect on schedule, or «не указано в документах» when the quote has no figure. */
    scheduleImpact?: string;
  }>;
  /** Questions for the customer. Numbers are kept only when they appear in a source. */
  customerQuestions?: string[];
  generatedAt: string;
  /** Older cards may store the memo clock here instead of generatedAt. */
  updatedAt?: string;
  method: string;
  disclaimer: string;
  /** Set when the model call failed. Exact prefix: «ИИ-анализ не выполнен:». */
  aiFailure?: string;
  /** Model id that answered this memo. Readiness is a rule gate, not this model's score. */
  answeredByModel?: string;
  /** Who wrote the current memo. A local сводка is not a model memo. */
  memoSource?: "model" | "local";
  /** Document-set hash of the last successful package analysis. */
  sourceDocumentHash?: string;
  /** The model memo no longer matches the files. Stays until a new model analysis. */
  memoStale?: boolean;
  /** Source coverage and evidence validation; this is not an accuracy percentage. */
  quality?: {
    status: "insufficient_sources" | "needs_review" | "evidence_backed";
    sourceDocuments: number;
    requiredDocumentsFound: number;
    citationCount: number;
    acceptedClaims?: number;
    rejectedClaims?: number;
  };
  /** Same-procurement cost model, separate from customer-estimate values. */
  economics?: {
    cost: number | null;
    priceExVat: number | null;
    priceWithVat: number | null;
    profit: number | null;
    profitabilityPercent: number | null;
    revenueMarginPercent: number | null;
    complete: boolean;
    /** Draft rows without a company rate. Zero cost with a positive count is not 0 ₽. */
    missingRates?: number;
    missingInputs: string[];
  };
}

export type ProjectLifecycle =
  | "procurement"
  | "calculation"
  | "won"
  | "production"
  | "closed";

export interface Procurement {
  id: string;
  orgId: string;
  number: string;
  externalId?: string;
  title: string;
  customer: string;
  region: string;
  nmck: number | null;
  deadline: string;
  source: string;
  /** External source card link; opens the original procurement source. */
  sourceUrl?: string;
  status: CardStatus;
  reviewStatus: ReviewStatus;
  syncStatus: "aktualno" | "ustarelo" | "oshibka_sinhronizacii";
  syncAt: string;
  duplicateOf?: string;
  attachments: {
    id: string;
    name: string;
    type: string;
    size: string;
    sourceUrl?: string;
  }[];
  objectId?: string;
  documentIds: string[];
  calculationId?: string;
  /** Immutable customer estimate calc id (if separated from editable draft). */
  originalCalculationId?: string;
  gprId?: string;
  moneyId?: string;
  planFactId?: string;
  tags: string[];
  workType?: WorkTypeCode | string;
  analytics?: ProjectAnalytics;
  createdAt: string;
  lifecycle?: ProjectLifecycle;
  lifecycleOutcome?: "successful" | "not_realized";
  closedAt?: string;
  wonAt?: string;
  /** Answers kept on the procurement. They are not emailed. */
  customerAnswers?: Array<{ question: string; answer: string; at: string; authorId?: string; authorName?: string }>;
  /** Materials / supply cycle (need → quote draft → delivery) — no auto-send. */
  supplyRequestIds?: string[];
}

export type SupplyStatus =
  | "need"
  | "quoted_draft"
  | "ordered"
  | "in_transit"
  | "delivered"
  | "accepted"
  | "cancelled";

/** Потребность → КП-черновик (не отправка) → поставка/факт. */
export interface SupplierQuote {
  id: string;
  supplierName: string;
  supplierEmail?: string;
  unitPrice: number;
  deliveryDays?: number | null;
  note?: string;
  receivedAt: string;
}

export interface SupplyRequest {
  id: string;
  orgId: string;
  procurementId: string;
  workName?: string;
  source?: "gpr" | "estimate" | "manual";
  sourceFiles?: string[];
  quantityNeedsReview?: boolean;
  materialName: string;
  unit: string;
  qtyNeed: number;
  qtyOrdered: number;
  qtyDelivered: number;
  needBy: string;
  status: SupplyStatus;
  /** Текст запроса КП — только черновик, без send. */
  quoteDraftText?: string;
  supplierName?: string;
  supplierEmail?: string;
  supplierNote?: string;
  supplierIds?: string[];
  sentToSupplierIds?: string[];
  unitPrice?: number | null;
  /** Several supplier offers for comparison; legacy supplier fields mirror the selected quote. */
  quotes?: SupplierQuote[];
  selectedQuoteId?: string;
  /** User who created the need. Missing on older rows. */
  createdBy?: string;
  updatedAt: string;
  createdAt: string;
}

export interface DocVersion {
  id: string;
  version: number;
  authorId: string;
  at: string;
  note: string;
}

export interface Citation {
  id: string;
  text: string;
  /** PDF page (1-based). For XLSX may be 1. */
  page: number;
  sourceFile: string;
  /** XLSX worksheet name when applicable. */
  sheet?: string;
  /** A1-style cell or range, e.g. G10 or G10:G11. */
  cell?: string;
  /** DOCX paragraph index (1-based) when applicable. */
  paragraph?: number;
  /** Source document / directory version id when known. */
  sourceVersion?: string;
  /** Honest confidence: confirmed from parse vs needs human check. */
  confidence?: "confirmed" | "ocr" | "heuristic" | "unconfirmed";
}

export interface Highlight {
  id: string;
  text: string;
  reason: string;
  severity: "info" | "warning" | "critical";
  page: number;
}

export interface DocumentAnalysis {
  vendor: string;
  region: string;
  zone: string;
  estimateNumber: string;
  workName: string;
  basis: string;
  priceLevel: string;
  costThousand: number | null;
  positionCount: number;
  profileMatch: boolean;
  /** Идентификатор модели, если записку сформулировала она. Цифры при этом из файла. */
  narrator?: string;
}

export type DocumentCategory =
  | "general"
  | "estimate"
  | "contract"
  | "tz"
  | "archive"
  | "other";

export interface DocumentItem {
  id: string;
  orgId: string;
  procurementId: string;
  title: string;
  fileName: string;
  fileType: "pdf" | "doc" | "docx" | "xlsx" | "zip" | "other";
  category?: DocumentCategory;
  status: CardStatus;
  versions: DocVersion[];
  analyticalNote: string;
  citations: Citation[];
  highlights: Highlight[];
  uploadedBy: string;
  uploadedAt: string;
  storedPath?: string;
  fileSize?: number;
  analysis?: DocumentAnalysis;
  /** Parsed customer estimate rows; kept as a read-only source snapshot. */
  estimatePositions?: Array<{
    id: string;
    code: string;
    name: string;
    unit: string;
    quantity: number;
    rate: number;
    /** Estimate work line used as a GPR task volume, not a resource count. */
    isWorkItem?: boolean;
    /** Original PDF/XLSX row was recognized, but its source rate was not. */
    rateMissing?: boolean;
    resourceKind?: "labor" | "equipment" | "material" | "bus" | "other";
    sectionName?: string;
    workName?: string;
  }>;
  /** Model note or package pass failed; local parse is kept. */
  aiFailure?: string;
  /** Visible archive / parse failures — never silent. */
  extractionErrors?: string[];
  extractedFiles?: Array<{ name: string; size: number; relativePath: string }>;
}

export interface CalcPosition {
  id: string;
  /** Stable link from an editable draft position back to its GPR resource. */
  sourceResourceId?: string;
  /** Original uploaded estimate row; draft pricing is always resolved separately. */
  sourceDocumentId?: string;
  sourcePositionId?: string;
  /** Parsed Grand Smeta section used to seed the draft GPR hierarchy. */
  sourceSectionName?: string;
  /** Parsed parent work item used to nest resources under a work row. */
  sourceWorkName?: string;
  /** Explicit GPR phase assigned by import rules; kept separate from the estimate work name. */
  sourceStageName?: string;
  /** Estimate work line used as a task volume, not a priced resource. */
  isWorkItem?: boolean;
  /** Directory version used for a name-and-unit rate match. */
  rateSourceDirectoryId?: string;
  /** Where the current rate came from. A schedule fallback is not a directory row. */
  rateBasis?: "directory" | "person_hour";
  code: string;
  name: string;
  unit: string;
  quantity: number;
  rate: number;
  /**
   * When true, `rate` is a non-authoritative placeholder (often 0).
   * Confirmed totals must exclude this line — missing rate ≠ 0 ₽.
   */
  rateMissing?: boolean;
  resourceKind?: GprStageResource["kind"];
  normId?: string;
  priceId?: string;
  /**
   * commercial — our row (manual, volume sheet). It feeds Calculation.costSummary.
   * customer_source — imported estimate identity (code, name, unit, quantity).
   * The customer rate is not copied. A directory rate is only for the reference reprice.
   * Missing costRole keeps the previous path and still feeds the official total.
   */
  costRole?: "commercial" | "customer_source";
  /**
   * Volume-sheet confirmation. Absent on rows that are not a VOR line.
   * A missing value is shown as unconfirmed and is not written on read.
   */
  volumeStatus?: "unconfirmed" | "confirmed";
  /** Quote written into this commercial rate. Absent means no quote is applied. */
  selectedQuoteId?: string;
  /** Supplier name shown next to a rate taken from a quote. */
  quoteSupplierName?: string;
  /** Rate before the quote was applied. Restored by «Сбросить выбор КП». */
  baseRate?: number;
  /** quote — the rate is the chosen quote. manual — base or hand-typed rate. */
  priceSource?: "quote" | "manual";
}

export type CalculationKind = "customer_original" | "resource_draft";

export interface CalcChangeEntry {
  id: string;
  at: string;
  actorId: string;
  detail: string;
}

export interface CalcCompareRow {
  code: string;
  name: string;
  unit: string;
  originalQty: number | null;
  draftQty: number | null;
  originalRate: number | null;
  draftRate: number | null;
  originalSum: number | null;
  draftSum: number | null;
  deltaSum: number | null;
  status: "matched" | "diff" | "incomplete" | "only_original" | "only_draft";
  reason: string;
  source: "customer_original" | "resource_draft" | "both";
  sectionName?: string;
  workName?: string;
}

export interface Calculation {
  id: string;
  orgId: string;
  procurementId: string;
  title: string;
  status: CardStatus;
  positions: CalcPosition[];
  assumptions: string[];
  scenario: "bazovyy" | "optimisticheskiy" | "pessimisticheskiy";
  scenarioFactor: number;
  participateDecision: "uchastvovat" | "otkaz" | "na_rassmotrenii" | null;
  directoryVersionId: string;
  version: number;
  authorId: string;
  updatedAt: string;
  /** customer_original is immutable; resource_draft is editable. */
  kind?: CalculationKind;
  immutable?: boolean;
  /** Link draft ↔ original within same procurement. */
  pairedCalculationId?: string;
  /**
   * Old formula on customer_source rows only: estimate quantities × company rates
   * and the 43/40 economics. Not a cost and not Calculation.costSummary.
   */
  referenceReprice?: CostSummarySnapshot;
  /** Four decision figures. Margins stay null until the company sets a rule. */
  committeeSnapshot?: {
    nmck: number | null;
    /** Confirmed official commercial total. Never the reference reprice. */
    fullCost: number | null;
    targetMarginPercent: number | null;
    floorMarginPercent: number | null;
    nmckVsCost: "unknown" | "above_cost" | "at_or_below_cost";
  };
  changeLog?: CalcChangeEntry[];
  dataFlags?: string[];
  /** Northern / economic inputs — confirmed parameters only. */
  northern?: {
    applicable: boolean;
    confirmedItems: Array<{
      id: string;
      name: string;
      status: "known" | "clarify" | "scenario";
      amount: number | null;
      basis: string;
    }>;
    notes: string[];
  };
  costSummary?: CostSummarySnapshot;
  /** Separately confirmed office overhead; not folded into Excel V/W/Z. */
  officeOverhead?: number;
  /** Explicitly configured VAT rate; null means tax basis is not confirmed. */
  vatPercent?: number | null;
  /**
   * Excel «Ресурсный_график» B4–B9 style params when used.
   * profitMarkupOnCostWithOh is markup on (D+НР), not revenue margin.
   */
  resourceScheduleParams?: {
    personHourRate: number;
    personnelShiftsPerDay: number;
    hoursPerShift: number;
    equipmentShiftsPerDay: number;
    overheadRate: number;
    profitMarkupOnCostWithOh: number;
    districtCoefficient?: number;
    northernPayrollShare?: number;
  };
  /**
   * User corrections of overhead, contingency and profit.
   * A later recalculation keeps them until the user resets the line.
   */
  economicsManual?: EconomicsManual;
  /**
   * Person responsible for assembling the calculation.
   * Default is the tender engineer of the organisation, otherwise the creator.
   * Other roles in the same organisation may still edit.
   */
  ownerUserId?: string;
  ownerRole?: Role;
  /** Last person who edited the draft. Not a visa and not a lock. */
  lastEditorId?: string;
  lastEditorName?: string;
  lastEditedAt?: string;
  /**
   * Director's choice when the NMCK does not cover full cost.
   * Stored separately from participateDecision. Never an automatic refusal.
   */
  directorDecision?: {
    choice: "participate" | "revise_markup" | "decline";
    comment: string;
    authorId: string;
    authorName: string;
    at: string;
  };
  busRoutes?: Array<{
    people: number;
    seats: number;
    distanceKmOneWay: number;
    roundTrip: boolean;
    idleKm: number;
    fuelPer100Km: number;
    fuelLitersPerHour?: number;
    fuelPricePerLiter: number;
    driverShiftCost: number;
    driverIncludedInTariff: boolean;
    tariffPerMachineHour?: number | null;
    tariffPerShift: number | null;
    tariffBasis?: "schedule_fixed" | "tariffs_sheet_full" | "unspecified";
    ownershipMode: "rent" | "own" | "none";
    days: number;
    hoursPerShift?: number;
    shiftsPerDay?: number;
    quantity?: number;
    costingMode?: "machine_hour_full_tariff" | "route_decompose";
  }>;
}

export type GprDependencyType = "FS" | "SS" | "FF" | "SF";

/**
 * How `quantity` is interpreted for Excel Q = L×N×O×P.
 * - count_per_shift: L = headcount/machines; need hours/shifts/days
 * - total_hours: L already = hours (маш-ч / н-ч); N=O=P identity 1
 * - material_qty: materials — R=qty×rate, never contributes to Q-hours
 * - uncertain: unit basis unknown — do not invent N/O/P or zero the line
 */
export type ResourceQuantityBasis =
  | "count_per_shift"
  | "total_hours"
  | "material_qty"
  | "uncertain";

export interface GprStageResource {
  id: string;
  /** Stable source row key used to make client workbook imports repeatable. */
  sourceKey?: string;
  kind: "labor" | "equipment" | "material" | "bus" | "other";
  name: string;
  quantity: number;
  unit: string;
  /** Confirmed unit rate; null/undefined = нет данных (не считать как 0 ₽). */
  rate?: number | null;
  /** Optional explicit basis; otherwise inferred from unit/kind. */
  quantityBasis?: ResourceQuantityBasis;
  /** N — hours per shift (count_per_shift). */
  hoursPerShift?: number | null;
  /** O — shifts per day. */
  shiftsPerDay?: number | null;
  /** P — participation days. */
  days?: number | null;
}

export interface GprStage {
  id: string;
  name: string;
  /** Parent estimate section for a work-level stage. */
  sectionName?: string;
  start: string;
  end: string;
  sequence: number;
  dependsOn?: string;
  dependencyType?: GprDependencyType;
  lagDays?: number;
  crewSize?: number;
  hoursPerShift?: number;
  shiftsPerDay?: number;
  laborHours?: number;
  resources?: GprStageResource[];
  /**
   * Confirmed plan volume for this stage (physical units).
   * null/undefined = нет данных → не подменять выдуманной кривой;
   * allocatePlanForSlice uses stage volumes when any are set.
   */
  planVolume?: number | null;
  /** Unit of the physical work volume when imported from an estimate. */
  planUnit?: string;
  /** Optional link to plan/fact or calc work name. */
  workName?: string;
  /** A GPR stage can cover several production work types. */
  workNames?: string[];
  /** User who added this stage. Older stages fall back to the schedule author. */
  createdBy?: string;
  /**
   * How the stage length was chosen.
   * output_shift — catalog output per 11h shift.
   * site_daily — a file-4 daily norm.
   * unconfirmed — no single output; the TZ window is not sliced into this stage.
   * Absent on schedules saved before this field existed.
   */
  durationBasis?: "output_shift" | "site_daily" | "unconfirmed";
  /** Exact days from the output formula. The calendar end is the ceiling of this. */
  durationDays?: number | null;
  /** Numerator of the duration formula, in the same units as the output norm. */
  formulaVolume?: number | null;
  /** formulaVolume per physical unit. Kept when the volume is set back to zero. */
  formulaPerPhysical?: number | null;
  /** VOR rows that supplied this stage volume. An estimate work line does not set this. */
  volumeRowIds?: string[];
  /** Which quantity built the duration. An estimate line is not rescaled by a VOR edit. */
  volumeSource?: "vor" | "estimate";
  outputPerShift11h?: number | null;
  /** File-4 output of the stated crew for one day. Not a per-shift figure. */
  dailyOutput?: number | null;
  statedLinks?: number | null;
  statedShifts?: number | null;
  mechanismCount?: number | null;
  /** Shifts used in the duration formula. Resource costing still uses shiftsPerDay. */
  durationShifts?: number | null;
  /** GESN / estimate hours. A hint only: they do not set start or end. */
  gesnHoursHint?: number | null;
  benchmarkSource?: string | null;
  benchmarkCrew?: Array<{ role: string; count: number; kind: "labor" | "equipment" }>;
}

export interface WorkCalendar {
  weekendDays: number[];
  hoursPerShift: number;
  shiftsPerDay: number;
  timezone: string;
}

export interface GprSchedule {
  id: string;
  orgId: string;
  procurementId: string;
  calculationId: string;
  title: string;
  status: CardStatus;
  stages: GprStage[];
  version: number;
  authorId: string;
  updatedAt: string;
  calendar?: WorkCalendar;
  conflicts?: string[];
  /** User-visible assumptions / unconfirmed scaffold inputs. */
  assumptions?: string[];
  /**
   * TZ window kept as a deadline check.
   * Stage lengths are not a slice of this window.
   * Absent means the saved schedule had no parsed deadline.
   */
  deadline?: { start: string; end: string } | null;
}

export interface MoneyPayment {
  id: string;
  type: "avans" | "postuplenie" | "klyuchevoy" | "spisanie";
  title: string;
  amount: number;
  date: string;
  week: number;
  month: number;
  note?: string;
}

export interface MoneyPlan {
  id: string;
  orgId: string;
  procurementId: string;
  title: string;
  status: CardStatus;
  payments: MoneyPayment[];
  updatedAt: string;
}

export interface RiskRemark {
  id: string;
  text: string;
  sourceExcerpt: string;
  status: "otkryto" | "v_rabote" | "zakryto" | "prinyato";
  decision?: string;
  severity: "low" | "medium" | "high";
}

export interface RiskRegistry {
  id: string;
  orgId: string;
  procurementId: string;
  title: string;
  status: CardStatus;
  remarks: RiskRemark[];
  contractParsed: boolean;
  /** How the latest contract review was produced. */
  reviewLabel?: string;
  updatedAt: string;
}

export interface PlanFactEntry {
  id: string;
  workName: string;
  unit: string;
  plan: number;
  fact: number;
  /** Contract remaining volume (physical), not cash. */
  contractRemaining?: number;
}

export interface DailyFactPhoto {
  id: string;
  fileName: string;
  storedPath?: string;
  at: string;
  caption?: string;
}

export interface DailyResourceLine {
  kind: "labor" | "material" | "equipment" | "bus" | "other";
  /** Stable link to the GPR resource and editable draft position, when sourced from GPR. */
  sourceResourceId?: string;
  name: string;
  unit: string;
  /** Plan qty from GPR/resources for the day (sourced). */
  planQty: number;
  /** Fact qty entered on site; null = нет данных. */
  factQty: number | null;
}

export interface DailyFact {
  id: string;
  date: string;
  workName: string;
  unit: string;
  quantity: number;
  people?: number;
  equipment?: string;
  materialsNote?: string;
  /** Plan/fact lines for people & materials on the day (t25u day details). */
  resourceLines?: DailyResourceLine[];
  comment?: string;
  photos: DailyFactPhoto[];
  authorId: string;
  at: string;
  /** Plan row this fact belongs to. Name matching is only a fallback for older rows. */
  entryId?: string;
  /** Hidden together with its work row. A new row with the same name does not pick these up. */
  archived?: boolean;
}

export interface ContractPnl {
  /**
   * Physical volume index (sum of quantities) — NOT money.
   * Kept as earnedValue for backward-compatible field name in storage.
   */
  earnedValue: number;
  /** Auto economics from volumes×confirmed rates (null if incomplete). */
  economicsAuto?: number | null;
  /** Value of physical fact using customer estimate rates; not an act or recognized revenue. */
  valueOfFactByCustomerEstimate?: number | null;
  /** Estimated remaining value using customer estimate rates; not a cash forecast. */
  remainingValueByCustomerEstimate?: number | null;
  customerEstimateIncomplete?: string[];
  /** Confirmed incurred costs (₽); may follow auto unless manual. */
  incurredCosts: number;
  /** True when user manually overrode incurredCosts. */
  incurredManual?: boolean;
  /** Cash in (₽). */
  cashIn: number;
  /** Cash out (₽). */
  cashOut: number;
  /** Recognized revenue if set; else null = нет данных. */
  recognizedRevenue: number | null;
  /** Missing rates / inputs for economics. */
  incomplete?: string[];
  notes: string[];
}

export interface PlanFact {
  id: string;
  orgId: string;
  objectId: string;
  procurementId?: string;
  title: string;
  status: CardStatus;
  entries: PlanFactEntry[];
  updatedAt: string;
  /** Frozen baseline snapshot of entries at win/transfer. */
  baselineEntries?: PlanFactEntry[];
  baselineAt?: string;
  dailyFacts?: DailyFact[];
  pnl?: ContractPnl;
  periodPlan?: number;
  monthPlan?: number;
}

export interface CostSummarySnapshot {
  C0: number;
  C: number;
  reserve: number;
  profit: number;
  priceExVat: number;
  vatAmount: number | null;
  priceIncVat: number | null;
  method: string;
  incomplete: string[];
  /** When true, C0/price must not be presented as a complete confirmed total. */
  totalsIncomplete?: boolean;
  at: string;
  /**
   * Excel Ресурсный_график slices (S/T/U → V/W/X/Y/Z) from the unified tree.
   * Present when method includes resource-schedule / unified-tree.
   */
  resourceSlices?: {
    materials: number;
    labor: number;
    equipment: number;
    /** V = S+T+U */
    direct: number;
    /** W = V × OH */
    overhead: number;
    /** X = V+W */
    costWithOh: number;
    /** Y = X × markup */
    profit: number;
    /** Z = X+Y */
    total: number;
    /** Q-hours from labor/equipment/bus only — never materials. */
    hours: number;
    knownAmount: number;
    /** True when V is incomplete → W/X/Y/Z are also partial. */
    partial?: boolean;
    skipped?: string[];
  };
  /** Direct costs D used for the overhead percent. */
  direct?: number;
  /** Overhead line (НР). A manual amount replaces the formula line. */
  overhead?: number;
  /** Lines the user overrode. Empty means the formula produced the figure. */
  manualLines?: EconomicsLineKey[];
  /** District coefficient, northern allowance and overhead folded into the stored total. */
  northernAdjustments?: {
    district: number;
    allowance: number;
    overhead: number;
    total: number;
  };
}

export interface ProjectObject {
  id: string;
  orgId: string;
  name: string;
  address: string;
  responsibleId: string;
  status: CardStatus;
}

export interface DirectoryVersion {
  id: string;
  type: "normy" | "rascenki" | "ceny" | "profil" | "park";
  name: string;
  version: number;
  authorId: string;
  at: string;
  current: boolean;
  rows: Record<string, string | number>[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  detail: string;
}

export interface SmetaExchangeVersion {
  id: string;
  orgId: string;
  /** Set when the exchange belongs to one procurement. Deletes match this id, not the name. */
  procurementId?: string;
  name: string;
  at: string;
  authorId: string;
  positionsMapped: number;
  discrepancies: { code: string; ours: number; theirs: number }[];
  confirmed: boolean;
}

export interface AppData {
  organizations: Organization[];
  users: User[];
  roleHistory: RoleHistoryEntry[];
  notifications: NotificationItem[];
  procurements: Procurement[];
  documents: DocumentItem[];
  calculations: Calculation[];
  schedules: GprSchedule[];
  moneyPlans: MoneyPlan[];
  risks: RiskRegistry[];
  planFacts: PlanFact[];
  objects: ProjectObject[];
  directories: DirectoryVersion[];
  auditLog: AuditEntry[];
  smetaExchanges: SmetaExchangeVersion[];
  supplyRequests?: SupplyRequest[];
  suppliers?: SupplierDirectoryEntry[];
  companyCards?: OrganizationCompanyCard[];
  /** Private-by-user project chat history; fetched only through the scoped chat API. */
  projectChatMessages?: ProjectChatMessage[];
}
