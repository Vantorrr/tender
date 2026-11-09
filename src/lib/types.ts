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
  generatedAt: string;
  method: string;
  disclaimer: string;
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
  title: string;
  customer: string;
  region: string;
  nmck: number;
  deadline: string;
  source: string;
  status: CardStatus;
  reviewStatus: ReviewStatus;
  syncStatus: "aktualno" | "ustarelo" | "oshibka_sinhronizacii";
  syncAt: string;
  duplicateOf?: string;
  attachments: { id: string; name: string; type: string; size: string }[];
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
  wonAt?: string;
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
export interface SupplyRequest {
  id: string;
  orgId: string;
  procurementId: string;
  workName?: string;
  materialName: string;
  unit: string;
  qtyNeed: number;
  qtyOrdered: number;
  qtyDelivered: number;
  needBy: string;
  status: SupplyStatus;
  /** Текст запроса КП — только черновик, без send. */
  quoteDraftText?: string;
  supplierNote?: string;
  unitPrice?: number | null;
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
  fileType: "pdf" | "docx" | "xlsx" | "zip" | "other";
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
  }>;
  /** Visible archive / parse failures — never silent. */
  extractionErrors?: string[];
  extractedFiles?: Array<{ name: string; size: number; relativePath: string }>;
}

export interface CalcPosition {
  id: string;
  /** Stable link from an editable draft position back to its GPR resource. */
  sourceResourceId?: string;
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
  normId?: string;
  priceId?: string;
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
  status: "matched" | "diff" | "only_original" | "only_draft";
  reason: string;
  source: "customer_original" | "resource_draft" | "both";
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
  /** Optional link to plan/fact or calc work name. */
  workName?: string;
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
}

export interface MoneyPayment {
  id: string;
  type: "avans" | "postuplenie" | "klyuchevoy";
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
}

export interface ContractPnl {
  /**
   * Physical volume index (sum of quantities) — NOT money.
   * Kept as earnedValue for backward-compatible field name in storage.
   */
  earnedValue: number;
  /** Auto economics from volumes×confirmed rates (null if incomplete). */
  economicsAuto?: number | null;
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
}
