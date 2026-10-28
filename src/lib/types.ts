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
}

export interface User {
  id: string;
  email: string;
  password?: string;
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
  gprId?: string;
  moneyId?: string;
  planFactId?: string;
  tags: string[];
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
  page: number;
  sourceFile: string;
}

export interface Highlight {
  id: string;
  text: string;
  reason: string;
  severity: "info" | "warning" | "critical";
  page: number;
}

export interface DocumentItem {
  id: string;
  orgId: string;
  procurementId: string;
  title: string;
  fileName: string;
  fileType: "pdf" | "docx" | "xlsx";
  status: CardStatus;
  versions: DocVersion[];
  analyticalNote: string;
  citations: Citation[];
  highlights: Highlight[];
  uploadedBy: string;
  uploadedAt: string;
  storedPath?: string;
  fileSize?: number;
}

export interface CalcPosition {
  id: string;
  code: string;
  name: string;
  unit: string;
  quantity: number;
  rate: number;
  normId?: string;
  priceId?: string;
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
}

export interface GprStage {
  id: string;
  name: string;
  start: string;
  end: string;
  sequence: number;
  dependsOn?: string;
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
  type: "normy" | "rascenki" | "ceny" | "profil";
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
}
