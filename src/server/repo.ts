import { DEFAULT_SECTIONS, REVIEW_LABELS } from "@/lib/roles";
import type {
  AppData,
  Calculation,
  CardStatus,
  CostSummarySnapshot,
  DailyFact,
  DocumentItem,
  GprSchedule,
  GprStage,
  GprStageResource,
  MoneyPayment,
  MoneyPlan,
  PlanFact,
  PlanFactEntry,
  ProjectAnalytics,
  ReviewStatus,
  RiskRegistry,
  RiskRemark,
  Role,
  SectionKey,
  SupplyRequest,
  SupplierDirectoryEntry,
  OrganizationCompanyCard,
  SupplierQuote,
  SupplyStatus,
  User,
} from "@/lib/types";
import { matchCompanyDirectoryRate, rateFromRow } from "@/lib/client-dirs";
import { documentSetHash } from "@/server/document-set-hash";
import { modelConfigured } from "@/server/openrouter";
import { canonicalUploadPath, deleteUpload, readUpload, resolveUploadPath } from "@/server/uploads";
import { recentPaymentId } from "@/lib/duplicate-click";
import { supplyNeedKey } from "@/lib/supply-need";
import { paymentAmountError, paymentTypeForSave } from "@/lib/money-payments";
import { buildStagesFromEstimatePositions, calendarDurationDays, GPR_DATES_MISSING, periodFromDocumentText } from "@/lib/estimate-stages";
import {
  GPR_CREW_FROM_FILE4,
  GPR_DURATION_FROM_OUTPUT,
  GPR_GESN_HINT_ONLY,
  GPR_UNCONFIRMED_DURATION,
  applyLeverToStored,
  deadlineView,
  placeByDuration,
  MAX_VOR_VOLUME,
  formulaAfterVolumeChange,
  shiftsForDeadline,
  stageTracksVolumeRow,
  type AccelerationLever,
} from "@/lib/commercial-packages";
import { listShiftOutputCandidates } from "@/server/client-norms";
import { readEstimateNormHours } from "@/server/estimate-norm-hours";
import type { EstimateNormHours } from "@/lib/estimate-norm-hours";
import { COMPANY_RATE_RULE, composeAnalyticalNote, dependencyWouldCycle, inclusiveDays, migratePlanBundle, northernAdditionLines, recognizedRowsPhrase, rowCountGenitive, rowCountNominative, scheduleAfterPredecessor } from "@/lib/wave23";
import {
  applyClientCommercialFormula,
  sanitizeEconomicsOverride,
  type EconomicsManual,
} from "@/lib/client-economics";
import {
  ESTIMATE_ROWS_AS_SOURCE_SHEET,
  GPR_FROM_CUSTOMER_SECTIONS,
  LEGACY_ESTIMATE_SEEDED_COST,
  REFERENCE_REPRICE_NOT_COST,
  buildCommitteeSnapshot,
  calendarForNewSchedule,
  isLegacyEstimateSeededCost,
  positionFeedsOfficialCost,
  resourceParamsForNewCalculation,
  resolveTenderLogicSettings,
  type ShiftProfile,
} from "@/lib/tender-logic-settings";
import {
  findQuoteOnSupplies,
  isCommercialRateLine,
  isDirectorDecisionChoice,
  positionWithoutStaleQuote,
  quoteMatchKey,
  quoteRateMatches,
  quoteUnitPriceError,
  resolveCalculationOwner,
  type DirectorDecisionChoice,
} from "@/lib/wave5-client";
import { aiAnalysisFailureStatus } from "@/lib/ai-status";
import { buildProjectAnalytics } from "@/lib/project-analytics";
import {
  analyzeProjectPackageWithModel,
  buildProjectAnalysisFallback,
  type AnalysisCompanyContext,
} from "@/server/project-analysis-ai";
import {
  bucketsFromPositions,
  busCost,
  runCostEngine,
  shiftStages,
  workingDaysBetween,
  type BusRouteInput,
  type NorthernInputs,
} from "@/lib/cost-engine";
import { assertDeleteAllowed, assertGprWrite, assertOrgAccess, assertSection } from "@/server/acl";
import {
  overheadsFromWorks,
  roundMoney,
  scenarioFactor,
  worksSubtotal,
} from "@/lib/calc-math";
import { stampCitationSourceVersion } from "@/server/grand-smeta";
import { parseContractRisks } from "@/server/contract-risk";
import type { UploadAnalysis } from "@/server/grand-smeta";
import { getDb, mutateAppData, readAppData, resetAppData } from "@/server/db";
import { hashPassword } from "@/server/passwords";
import { createSession, publicUser } from "@/server/auth";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { economicsFromVolumes } from "@/lib/economics-from-rates";
import { ensureStageResources } from "@/lib/gpr-resources";
import {
  gprCoveredDays,
  linkEstimateWorksToStages,
  productionEntriesFromGpr as deriveProductionEntriesFromGpr,
  totalStageCalendarDays,
} from "@/lib/plan-from-gpr";
import { recomputeEntriesFromDaily, sumDailyQty } from "@/lib/plan-fact-agg";
import { buildMaterialNeeds, materialNeedsIncomplete } from "@/lib/materials-need";
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  type ResourceScheduleParams,
} from "@/lib/resource-schedule-model";
import {
  isResourceLinkedDraft,
  patchStageResource,
  stagesForOfficialCost,
  syncDraftFromStages,
} from "@/lib/unified-resource-sync";

export { assertOrgAccess };

function matchingDirectoryRate(
  data: AppData,
  position: { code: string; name: string; unit: string; resourceKind?: string; isWorkItem?: boolean },
  personHourRate?: number | null,
) {
  return matchCompanyDirectoryRate(data.directories, position, { personHourRate });
}

function scheduleHasPopulatedResources(stages: GprStage[] | undefined) {
  return Boolean(
    stages?.some((stage) =>
      stage.resources?.some(
        (resource) => resource.quantity > 0 || resource.rate != null
      )
    )
  );
}

function actorUser(data: AppData, actorId: string): User {
  const u = data.users.find((x) => x.id === actorId);
  if (!u || u.blocked) throw new Error("Пользователь не найден");
  return u;
}

function assertCanManageUsers(actor: User) {
  if (actor.role !== "superadmin" && actor.role !== "admin") {
    throw new Error("Нет доступа к управлению пользователями");
  }
}

function assertCanManageTarget(actor: User, target: User) {
  assertCanManageUsers(actor);
  assertOrgAccess(actor, target.orgId, "пользователя");
  if (actor.role === "admin" && target.role === "superadmin") {
    throw new Error("Нет доступа к учётной записи суперадмина");
  }
}

function keyRole(role: Role) {
  return role === "superadmin" || role === "admin";
}

function audit(
  data: AppData,
  actorId: string,
  action: string,
  entity: string,
  entityId: string,
  detail: string
) {
  data.auditLog.unshift({
    id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    actorId,
    action,
    entity,
    entityId,
    detail,
  });
}

export function getBootstrap(user: User) {
  const data = readAppData();
  const fresh = data.users.find((u) => u.id === user.id);
  if (!fresh || fresh.blocked) {
    throw new Error("Требуется вход");
  }
  const orgId = fresh.orgId;
  const isSuper = fresh.role === "superadmin";
  return {
    user: publicUser(fresh),
    data: {
      ...data,
      users: data.users
        .filter((u) => isSuper || u.orgId === orgId)
        .map((u) => publicUser(u)),
      procurements: data.procurements.filter((p) => p.orgId === orgId),
      supplyRequests: (data.supplyRequests ?? []).filter((s) => s.orgId === orgId),
      suppliers: (data.suppliers ?? []).filter((s) => s.orgId === orgId),
      companyCards: (data.companyCards ?? []).filter((c) => c.orgId === orgId),
      documents: data.documents.filter((d) => d.orgId === orgId),
      calculations: data.calculations.filter((c) => c.orgId === orgId),
      schedules: data.schedules.filter((s) => s.orgId === orgId),
      moneyPlans: data.moneyPlans.filter((m) => m.orgId === orgId),
      risks: data.risks.filter((r) => r.orgId === orgId),
      planFacts: data.planFacts.filter((p) => p.orgId === orgId).map((plan) => ({
        ...plan,
        ...migratePlanBundle(plan),
      })),
      objects: data.objects.filter((o) => o.orgId === orgId),
      notifications: data.notifications.filter((n) => n.userId === fresh.id),
      organizations: isSuper
        ? data.organizations
        : data.organizations.filter((o) => o.id === orgId),
      auditLog: isSuper
        ? data.auditLog
        : fresh.role === "admin"
          ? data.auditLog.filter((a) => {
              const actor = data.users.find((u) => u.id === a.actorId);
              return !actor || actor.orgId === orgId;
            })
          : [],
      smetaExchanges: data.smetaExchanges.filter(
        (s) => isSuper || (s.orgId ?? "org-alfa") === orgId
      ),
      directories: data.directories,
      roleHistory: data.roleHistory.filter((h) =>
        data.users.some(
          (u) => u.id === h.userId && (isSuper || u.orgId === orgId)
        )
      ),
    } satisfies AppData,
  };
}

export function markNotificationRead(userId: string, id: string) {
  return mutateAppData((data) => {
    data.notifications = data.notifications.map((n) =>
      n.id === id && n.userId === userId ? { ...n, read: true } : n
    );
    return data;
  });
}

export function markAllNotificationsRead(userId: string) {
  return mutateAppData((data) => {
    data.notifications = data.notifications.map((n) =>
      n.userId === userId ? { ...n, read: true } : n
    );
    return data;
  });
}

export function setOrganizationShiftProfile(
  actorId: string,
  orgId: string,
  shiftProfile: ShiftProfile,
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    if (actor.role !== "superadmin" && actor.role !== "admin") {
      throw new Error("Нет доступа к настройкам организации");
    }
    assertOrgAccess(actor, orgId, "организации");
    const known = resolveTenderLogicSettings({ tenderLogic: { shiftProfile } }).shiftProfile;
    if (known !== shiftProfile) throw new Error("Неизвестный профиль смен");
    const org = data.organizations.find((item) => item.id === orgId);
    if (!org) throw new Error("Организация не найдена");
    org.tenderLogic = { ...(org.tenderLogic ?? {}), shiftProfile };
    audit(data, actorId, "update", "organization", orgId, `Профиль смен: ${shiftProfile}`);
    return data;
  });
}

export function setOrganizationActive(
  actorId: string,
  orgId: string,
  active: boolean
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    if (actor.role !== "superadmin") {
      throw new Error("Нет доступа к управлению организациями");
    }
    const org = data.organizations.find((o) => o.id === orgId);
    if (!org) throw new Error("Организация не найдена");
    data.organizations = data.organizations.map((o) =>
      o.id === orgId ? { ...o, active } : o
    );
    audit(
      data,
      actorId,
      active ? "activate" : "deactivate",
      "organization",
      orgId,
      active ? "Организация активирована" : "Организация отключена"
    );
    return data;
  });
}

export function createUser(actorId: string, input: Omit<User, "id" | "createdAt">) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertCanManageUsers(actor);
    assertOrgAccess(actor, input.orgId, "организации");
    if (input.role === "superadmin" && actor.role !== "superadmin") {
      throw new Error("Нет доступа к назначению роли суперадмина");
    }
    if (data.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
      throw new Error("Пользователь с таким email уже существует");
    }
    const id = `u-${Date.now()}`;
    const { secretKey: _sk, secretKeyHash: _sh, hasSecretKey: _hk, ...clean } = input;
    void _sk;
    void _sh;
    void _hk;
    data.users.push({
      ...clean,
      password: hashPassword(input.password ?? "Demo123!"),
      id,
      createdAt: new Date().toISOString(),
    });
    data.roleHistory.unshift({
      id: `rh-${Date.now()}`,
      userId: id,
      fromRole: null,
      toRole: input.role,
      changedBy: actorId,
      at: new Date().toISOString(),
      comment: "Создание пользователя",
    });
    audit(data, actorId, "create", "user", id, `Создан ${input.email}`);
    return data;
  });
}

export function updateUser(
  actorId: string,
  id: string,
  patch: Partial<User>
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const target = data.users.find((u) => u.id === id);
    if (!target) throw new Error("Пользователь не найден");
    assertCanManageTarget(actor, target);
    const nextPatch = { ...patch };
    delete nextPatch.secretKey;
    delete nextPatch.secretKeyHash;
    delete nextPatch.hasSecretKey;
    delete nextPatch.id;
    delete nextPatch.role;
    delete nextPatch.orgId;
    delete nextPatch.createdAt;
    if (typeof nextPatch.password === "string" && nextPatch.password) {
      nextPatch.password = nextPatch.password.includes(":")
        ? nextPatch.password
        : hashPassword(nextPatch.password);
    } else {
      delete nextPatch.password;
    }
    data.users = data.users.map((u) =>
      u.id === id ? { ...u, ...nextPatch } : u
    );
    audit(data, actorId, "update", "user", id, "Обновление пользователя");
    return data;
  });
}

export function setUserRole(
  actorId: string,
  userId: string,
  role: Role,
  comment: string
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const current = data.users.find((u) => u.id === userId);
    if (!current) throw new Error("Пользователь не найден");
    assertCanManageTarget(actor, current);
    if (role === "superadmin" && actor.role !== "superadmin") {
      throw new Error("Нет доступа к назначению роли суперадмина");
    }
    data.users = data.users.map((u) => {
      if (u.id !== userId) return u;
      const next: User = { ...u, role, sections: DEFAULT_SECTIONS[role] };
      if (!keyRole(role)) {
        delete next.secretKeyHash;
        delete next.secretKey;
        delete next.hasSecretKey;
      }
      return next;
    });
    data.roleHistory.unshift({
      id: `rh-${Date.now()}`,
      userId,
      fromRole: current.role,
      toRole: role,
      changedBy: actorId,
      at: new Date().toISOString(),
      comment,
    });
    audit(data, actorId, "role_change", "user", userId, comment);
    return data;
  });
}

export function setProcurementReview(
  actorId: string,
  id: string,
  status: ReviewStatus,
  duplicateOf?: string
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.procurements.find((p) => p.id === id);
    if (!item) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, item.orgId, "закупки");
    let resolvedDup = duplicateOf;
    if (status === "dublirovana" && !resolvedDup) {
      const norm = item.number
        .trim()
        .toUpperCase()
        .replace(/-(DUP|AUTO)(\d*)?$/i, "");
      const original = data.procurements.find(
        (p) =>
          p.orgId === item.orgId &&
          p.id !== id &&
          p.reviewStatus !== "dublirovana" &&
          p.number
            .trim()
            .toUpperCase()
            .replace(/-(DUP|AUTO)(\d*)?$/i, "") === norm
      );
      resolvedDup = original?.id ?? item.duplicateOf;
    }
    data.procurements = data.procurements.map((p) =>
      p.id === id
        ? {
            ...p,
            reviewStatus: status,
            duplicateOf:
              status === "dublirovana" ? resolvedDup : undefined,
            tags:
              status === "dublirovana" && !p.tags.includes("дубликат")
                ? [...p.tags, "дубликат"]
                : p.tags,
          }
        : p
    );
    audit(data, actorId, "review", "procurement", id, `Статус: ${REVIEW_LABELS[status]}`);
    return data;
  });
}

export function saveCustomerAnswer(actorId: string, procurementId: string, question: string, answer: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.procurements.find((row) => row.id === procurementId);
    if (!item) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, item.orgId, "закупки");
    const asked = question.trim();
    const text = answer.trim();
    if (!asked || !text) throw new Error("Нужны вопрос и ответ");
    item.customerAnswers = [
      ...(item.customerAnswers ?? []).filter((row) => row.question !== asked),
      { question: asked, answer: text, at: new Date().toISOString(), authorId: actor.id, authorName: actor.name },
    ];
    audit(data, actorId, "update", "procurement", procurementId, "Ответ на вопрос заказчику");
    return data;
  });
}

export function deleteCustomerAnswer(actorId: string, procurementId: string, question: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.procurements.find((row) => row.id === procurementId);
    if (!item) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, item.orgId, "закупки");
    const asked = question.trim();
    if (!asked) throw new Error("Нужен вопрос");
    const saved = (item.customerAnswers ?? []).find((row) => row.question === asked);
    if (!saved) return data;
    assertDeleteAllowed(actor, saved.authorId, "zakupki", "ответ");
    item.customerAnswers = (item.customerAnswers ?? []).filter((row) => row.question !== asked);
    audit(data, actorId, "update", "procurement", procurementId, "Ответ удалён");
    return data;
  });
}

export function updateProcurement(
  actorId: string,
  id: string,
  patch: Record<string, unknown>
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.procurements.find((p) => p.id === id);
    if (!item) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, item.orgId, "закупки");
    const {
      orgId: _o,
      id: _i,
      // Client must not retarget linked calc/GPR/plan ids across tenants.
      originalCalculationId: _orig,
      calculationId: _calc,
      gprId: _gpr,
      planFactId: _pf,
      moneyId: _money,
      documentIds: _docs,
      ...safe
    } = patch;
    void _o;
    void _i;
    void _orig;
    void _calc;
    void _gpr;
    void _pf;
    void _money;
    void _docs;
    data.procurements = data.procurements.map((p) =>
      p.id === id ? { ...p, ...safe } : p
    );
    audit(data, actorId, "update", "procurement", id, "Обновление закупки");
    return data;
  });
}

function rememberUploadPath(paths: Set<string>, storedPath?: string) {
  const canonical = storedPath ? canonicalUploadPath(storedPath) : null;
  if (canonical) paths.add(canonical);
}

function uploadPathsInUse(data: AppData): Set<string> {
  const paths = new Set<string>();
  for (const document of data.documents) rememberUploadPath(paths, document.storedPath);
  for (const card of data.companyCards ?? []) rememberUploadPath(paths, card.storedPath);
  for (const plan of data.planFacts) {
    for (const fact of plan.dailyFacts ?? []) {
      for (const photo of fact.photos ?? []) rememberUploadPath(paths, photo.storedPath);
    }
  }
  return paths;
}

function dailyFactsWithoutPlantedPaths(existing: PlanFact, incoming: DailyFact[]): DailyFact[] {
  const known = new Map<string, string>();
  for (const fact of existing.dailyFacts ?? []) {
    for (const photo of fact.photos ?? []) {
      if (photo.storedPath) known.set(photo.id, photo.storedPath);
    }
  }
  return incoming.map((fact) => ({
    ...fact,
    photos: (fact.photos ?? []).map((photo) => {
      const storedPath = known.get(photo.id);
      if (!storedPath) {
        const { storedPath: _planted, ...rest } = photo;
        void _planted;
        return rest;
      }
      return { ...photo, storedPath };
    }),
  }));
}

export function deleteProcurement(actorId: string, id: string) {
  const removedFiles: string[] = [];
  let deleted = false;
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    if (actor.role !== "superadmin" && actor.role !== "admin" && actor.role !== "rukovoditel") {
      throw new Error("Удалять закупку могут руководитель и администратор");
    }
    assertSection(actor, "zakupki");
    const item = data.procurements.find((p) => p.id === id);
    if (!item) return data;
    assertOrgAccess(actor, item.orgId, "закупки");
    for (const document of data.documents) {
      if (document.procurementId === id && document.storedPath) removedFiles.push(document.storedPath);
    }
    for (const plan of data.planFacts) {
      if (plan.procurementId !== id) continue;
      for (const fact of plan.dailyFacts ?? []) {
        for (const photo of fact.photos ?? []) {
          if (photo.storedPath) removedFiles.push(photo.storedPath);
        }
      }
    }
    data.procurements = data.procurements.filter((p) => p.id !== id);
    data.documents = data.documents.filter((d) => d.procurementId !== id);
    data.calculations = data.calculations.filter((c) => c.procurementId !== id);
    data.schedules = data.schedules.filter((s) => s.procurementId !== id);
    data.moneyPlans = data.moneyPlans.filter((m) => m.procurementId !== id);
    data.risks = data.risks.filter((r) => r.procurementId !== id);
    data.planFacts = data.planFacts.filter((p) => p.procurementId !== id);
    data.supplyRequests = (data.supplyRequests ?? []).filter((s) => s.procurementId !== id);
    data.projectChatMessages = (data.projectChatMessages ?? []).filter((m) => m.procurementId !== id);
    data.smetaExchanges = data.smetaExchanges.filter((s) => !(s.orgId === item.orgId && s.procurementId === id));
    audit(data, actorId, "delete", "procurement", id, "Закупка удалена");
    deleted = true;
    return data;
  });
  if (deleted) {
    const stillUsed = uploadPathsInUse(readAppData());
    for (const storedPath of removedFiles) {
      const canonical = canonicalUploadPath(storedPath);
      if (!canonical || stillUsed.has(canonical)) continue;
      try {
        deleteUpload(canonical);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "ENOENT") throw error;
      }
    }
  }
  return { deleted };
}

export function deleteGprStage(actorId: string, scheduleId: string, stageId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const schedule = data.schedules.find((item) => item.id === scheduleId);
    if (!schedule) throw new Error("ГПР не найден");
    assertOrgAccess(actor, schedule.orgId, "ГПР");
    const stage = schedule.stages.find((item) => item.id === stageId);
    if (!stage) throw new Error("Этап не найден");
    assertDeleteAllowed(actor, stage.createdBy ?? schedule.authorId, "gpr", "этап");
    const removedResourceIds = new Set((stage.resources ?? []).map((resource) => resource.id));
    const removedWorks = new Set(
      [stage.name, stage.workName, ...(stage.workNames ?? [])].map((name) => name?.trim()).filter(Boolean) as string[]
    );
    schedule.stages = schedule.stages
      .filter((item) => item.id !== stageId)
      .map((item) => item.dependsOn === stageId
        ? { ...item, dependsOn: undefined, dependencyType: undefined, lagDays: undefined }
        : item);
    const remainingWorks = new Set(
      schedule.stages.flatMap((item) => [item.name, item.workName, ...(item.workNames ?? [])].filter(Boolean) as string[])
    );
    for (const plan of data.planFacts) {
      if (plan.procurementId !== schedule.procurementId && plan.id !== data.procurements.find((item) => item.id === schedule.procurementId)?.planFactId) continue;
      plan.entries = plan.entries.filter((entry) => !removedWorks.has(entry.workName) || remainingWorks.has(entry.workName));
      plan.dailyFacts = (plan.dailyFacts ?? []).map((fact) => ({
        ...fact,
        resourceLines: fact.resourceLines?.filter((line) => !line.sourceResourceId || !removedResourceIds.has(line.sourceResourceId)),
      }));
      plan.updatedAt = new Date().toISOString();
    }
    const calc = data.calculations.find((item) => item.id === schedule.calculationId);
    if (calc && !calc.immutable) {
      calc.positions = calc.positions.filter((position) => !position.sourceResourceId || !removedResourceIds.has(position.sourceResourceId));
    }
    schedule.updatedAt = new Date().toISOString();
    audit(data, actorId, "delete", "gpr_stage", stageId, `Удалён этап ${stage.name}`);
    return data;
  });
}

export function setStagePredecessor(actorId: string, scheduleId: string, stageId: string, dependsOn: string | null) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertGprWrite(actor);
    const schedule = data.schedules.find((item) => item.id === scheduleId);
    if (!schedule) throw new Error("ГПР не найден");
    assertOrgAccess(actor, schedule.orgId, "ГПР");
    const stage = schedule.stages.find((item) => item.id === stageId);
    if (!stage) throw new Error("Этап не найден");
    if (!dependsOn) {
      stage.dependsOn = undefined;
      stage.dependencyType = undefined;
      schedule.updatedAt = new Date().toISOString();
      return data;
    }
    const predecessor = schedule.stages.find((item) => item.id === dependsOn);
    if (!predecessor) throw new Error("Предшествующая работа не найдена");
    if (dependencyWouldCycle(schedule.stages, stageId, dependsOn)) {
      throw new Error("Нельзя ставить работу после самой себя — получится цикл");
    }
    const next = scheduleAfterPredecessor(predecessor.end, inclusiveDays(stage.start, stage.end));
    stage.dependsOn = dependsOn;
    stage.dependencyType = "FS";
    stage.start = next.start;
    stage.end = next.end;
    schedule.conflicts = [];
    schedule.updatedAt = new Date().toISOString();
    audit(data, actorId, "update", "gpr", scheduleId, `Работа «${stage.name}» начинается после «${predecessor.name}»`);
    return data;
  });
}

export function createManualProcurement(
  actorId: string,
  input: { title: string; customer?: string; region: string; nmck?: number | null; deadline?: string }
) {
  let createdId = "";
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const title = input.title.trim();
    const region = input.region.trim();
    if (!title || !region) throw new Error("Укажите название закупки и регион");
    if (input.nmck != null && (!Number.isFinite(input.nmck) || input.nmck < 0)) {
      throw new Error("НМЦК должна быть неотрицательным числом");
    }
    const now = new Date().toISOString();
    createdId = `p-manual-${crypto.randomUUID()}`;
    data.procurements.unshift({
      id: createdId,
      orgId: actor.orgId,
      number: `РУЧНАЯ-${now.slice(0, 10).replace(/-/g, "")}-${createdId.slice(-6)}`,
      title,
      customer: input.customer?.trim() ?? "",
      region,
      nmck: input.nmck ?? null,
      deadline: input.deadline?.trim() ?? "",
      source: "manual",
      status: "zagruzheno",
      reviewStatus: "novaya",
      syncStatus: "aktualno",
      syncAt: now,
      attachments: [],
      documentIds: [],
      tags: ["Создано вручную"],
      lifecycle: "procurement",
      createdAt: now,
    });
    data.risks.unshift({
      id: `r-${crypto.randomUUID()}`,
      orgId: actor.orgId,
      procurementId: createdId,
      title: `Риски — ${title.slice(0, 48)}`,
      status: "v_rabote",
      contractParsed: false,
      remarks: [],
      updatedAt: now,
    });
    audit(data, actorId, "create_manual", "procurement", createdId, "Создана вручную");
    return data;
  });
  return { id: createdId };
}

function assertEditableCalculation(item: Calculation) {
  if (item.immutable || item.kind === "customer_original") {
    throw new Error(
      "Исходная смета заказчика неизменяема — правьте только собственный черновик"
    );
  }
}

function defaultOwnerFields(data: AppData, orgId: string, creatorId: string) {
  const resolved = resolveCalculationOwner(data.users, orgId, creatorId);
  if (resolved) return { ownerUserId: resolved.userId, ownerRole: resolved.role };
  const creator = data.users.find((user) => user.id === creatorId);
  return { ownerUserId: creatorId, ownerRole: creator?.role ?? ("tender" as Role) };
}

function stampLastEditor(item: Calculation, actor: User) {
  item.lastEditorId = actor.id;
  item.lastEditorName = actor.name;
  item.lastEditedAt = new Date().toISOString();
}

export function updateCalculation(
  actorId: string,
  id: string,
  patch: Partial<Calculation>
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((c) => c.id === id);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    const {
      orgId: _o,
      id: _i,
      immutable: _im,
      kind: _k,
      ownerUserId: _owner,
      ownerRole: _ownerRole,
      referenceReprice: _reference,
      directorDecision: _decision,
      committeeSnapshot: _committee,
      lastEditorId: _editor,
      lastEditorName: _editorName,
      lastEditedAt: _editedAt,
      ...safe
    } = patch;
    void _o;
    void _i;
    void _im;
    void _k;
    void _owner;
    void _ownerRole;
    void _reference;
    void _decision;
    void _committee;
    void _editor;
    void _editorName;
    void _editedAt;
    if (Array.isArray(safe.positions)) {
      safe.positions = safe.positions.map((next) =>
        positionWithoutStaleQuote(item.positions.find((row) => row.id === next.id), next),
      );
    }
    const entry = {
      id: `cl-${Date.now()}`,
      at: new Date().toISOString(),
      actorId,
      detail: "Ручное обновление черновика",
    };
    const editedAt = new Date().toISOString();
    data.calculations = data.calculations.map((c) =>
      c.id === id
        ? {
            ...c,
            ...safe,
            lastEditorId: actor.id,
            lastEditorName: actor.name,
            lastEditedAt: editedAt,
            changeLog: [...(c.changeLog ?? []), entry],
            updatedAt: editedAt,
          }
        : c
    );
    audit(data, actorId, "update", "calculation", id, "Обновление расчёта");
    return data;
  });
}

function selectedQuotePrice(position: Calculation["positions"][number], supplies: AppData["supplyRequests"]): number | null {
  if (position.priceSource !== "quote" && !position.selectedQuoteId) return null;
  const found = position.selectedQuoteId ? findQuoteOnSupplies(supplies ?? [], position.selectedQuoteId) : null;
  if (found) return found.quote.unitPrice;
  return position.quoteUnitPrice ?? null;
}

/** Only the resource this commercial line is linked to. A shared name is not enough. */
function writeQuoteRateOntoSchedule(data: AppData, actor: User, item: Calculation, position: Calculation["positions"][number]) {
  if (!position.sourceResourceId) return;
  const schedule = data.schedules.find((row) => row.calculationId === item.id);
  if (!schedule) return;
  assertOrgAccess(actor, schedule.orgId, "ГПР");
  if (schedule.orgId !== item.orgId) {
    throw new Error("График и расчёт относятся к разным организациям");
  }
  for (const stage of schedule.stages) {
    for (const resource of stage.resources ?? []) {
      if (resource.id === position.sourceResourceId) resource.rate = position.rate;
    }
  }
}

/**
 * Write a chosen supplier quote into a commercial line rate, then rebuild the
 * official 43/10/40 total. Passing a null quote restores the base rate.
 * referenceReprice is put back exactly as it was. Manual economics stay.
 */
export function applyCommercialQuote(
  actorId: string,
  calcId: string,
  positionId: string,
  quoteId: string | null,
) {
  let reference: Calculation["referenceReprice"] | undefined;
  let hadReference = false;
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((row) => row.id === calcId);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    const position = item.positions.find((row) => row.id === positionId);
    if (!position || !isCommercialRateLine(position)) {
      throw new Error("КП записывается только в коммерческую строку");
    }
    hadReference = item.referenceReprice != null;
    reference = item.referenceReprice ? structuredClone(item.referenceReprice) : undefined;
    if (quoteId == null) {
      if (position.priceSource === "quote" || position.selectedQuoteId) {
        const quotePrice = selectedQuotePrice(position, data.supplyRequests);
        if (quoteRateMatches(position.rate, quotePrice)) {
          const base = position.baseRate;
          if (base != null && Number.isFinite(base) && base > 0) {
            position.rate = base;
            position.rateMissing = false;
          } else {
            position.rate = 0;
            position.rateMissing = true;
          }
        }
        position.priceSource = "manual";
        delete position.selectedQuoteId;
        delete position.quoteSupplierName;
        delete position.quoteUnitPrice;
      }
    } else {
      const found = findQuoteOnSupplies(data.supplyRequests ?? [], quoteId);
      if (!found) throw new Error("КП не найдено");
      assertOrgAccess(actor, found.supply.orgId, "КП");
      if (found.supply.orgId !== item.orgId) {
        throw new Error("КП и расчёт относятся к разным организациям");
      }
      if (found.supply.procurementId !== item.procurementId) {
        throw new Error("КП и расчёт относятся к разным закупкам");
      }
      if (found.supply.status === "cancelled") {
        throw new Error("КП относится к закрытой потребности");
      }
      const priceError = quoteUnitPriceError(found.quote.unitPrice);
      if (priceError) throw new Error(priceError);
      if (quoteMatchKey(found.supply.materialName, found.supply.unit) !== quoteMatchKey(position.name, position.unit)) {
        throw new Error("КП не подходит к этой позиции");
      }
      const previousQuote = selectedQuotePrice(position, data.supplyRequests);
      if (!quoteRateMatches(position.rate, previousQuote)) position.baseRate = position.rate;
      position.rate = found.quote.unitPrice;
      position.rateMissing = false;
      position.selectedQuoteId = found.quote.id;
      position.quoteSupplierName = found.quote.supplierName;
      position.quoteUnitPrice = found.quote.unitPrice;
      position.priceSource = "quote";
    }
    if (!item.resourceScheduleParams) {
      item.resourceScheduleParams = {
        personHourRate: 1400,
        personnelShiftsPerDay: 2,
        hoursPerShift: 11,
        equipmentShiftsPerDay: 2,
        overheadRate: 0.43,
        profitMarkupOnCostWithOh: 0.4,
      };
    }
    writeQuoteRateOntoSchedule(data, actor, item, position);
    stampLastEditor(item, actor);
    item.changeLog = [
      ...(item.changeLog ?? []),
      {
        id: `cl-${Date.now()}`,
        at: new Date().toISOString(),
        actorId,
        detail: quoteId == null
          ? `Сброшен выбор КП в строке ${position.name}`
          : `В ставку «${position.name}» записано КП ${position.quoteSupplierName ?? ""}`.trim(),
      },
    ];
    audit(data, actorId, quoteId == null ? "reset_quote" : "apply_quote", "calculation", calcId, position.name);
    return data;
  });
  recomputeCalculationCost(actorId, calcId);
  if (hadReference) {
    mutateAppData((data) => {
      const actor = actorUser(data, actorId);
      const item = data.calculations.find((row) => row.id === calcId);
      if (!item) throw new Error("Расчёт не найден");
      assertOrgAccess(actor, item.orgId, "расчёта");
      item.referenceReprice = reference;
      return data;
    });
  }
}

export function assignCalculationOwner(actorId: string, calcId: string, ownerUserId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((row) => row.id === calcId);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    const owner = data.users.find((user) => user.id === ownerUserId);
    if (!owner || owner.blocked) throw new Error("Пользователь не найден");
    assertOrgAccess(actor, owner.orgId, "пользователя");
    if (owner.orgId !== item.orgId) {
      throw new Error("Ответственного можно назначить только внутри организации расчёта");
    }
    item.ownerUserId = owner.id;
    item.ownerRole = owner.role;
    stampLastEditor(item, actor);
    item.changeLog = [
      ...(item.changeLog ?? []),
      {
        id: `cl-${Date.now()}`,
        at: new Date().toISOString(),
        actorId,
        detail: `Ответственный за сбор: ${owner.name}`,
      },
    ];
    audit(data, actorId, "assign_owner", "calculation", calcId, owner.name);
    return data;
  });
}

export function saveDirectorDecision(
  actorId: string,
  calcId: string,
  input: { choice: DirectorDecisionChoice; comment: string },
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((row) => row.id === calcId);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    if (!isDirectorDecisionChoice(input.choice)) {
      throw new Error("Выберите решение директора");
    }
    const comment = input.comment.trim();
    if (!comment) throw new Error("Укажите комментарий к решению директора");
    if (comment.length > 2000) throw new Error("Комментарий длиннее 2000 знаков");
    item.directorDecision = {
      choice: input.choice,
      comment,
      authorId: actor.id,
      authorName: actor.name,
      at: new Date().toISOString(),
    };
    stampLastEditor(item, actor);
    item.changeLog = [
      ...(item.changeLog ?? []),
      {
        id: `cl-${Date.now()}`,
        at: new Date().toISOString(),
        actorId,
        detail: `Решение директора: ${input.choice}`,
      },
    ];
    audit(data, actorId, "director_decision", "calculation", calcId, input.choice);
    return data;
  });
}

export function recalcCalculation(
  actorId: string,
  id: string,
  scenario: Calculation["scenario"]
) {
  // Arithmetic lives in calc-math (code), not LLM text.
  const factor = scenarioFactor(scenario);
  const summary = { matched: 0, changed: 0 };
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((c) => c.id === id);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    const positions = item.positions.map((p) => {
      if (p.code === "НР" || p.code === "СП" || p.isWorkItem) return p;
      const hit = matchingDirectoryRate(data, p, item.resourceScheduleParams?.personHourRate);
      if (!hit) {
        const next = { ...p, rate: 0, rateMissing: true, rateBasis: undefined, rateSourceDirectoryId: undefined };
        if (p.rate !== 0 || !p.rateMissing || p.rateBasis || p.rateSourceDirectoryId) summary.changed += 1;
        return next;
      }
      summary.matched += 1;
      const next = {
        ...p,
        rate: hit.rate,
        rateMissing: false,
        rateBasis: hit.basis === "person_hour" ? "person_hour" as const : "directory" as const,
        rateSourceDirectoryId: hit.dirId,
      };
      if (p.rate !== next.rate || p.rateMissing || p.rateBasis !== next.rateBasis || p.rateSourceDirectoryId !== next.rateSourceDirectoryId) {
        summary.changed += 1;
      }
      return next;
    });
    // НР/СП from scenario-factored works — same identity as calculationTotals.
    const works = worksSubtotal(positions, factor);
    const { nr, sp } = overheadsFromWorks(works);
    const withExtras = positions.map((p) => {
      if (p.code === "НР") {
        return { ...p, rate: nr, unit: "руб" };
      }
      if (p.code === "СП") {
        return { ...p, rate: sp, unit: "руб" };
      }
      return p;
    });
    const rasc = data.directories.find((d) => d.type === "rascenki" && d.current);
    const prevVersion = item.version ?? 1;
    data.calculations = data.calculations.map((c) =>
      c.id === id
        ? {
            ...c,
            positions: withExtras,
            scenario,
            scenarioFactor: factor,
            directoryVersionId: rasc?.id ?? c.directoryVersionId,
            version: prevVersion + 1,
            status: "trebuet_proverki" as CardStatus,
            updatedAt: new Date().toISOString(),
          }
        : c
    );
    const linkedSchedule = data.schedules.find((schedule) => schedule.calculationId === id);
    for (const position of withExtras) {
      if (!linkedSchedule) break;
      if (position.code === "НР" || position.code === "СП" || position.code === "ВОР" || position.isWorkItem) continue;
      if (!(position.rate > 0) || position.rateMissing) continue;
      if (position.rateBasis !== "directory" && position.rateBasis !== "person_hour") continue;
      for (const stage of linkedSchedule.stages) {
        for (const resource of stage.resources ?? []) {
          const sameResource = position.sourceResourceId != null && position.sourceResourceId === resource.id;
          const sameLine = position.sourceResourceId == null
            && volumeNameKey(resource.name) === volumeNameKey(position.name)
            && normalizeSupplierTerm(resource.unit) === normalizeSupplierTerm(position.unit);
          if (sameResource || sameLine) resource.rate = position.rate;
        }
      }
    }
    audit(
      data,
      actorId,
      "recalc",
      "calculation",
      id,
      `Пересчёт сценария ${scenario} v${prevVersion + 1} по справочнику ${rasc?.id ?? item.directoryVersionId}`
    );
    return data;
  });
  recomputeCalculationCost(actorId, id);
  return summary;
}

export function addCalcPositionFromDirectory(
  actorId: string,
  calcId: string,
  input: {
    type: "rascenki" | "ceny" | "park";
    code: string;
    quantity?: number;
    rateKey?: string;
  }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((c) => c.id === calcId);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    const dir = data.directories.find(
      (d) => d.type === input.type && d.current
    );
    if (!dir) throw new Error("Нет текущей версии справочника");
    const row = dir.rows.find(
      (r) => String(r.code ?? r.sku ?? "") === input.code
    );
    if (!row) throw new Error("Позиция не найдена в справочнике");
    const lookedUp = rateFromRow(row, input.rateKey);
    const rateMissing = lookedUp == null || !Number.isFinite(lookedUp) || lookedUp <= 0;
    const rate = rateMissing ? 0 : lookedUp;
    const pos = {
      id: `cp-${Date.now()}`,
      code: String(row.code ?? row.sku ?? input.code),
      name: String(row.name ?? row.work ?? input.code),
      unit:
        typeof row.unit === "string"
          ? row.unit.replace(/^руб\//, "")
          : "ед.",
      quantity: input.quantity ?? 1,
      rate,
      costRole: "commercial" as const,
      ...(rateMissing ? { rateMissing: true } : {}),
    };
    data.calculations = data.calculations.map((c) =>
      c.id === calcId
        ? {
            ...c,
            positions: [...c.positions.filter((p) => p.code !== "НР" && p.code !== "СП"), pos, ...c.positions.filter((p) => p.code === "НР" || p.code === "СП")],
            directoryVersionId: dir.id,
            updatedAt: new Date().toISOString(),
            status: "trebuet_proverki" as CardStatus,
            changeLog: [
              ...(c.changeLog ?? []),
              {
                id: `cl-${Date.now()}`,
                at: new Date().toISOString(),
                actorId,
                detail: `Добавлена позиция ${pos.code} из справочника (не в нормативную смету заказчика)`,
              },
            ],
          }
        : c
    );
    audit(
      data,
      actorId,
      "add",
      "calculation",
      calcId,
      `Позиция ${pos.code} из ${dir.name}`
    );
    return data;
  });
}

export function updateDocument(
  actorId: string,
  id: string,
  patch: Partial<DocumentItem>
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.documents.find((d) => d.id === id);
    if (!item) throw new Error("Документ не найден");
    assertOrgAccess(actor, item.orgId, "документа");
    const { orgId: _o, id: _i, storedPath: _path, ...safe } = patch;
    void _o;
    void _i;
    void _path;
    const noteEdited =
      typeof safe.analyticalNote === "string" &&
      safe.analyticalNote !== item.analyticalNote;
    data.documents = data.documents.map((d) => {
      if (d.id !== id) return d;
      if (!noteEdited) return { ...d, ...safe };
      const nextVersion = d.versions.length + 1;
      return {
        ...d,
        ...safe,
        versions: [
          ...d.versions,
          {
            id: `dv-${Date.now()}`,
            version: nextVersion,
            authorId: actorId,
            at: new Date().toISOString(),
            note: "Ручная правка аналитической записки",
          },
        ],
      };
    });
    audit(
      data,
      actorId,
      "update",
      "document",
      id,
      noteEdited ? "Ручная правка записки (новая версия)" : "Обновление документа"
    );
    return data;
  });
}

export function reanalyzeDocument(
  actorId: string,
  id: string,
  prepared: UploadAnalysis | null
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.documents.find((d) => d.id === id);
    if (!item) throw new Error("Документ не найден");
    assertOrgAccess(actor, item.orgId, "документа");
    data.documents = data.documents.map((d) => {
      if (d.id !== id) return d;
      const nextVersion = d.versions.length + 1;
      const previousPositions = d.estimatePositions ?? [];
      const reusedPositionIds = new Set<string>();
      const version = {
        id: `dv-${Date.now()}`,
        version: nextVersion,
        authorId: actorId,
        at: new Date().toISOString(),
        note: !prepared
          ? "Файл на сервере не найден, разбор не выполнен"
          : prepared.aiFailure
            ? prepared.aiFailure
          : prepared.noteByModel
            ? `Записка модели ${prepared.analysis.narrator} по цифрам сметы`
            : "Повторный разбор по параметрам ГРАНД-Смета 2022.3",
      };
      if (!prepared) {
        return { ...d, versions: [...d.versions, version] };
      }
      const versionLabel = `doc-v${nextVersion}`;
      const estimatePositions = prepared.positions.map((position, index) => {
        const previous = previousPositions.find((candidate) =>
          !reusedPositionIds.has(candidate.id) &&
          candidate.code === position.code &&
          candidate.name === position.name &&
          candidate.unit === position.unit
        );
        if (previous) reusedPositionIds.add(previous.id);
        return {
          id: previous?.id ?? `source-${id}-v${nextVersion}-${index + 1}`,
          code: position.code,
          name: position.name,
          unit: position.unit,
          quantity: position.quantity,
          rate: position.rate,
          ...(position.isWorkItem ? { isWorkItem: true } : {}),
          ...(position.rateMissing ? { rateMissing: true } : {}),
          ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
          ...(position.sectionName ? { sectionName: position.sectionName } : {}),
          ...(position.workName ? { workName: position.workName } : {}),
        };
      });
      return {
        ...d,
        title: d.title.startsWith("Разбор поставлен") ? prepared.title : d.title,
        status: prepared.status,
        versions: [...d.versions, version],
        analyticalNote: prepared.analyticalNote.trim() ? prepared.analyticalNote : d.analyticalNote,
        citations: stampCitationSourceVersion(prepared.citations, versionLabel),
        highlights: prepared.highlights,
        analysis: prepared.analysis,
        aiFailure: prepared.aiFailure,
        estimatePositions,
        extractionErrors: prepared.positions.length || prepared.citations.length
          ? (d.extractionErrors ?? []).filter((message) => !/формат пока нельзя|формат не анализируется|не анализируется автоматически/i.test(message))
          : d.extractionErrors,
      };
    });
    audit(data, actorId, "reanalyze", "document", id, "Разбор по параметрам ГРАНД-Смета");
    return data;
  });
}

export function createDocument(
  actorId: string,
  input: {
    orgId: string;
    procurementId: string;
    title: string;
    fileName: string;
    fileType: DocumentItem["fileType"];
    category?: DocumentItem["category"];
    storedPath?: string;
    fileSize?: number;
    prepared?: UploadAnalysis;
    extractionErrors?: string[];
    extractedFiles?: DocumentItem["extractedFiles"];
    parentDocumentId?: string;
    archiveMemberPath?: string;
  }
): { documentId: string } {
  let documentId = "";
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertOrgAccess(actor, input.orgId, "документа");
    if (!input.procurementId) {
      throw new Error("Укажите закупку для документа");
    }
    const proc = data.procurements.find((p) => p.id === input.procurementId);
    if (!proc) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, proc.orgId, "закупки");
    const id = `d-${Date.now()}-${randomBytes(4).toString("hex")}`;
    documentId = id;
    const hasExtractErrors = (input.extractionErrors?.length ?? 0) > 0;
    const doc: DocumentItem = {
      id,
      orgId: input.orgId,
      procurementId: input.procurementId,
      title: input.title,
      fileName: input.fileName,
      fileType: input.fileType,
      category: input.category ?? "general",
      status: hasExtractErrors
        ? "oshibka"
        : (input.prepared?.status ?? "v_rabote"),
      versions: [
        {
          id: `dv-${Date.now()}`,
          version: 1,
          authorId: actorId,
          at: new Date().toISOString(),
          note: input.prepared?.aiFailure
            ? input.prepared.aiFailure
            : input.prepared?.noteByModel
            ? `Загрузка. Записка модели ${input.prepared.analysis.narrator} по цифрам сметы`
            : input.prepared
              ? "Загрузка и разбор по параметрам ГРАНД-Смета 2022.3"
              : hasExtractErrors
                ? "Загрузка с ошибками извлечения архива"
                : "Загрузка на сервер",
        },
      ],
      analyticalNote:
        input.prepared?.analyticalNote ??
        (hasExtractErrors
          ? `Файл сохранён. Ошибки извлечения: ${input.extractionErrors!.join("; ")}`
          : "Файл сохранён. Разбор по форме ГРАНД-Смета не дал результата."),
      aiFailure: input.prepared?.aiFailure,
      citations: stampCitationSourceVersion(
        input.prepared?.citations ?? [],
        "doc-v1"
      ).map((citation, index) => ({
        ...citation,
        id: `${id}-${citation.id || index}`,
      })),
      highlights: input.prepared?.highlights ?? [],
      analysis: input.prepared?.analysis,
      estimatePositions: input.prepared?.positions.map((position, index) => ({
        id: `source-${id}-${index + 1}`,
        code: position.code,
        name: position.name,
        unit: position.unit,
        quantity: position.quantity,
        rate: position.rate,
        ...(position.isWorkItem ? { isWorkItem: true } : {}),
        ...(position.rateMissing ? { rateMissing: true } : {}),
        ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
        ...(position.sectionName ? { sectionName: position.sectionName } : {}),
        ...(position.workName ? { workName: position.workName } : {}),
      })),
      uploadedBy: actorId,
      uploadedAt: new Date().toISOString(),
      storedPath: input.storedPath,
      fileSize: input.fileSize,
      extractionErrors: input.extractionErrors,
      extractedFiles: input.extractedFiles,
      ...(input.parentDocumentId ? { parentDocumentId: input.parentDocumentId } : {}),
      ...(input.archiveMemberPath ? { archiveMemberPath: input.archiveMemberPath } : {}),
    };
    data.documents.unshift(doc);
    proc.documentIds = [...proc.documentIds, id];
    proc.attachments = [
      ...proc.attachments,
      {
        id: `att-${id}`,
        name: input.fileName,
        type: input.fileType,
        size:
          input.fileSize != null
            ? `${Math.max(1, Math.round(input.fileSize / 1024))} КБ`
            : "—",
      },
    ];
    audit(data, actorId, "upload", "document", id, `Загружен ${input.fileName}`);
    return data;
  });
  return { documentId };
}

/** Ensure calc/GPR/money/risk/plan-fact exist for a procurement (create stubs). */
export function ensureProcurementChain(actorId: string, procurementId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const p = data.procurements.find((x) => x.id === procurementId);
    if (!p) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, p.orgId, "закупки");
    const now = new Date().toISOString();
    const created: string[] = [];

    const logic = resolveTenderLogicSettings(data.organizations.find((org) => org.id === p.orgId));
    if (!p.calculationId) {
      const id = `c-${Date.now()}`;
      const currentDir =
        data.directories.find((d) => d.type === "rascenki" && d.current) ??
        data.directories[0];
      data.calculations.unshift({
        id,
        orgId: p.orgId,
        procurementId: p.id,
        title: `Черновой ресурсный расчёт — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        positions: [],
        assumptions: [
          "Ресурсный черновик создан пустым: объёмы, состав ресурсов и тарифы не подставляются без источника",
          "Добавьте позиции из справочника или документов; подтвердите каждую ставку и формулу количества",
          "Собственные ресурсы только в черновике — не в смете заказчика",
          ...(p.nmck == null ? ["НМЦК источник не публикует"] : []),
        ],
        scenario: "bazovyy",
        scenarioFactor: 1,
        participateDecision: "na_rassmotrenii",
        directoryVersionId: currentDir?.id ?? "dir-rascenki-1",
        version: 1,
        authorId: actorId,
        updatedAt: now,
        kind: "resource_draft",
        immutable: false,
        ...defaultOwnerFields(data, p.orgId, actorId),
        changeLog: [
          {
            id: `cl-${Date.now()}`,
            at: now,
            actorId,
            detail: "Создан ресурсный черновик",
          },
        ],
        dataFlags: ["auto_chain", "requires_manual_check", "official_43_10_40"],
        resourceScheduleParams: resourceParamsForNewCalculation(logic.shiftProfile),
      });
      p.calculationId = id;
      created.push("расчёт");
    }

    if (!p.gprId) {
      const id = `g-${Date.now()}`;
      const start = now.slice(0, 10);
      const stage1 = `gs-${Date.now()}`;
      const stage2 = `gs-${Date.now() + 1}`;
      const chainCalendar = calendarForNewSchedule(logic.shiftProfile);
      data.schedules.unshift({
        id,
        orgId: p.orgId,
        procurementId: p.id,
        calculationId: p.calculationId ?? "",
        title: `ГПР — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        version: 1,
        authorId: actorId,
        ...(chainCalendar ? { calendar: chainCalendar } : {}),
        assumptions: [
          "Начальные даты — заготовка. Длительность этапов считается по выработке, срок ТЗ по строкам не делится.",
          "Состав и количество ресурсов не подтверждены: заполните строки перед использованием итогов",
        ],
        stages: [
          ensureStageResources({
            id: stage1,
            name: "Подготовка",
            start,
            end: start,
            sequence: 1,
            crewSize: 0,
            createdBy: actorId,
          }),
          ensureStageResources({
            id: stage2,
            name: "Основные работы",
            start,
            end: start,
            sequence: 2,
            dependsOn: stage1,
            dependencyType: "FS",
            crewSize: 0,
            createdBy: actorId,
          }),
        ],
        updatedAt: now,
      });
      p.gprId = id;
      created.push("ГПР");
    }

    if (!p.moneyId) {
      const id = `m-${Date.now()}`;
      data.moneyPlans.unshift({
        id,
        orgId: p.orgId,
        procurementId: p.id,
        title: `Деньги — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        // A project chain must not invent payment terms from NMCK. Add cash
        // events only after they are sourced from the contract or entered.
        payments: [],
        updatedAt: now,
      });
      p.moneyId = id;
      created.push("деньги");
    }

    const hasRisk = data.risks.some((r) => r.procurementId === p.id);
    if (!hasRisk) {
      data.risks.unshift({
        id: `r-${Date.now()}`,
        orgId: p.orgId,
        procurementId: p.id,
        title: `Риски — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        contractParsed: false,
        remarks: [],
        updatedAt: now,
      });
      created.push("риски");
    }

    if (!p.planFactId) {
      const obj =
        data.objects.find((o) => o.id === p.objectId) ??
        data.objects.find((o) => o.orgId === p.orgId);
      const id = `pf-${Date.now()}`;
      data.planFacts.unshift({
        id,
        orgId: p.orgId,
        objectId: obj?.id ?? "obj-1",
        procurementId: p.id,
        title: `План/факт — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        entries: [],
        updatedAt: now,
      });
      p.planFactId = id;
      created.push("план/факт");
    }

    audit(
      data,
      actorId,
      "ensure_chain",
      "procurement",
      procurementId,
      created.length
        ? `Создано: ${created.join(", ")}`
        : "Цепочка уже полная"
    );
    return data;
  });
}

function productionEntriesFromCustomerEstimate(data: AppData, procurementId: string): PlanFactEntry[] {
  const procurement = data.procurements.find((item) => item.id === procurementId);
  const original = data.calculations.find((item) =>
    item.id === procurement?.originalCalculationId && item.kind === "customer_original"
  ) ?? data.calculations.find((item) =>
    item.procurementId === procurementId && item.kind === "customer_original"
  );
  if (!original) return [];
  const hasRecognizedWorkRows = original.positions.some((position) =>
    /^(?:ЕНИР|ФЕР|ТЕР|ГЭСН)(?:М)?/iu.test(position.code.trim())
  );
  const grouped = new Map<string, { workName: string; unit: string; plan: number }>();
  for (const position of original.positions) {
    const workName = position.name.trim();
    const unit = position.unit.trim();
    const code = position.code.trim().toUpperCase();
    const resourceCode = /^(?:ФССЦ|ТССЦ|ФСБЦ|ФСЭМ|ТСЭМ|ТЦ)(?:[-.\s]|$)/iu.test(code);
    const workRate = /^(?:ЕНИР|ФЕР|ТЕР|ГЭСН)(?:М)?/iu.test(code);
    if (!workName || !unit || /^(НР|СП)(?:$|[-.\s])/i.test(code) || resourceCode ||
      (hasRecognizedWorkRows && !workRate) || !Number.isFinite(position.quantity) || position.quantity <= 0) continue;
    const key = `${workName.toLocaleLowerCase("ru-RU")}\u0000${unit.toLocaleLowerCase("ru-RU")}`;
    const row = grouped.get(key) ?? { workName, unit, plan: 0 };
    row.plan += position.quantity;
    grouped.set(key, row);
  }
  return [...grouped.values()].map((row, index) => ({
    id: `pfe-est-${procurementId}-${index + 1}`,
    workName: row.workName,
    unit: row.unit,
    plan: row.plan,
    fact: 0,
    contractRemaining: row.plan,
  }));
}

/** Physical production plan comes from explicit work volumes in the linked GPR. */
function productionEntriesFromSchedule(data: AppData, procurementId: string): PlanFactEntry[] {
  const schedule = data.schedules.find((item) => item.procurementId === procurementId);
  if (!schedule) return [];
  const calculation = data.calculations.find((item) => item.id === schedule.calculationId);
  const linkedStages = linkEstimateWorksToStages(schedule.stages, calculation?.positions ?? []);
  return deriveProductionEntriesFromGpr(linkedStages, calculation?.positions ?? []).map((entry, index) => ({
    ...entry,
    id: `pfe-gpr-${procurementId}-${index + 1}`,
  }));
}

/** Refresh GPR-sourced rows without discarding entered facts or manual plan rows. */
function syncProductionPlanFromSchedule(data: AppData, schedule: GprSchedule) {
  const procurement = data.procurements.find((item) => item.id === schedule.procurementId);
  if (!procurement) return;
  const plans = data.planFacts.filter((item) => item.procurementId === procurement.id || item.id === procurement.planFactId);
  if (!plans.length) return;
  const derived = productionEntriesFromSchedule(data, procurement.id);
  const keyOf = (entry: Pick<PlanFactEntry, "workName" | "unit">) =>
    `${entry.workName.trim().toLocaleLowerCase("ru-RU")}\u0000${entry.unit.trim().toLocaleLowerCase("ru-RU")}`;
  for (const plan of plans) {
    const oldByKey = new Map(plan.entries.map((entry) => [keyOf(entry), entry]));
    const nextKeys = new Set(derived.map(keyOf));
    const next: PlanFactEntry[] = derived.map((entry) => {
      const old = oldByKey.get(keyOf(entry));
      const dailyHasFact = (plan.dailyFacts ?? []).some((daily) =>
        daily.workName.trim() === entry.workName.trim() && daily.unit.trim() === entry.unit.trim()
      );
      const fact = dailyHasFact
        ? Math.round(sumDailyQty(plan.dailyFacts, { workName: entry.workName, unit: entry.unit }) * 1000) / 1000
        : old?.fact ?? 0;
      return {
        ...entry,
        ...(old ? { id: old.id } : {}),
        fact,
        contractRemaining: Math.max(0, entry.plan - fact),
      };
    });
    for (const old of plan.entries) {
      if (nextKeys.has(keyOf(old))) continue;
      const hasRecordedFact = old.fact > 0 || (plan.dailyFacts ?? []).some((fact) =>
        fact.workName.trim() === old.workName.trim() && fact.unit.trim() === old.unit.trim() && fact.quantity > 0
      );
      const importedEstimateOrGpr = old.id.startsWith("pfe-gpr-") || old.id.startsWith("pfe-est-");
      if (hasRecordedFact || !importedEstimateOrGpr) next.push(old);
    }
    plan.entries = next;
    plan.updatedAt = new Date().toISOString();
  }
}

function productionEntriesForProcurement(data: AppData, procurementId: string): PlanFactEntry[] {
  const fromGpr = productionEntriesFromSchedule(data, procurementId);
  return fromGpr.length ? fromGpr : productionEntriesFromCustomerEstimate(data, procurementId);
}

export function updateSchedule(
  actorId: string,
  id: string,
  patch: Partial<GprSchedule>
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertGprWrite(actor);
    const item = data.schedules.find((s) => s.id === id);
    if (!item) throw new Error("ГПР не найден");
    assertOrgAccess(actor, item.orgId, "ГПР");
    let linkedCalculationId = item.calculationId;
    if (patch.calculationId && patch.calculationId !== item.calculationId) {
      const linked = data.calculations.find((row) => row.id === patch.calculationId);
      if (!linked || linked.orgId !== item.orgId) {
        throw new Error("Нет доступа к данным другой организации (расчёта)");
      }
      assertOrgAccess(actor, linked.orgId, "расчёта");
      linkedCalculationId = linked.id;
    }
    const { orgId: _o, id: _i, calculationId: _c, procurementId: _p, ...safe } = patch;
    void _o;
    void _i;
    void _c;
    void _p;
    const physicalPlanSignature = (stages: GprStage[]) => JSON.stringify(stages.map((stage) => ({
      name: stage.name,
      workName: stage.workName,
      workNames: stage.workNames,
      planVolume: stage.planVolume,
      planUnit: stage.planUnit,
    })));
    const previousPhysicalPlan = safe.stages ? physicalPlanSignature(item.stages) : null;
    data.schedules = data.schedules.map((s) => {
      if (s.id !== id) return s;
      const calc = data.calculations.find((item) => item.id === s.calculationId);
      const priorStages = new Map(s.stages.map((stage) => [stage.id, stage]));
      const stages = safe.stages
        ? linkEstimateWorksToStages(safe.stages.map((stage) => {
            const previous = priorStages.get(stage.id);
            if (previous) {
              const { createdBy: _clientAuthor, ...rest } = stage;
              void _clientAuthor;
              return previous.createdBy ? { ...rest, createdBy: previous.createdBy } : rest;
            }
            return { ...stage, createdBy: stage.createdBy ?? actorId };
          }), calc?.positions ?? [])
        : s.stages;
      return {
        ...s,
        ...safe,
        calculationId: linkedCalculationId,
        stages,
        updatedAt: new Date().toISOString(),
      };
    });
    // Only resync explicit resource-linked drafts — never rewrite unrelated/legacy positions.
    const updated = data.schedules.find((s) => s.id === id)!;
    if (safe.stages) {
      const calc = data.calculations.find((c) => c.id === updated.calculationId);
      if (
        calc &&
        isResourceLinkedDraft(calc) &&
        scheduleHasPopulatedResources(updated.stages)
      ) {
        const synced = syncDraftFromStages(calc, updated.stages, {
          replacePositions: true,
        });
        Object.assign(calc, synced.calc);
        finishSyncedCommercialCost(calc);
      }
      if (previousPhysicalPlan !== physicalPlanSignature(updated.stages)) {
        syncProductionPlanFromSchedule(data, updated);
      }
    }
    audit(data, actorId, "update", "gpr", id, "Обновление ГПР");
    return data;
  });
}

function stagePlanKey(stage: GprStage) {
  return JSON.stringify({
    id: stage.id,
    name: stage.name,
    workName: stage.workName ?? null,
    workNames: stage.workNames ?? [],
    start: stage.start,
    end: stage.end,
    sequence: stage.sequence,
    dependsOn: stage.dependsOn ?? null,
    dependencyType: stage.dependencyType ?? null,
    lagDays: stage.lagDays ?? null,
    planVolume: stage.planVolume ?? null,
    planUnit: stage.planUnit ?? null,
  });
}

/** Resource edits from a calculation. Stage structure still requires the GPR section. */
export function updateLinkedResourcesFromCalculation(
  actorId: string,
  calculationId: string,
  stages: GprStage[],
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertSection(actor, "raschety");
    const calc = data.calculations.find((item) => item.id === calculationId);
    if (!calc) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, calc.orgId, "расчёта");
    assertEditableCalculation(calc);
    const procurement = data.procurements.find((item) => item.id === calc.procurementId);
    const schedule = data.schedules.find((item) => item.calculationId === calc.id)
      ?? data.schedules.find((item) => item.id === procurement?.gprId);
    if (!schedule) throw new Error("ГПР не найден");
    assertOrgAccess(actor, schedule.orgId, "ГПР");
    const incomingById = new Map(stages.map((stage) => [stage.id, stage]));
    if (
      stages.length !== schedule.stages.length
      || schedule.stages.some((stage) => {
        const incoming = incomingById.get(stage.id);
        return !incoming || stagePlanKey(stage) !== stagePlanKey(incoming);
      })
    ) {
      throw new Error("Для изменения этапов нужен раздел «ГПР»");
    }
    const stagePlanBefore = schedule.stages.map(stagePlanKey);
    schedule.stages = schedule.stages.map((stage) => ({
      ...stage,
      resources: incomingById.get(stage.id)?.resources ?? stage.resources,
    }));
    schedule.updatedAt = new Date().toISOString();
    if (schedule.stages.some((stage, index) => stagePlanKey(stage) !== stagePlanBefore[index])) {
      throw new Error("Для изменения этапов нужен раздел «ГПР»");
    }
    if (isResourceLinkedDraft(calc)) {
      const synced = syncDraftFromStages(calc, schedule.stages, { replacePositions: true });
      Object.assign(calc, synced.calc);
      finishSyncedCommercialCost(calc);
    }
    audit(data, actorId, "update", "calculation", calculationId, "Ресурсы расчёта синхронизированы с графиком");
    return data;
  });
}

/**
 * Edit one stage resource (qty/rate) and recompute the linked resource draft
 * from the unified tree → positions + V/W/X/Y/Z costSummary.
 */
export function patchScheduleResourceAndSync(
  actorId: string,
  scheduleId: string,
  input: {
    resourceId: string;
    stageId?: string;
    name?: string;
    unit?: string;
    kind?: GprStageResource["kind"];
    quantity?: number;
    rate?: number | null;
    hoursPerShift?: number | null;
    shiftsPerDay?: number | null;
    days?: number | null;
    quantityBasis?: GprStageResource["quantityBasis"] | null;
  }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertGprWrite(actor);
    const schedule = data.schedules.find((s) => s.id === scheduleId);
    if (!schedule) throw new Error("ГПР не найден");
    assertOrgAccess(actor, schedule.orgId, "ГПР");
    const calc = data.calculations.find((c) => c.id === schedule.calculationId);
    if (calc) {
      assertOrgAccess(actor, calc.orgId, "расчёта");
      assertEditableCalculation(calc);
    }
    schedule.stages = patchStageResource(
      schedule.stages,
      input.resourceId,
      {
        name: input.name,
        unit: input.unit,
        kind: input.kind,
        quantity: input.quantity,
        rate: input.rate,
        hoursPerShift: input.hoursPerShift,
        shiftsPerDay: input.shiftsPerDay,
        days: input.days,
        quantityBasis: input.quantityBasis,
      },
      input.stageId
    );
    schedule.updatedAt = new Date().toISOString();
    if (
      calc &&
      isResourceLinkedDraft(calc) &&
      scheduleHasPopulatedResources(schedule.stages)
    ) {
      const synced = syncDraftFromStages(calc, schedule.stages, {
        replacePositions: true,
      });
      Object.assign(calc, synced.calc);
      finishSyncedCommercialCost(calc);
      calc.changeLog = [
        ...(calc.changeLog ?? []),
        {
          id: `cl-${Date.now()}`,
          at: new Date().toISOString(),
          actorId,
          detail: `Ресурс ${input.resourceId}: qty/rate → единый пересчёт V/W/X/Y/Z`,
        },
      ];
    } else if (calc && !isResourceLinkedDraft(calc)) {
      // Schedule resource edited, but calc is not a resource-linked draft —
      // do not replace positions / cost of an unrelated estimate.
      audit(
        data,
        actorId,
        "patch_resource",
        "gpr",
        scheduleId,
        `Ресурс ${input.resourceId} обновлён без sync сметы ${calc.id} (не resource-linked draft)`
      );
    }
    audit(
      data,
      actorId,
      "patch_resource",
      "gpr",
      scheduleId,
      `Ресурс ${input.resourceId} → sync draft ${schedule.calculationId}`
    );
    return data;
  });
}

export function updateMoney(
  actorId: string,
  id: string,
  patch: Partial<MoneyPlan>
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.moneyPlans.find((m) => m.id === id);
    if (!item) throw new Error("Денежный план не найден");
    assertOrgAccess(actor, item.orgId, "денежного плана");
    const { orgId: _o, id: _i, ...safe } = patch;
    void _o;
    void _i;
    if (safe.payments) {
      const previous = new Map(item.payments.map((payment) => [payment.id, payment]));
      for (const payment of safe.payments) {
        const prior = payment.id ? previous.get(payment.id) : undefined;
        if (prior && prior.amount === payment.amount) continue;
        const amountError = paymentAmountError(payment.amount);
        if (amountError) throw new Error(amountError);
      }
    }
    data.moneyPlans = data.moneyPlans.map((m) =>
      m.id === id
        ? { ...m, ...safe, updatedAt: new Date().toISOString() }
        : m
    );
    audit(data, actorId, "update", "money", id, "Обновление денежного плана");
    return data;
  });
}

export function updateRisk(
  actorId: string,
  id: string,
  patch: Partial<RiskRegistry>
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.risks.find((r) => r.id === id);
    if (!item) throw new Error("Реестр рисков не найден");
    assertOrgAccess(actor, item.orgId, "реестра рисков");
    const { orgId: _o, id: _i, ...safe } = patch;
    void _o;
    void _i;
    data.risks = data.risks.map((r) =>
      r.id === id
        ? { ...r, ...safe, updatedAt: new Date().toISOString() }
        : r
    );
    audit(data, actorId, "update", "risk", id, "Обновление реестра рисков");
    return data;
  });
}

export function updatePlanFact(
  actorId: string,
  id: string,
  patch: Partial<PlanFact>
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.planFacts.find((p) => p.id === id);
    if (!item) throw new Error("План/факт не найден");
    assertOrgAccess(actor, item.orgId, "план/факт");
    const { orgId: _o, id: _i, ...rest } = patch;
    void _o;
    void _i;
    const safe = rest.dailyFacts
      ? { ...rest, dailyFacts: dailyFactsWithoutPlantedPaths(item, rest.dailyFacts) }
      : rest;
    data.planFacts = data.planFacts.map((p) => {
      if (p.id !== id) return p;
      const migrated = migratePlanBundle({
        entries: safe.entries ?? p.entries,
        dailyFacts: safe.dailyFacts ?? p.dailyFacts,
      });
      return {
        ...p,
        ...safe,
        entries: migrated.entries,
        dailyFacts: migrated.dailyFacts,
        updatedAt: new Date().toISOString(),
      };
    });
    audit(data, actorId, "update", "planfact", id, "Обновление план/факт");
    return data;
  });
}

/** Removes one work row from the plan as it is now, leaving every other row in place. */
export function deletePlanFactEntry(actorId: string, planId: string, entryId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.planFacts.find((plan) => plan.id === planId);
    if (!item) throw new Error("План/факт не найден");
    assertOrgAccess(actor, item.orgId, "план/факт");
    const entry = item.entries.find((row) => row.id === entryId);
    if (!entry) throw new Error("Вид работ не найден");
    item.dailyFacts = (item.dailyFacts ?? []).map((fact) => {
      const linked = fact.entryId
        ? fact.entryId === entry.id
        : fact.workName.trim() === entry.workName.trim() && fact.unit.trim() === entry.unit.trim();
      return linked ? { ...fact, entryId: entry.id, archived: true } : fact;
    });
    item.entries = item.entries.filter((row) => row.id !== entryId);
    item.updatedAt = new Date().toISOString();
    audit(data, actorId, "delete", "planfact", planId, `Вид работ ${entryId}`);
    return data;
  });
}

/** Puts back a work row and the daily facts that were hidden with it. */
export function restorePlanFactEntry(actorId: string, planId: string, entry: PlanFactEntry) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.planFacts.find((plan) => plan.id === planId);
    if (!item) throw new Error("План/факт не найден");
    assertOrgAccess(actor, item.orgId, "план/факт");
    if (!item.entries.some((row) => row.id === entry.id)) {
      item.entries = [...item.entries, entry];
    }
    item.dailyFacts = (item.dailyFacts ?? []).map((fact) =>
      fact.entryId === entry.id ? { ...fact, archived: false } : fact
    );
    item.updatedAt = new Date().toISOString();
    audit(data, actorId, "restore", "planfact", planId, `Вид работ ${entry.id}`);
    return data;
  });
}

export function setDirectoryCurrent(actorId: string, id: string) {
  return mutateAppData((data) => {
    const target = data.directories.find((d) => d.id === id);
    if (!target) return data;
    data.directories = data.directories.map((d) =>
      d.type === target.type ? { ...d, current: d.id === id } : d
    );
    audit(data, actorId, "directory", "directory", id, "Текущая версия справочника");
    return data;
  });
}

export function importDirectoryRows(
  actorId: string,
  type: AppData["directories"][0]["type"],
  rows: Record<string, string | number>[]
) {
  return mutateAppData((data) => {
    const same = data.directories.filter((d) => d.type === type);
    const nextVersion = Math.max(0, ...same.map((d) => d.version)) + 1;
    const id = `dir-${type}-${nextVersion}`;
    data.directories = data.directories.map((d) =>
      d.type === type ? { ...d, current: false } : d
    );
    data.directories.push({
      id,
      type,
      name:
        type === "normy"
          ? "Нормы (импорт Excel)"
          : type === "rascenki"
            ? "Расценки (импорт Excel)"
            : type === "ceny"
              ? "Цены (импорт Excel)"
              : type === "park"
                ? "Парк техники (импорт)"
                : "Профиль закупок (импорт)",
      version: nextVersion,
      authorId: actorId,
      at: new Date().toISOString(),
      current: true,
      rows,
    });
    audit(data, actorId, "import", "directory", id, `Импорт v${nextVersion}`);
    return data;
  });
}

export function confirmSmetaExchange(actorId: string, id: string) {
  return mutateAppData((data) => {
    data.smetaExchanges = data.smetaExchanges.map((s) =>
      s.id === id ? { ...s, confirmed: true } : s
    );
    audit(data, actorId, "confirm", "smeta", id, "Подтверждён обмен");
    return data;
  });
}

export function importSmetaExchange(
  actorId: string,
  name: string,
  mapped: { code: string; quantity: number }[],
  ours: { code: string; quantity: number }[]
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const discrepancies = mapped
      .map((t) => {
        const o = ours.find((x) => x.code === t.code);
        if (!o) return { code: t.code, ours: 0, theirs: t.quantity };
        if (o.quantity === t.quantity) return null;
        return { code: t.code, ours: o.quantity, theirs: t.quantity };
      })
      .filter(Boolean) as { code: string; ours: number; theirs: number }[];
    const id = `sx-${Date.now()}`;
    data.smetaExchanges.unshift({
      id,
      orgId: actor.orgId,
      name,
      at: new Date().toISOString(),
      authorId: actorId,
      positionsMapped: mapped.length,
      discrepancies,
      confirmed: false,
    });
    audit(data, actorId, "import", "smeta", id, `Импорт XLSX: ${mapped.length} позиций`);
    return data;
  });
}

export function saveContractReview(
  actorId: string,
  riskId: string,
  review: { label: string; remarks: Array<Omit<RiskRemark, "id">> },
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.risks.find((risk) => risk.id === riskId);
    if (!item) throw new Error("Реестр рисков не найден");
    assertOrgAccess(actor, item.orgId, "реестра рисков");
    const now = Date.now();
    item.remarks = review.remarks.map((remark, index) => ({ ...remark, id: `rm-${now + index}` }));
    item.contractParsed = true;
    item.reviewLabel = review.label;
    item.status = review.remarks.length ? "trebuet_proverki" : item.status;
    item.updatedAt = new Date().toISOString();
    return data;
  });
}

export function injectRiskParse(
  actorId: string,
  riskId: string,
  contractText?: string | null
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.risks.find((r) => r.id === riskId);
    if (!item) throw new Error("Реестр рисков не найден");
    assertOrgAccess(actor, item.orgId, "реестра рисков");
    const now = Date.now();
    const parsed = parseContractRisks(contractText);
    const remarks = parsed.map((remark, index) => ({
      ...remark,
      id: `rm-${now + index}`,
    }));
    data.risks = data.risks.map((r) =>
      r.id !== riskId
        ? r
        : {
            ...r,
            contractParsed: true,
            status: "trebuet_proverki" as const,
            remarks: [...r.remarks, ...remarks],
            updatedAt: new Date().toISOString(),
          }
    );
    audit(
      data,
      actorId,
      "parse",
      "risk",
      riskId,
      contractText?.trim()
        ? `Разбор договора по чек-листу, замечаний: ${remarks.length}`
        : remarks.length === 0
          ? "Разбор договора: нет данных (пусто или короткий текст)"
          : `Разбор договора по чек-листу, замечаний: ${remarks.length}`
    );
    return data;
  });
}

export function issueSecretKey(actorId: string, userId: string) {
  let issued = "";
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const target = data.users.find((u) => u.id === userId);
    if (!target) throw new Error("Пользователь не найден");
    assertCanManageTarget(actor, target);
    if (!keyRole(target.role)) {
      throw new Error(
        "Некорректный запрос: секретный ключ только для суперадмина и администратора"
      );
    }
    if (actor.role === "admin" && target.role !== "admin") {
      throw new Error("Нет доступа к ключу этой учётной записи");
    }
    const key = `TK-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
    issued = key;
    data.users = data.users.map((u) =>
      u.id === userId ? { ...u, secretKeyHash: hashPassword(key) } : u
    );
    audit(
      data,
      actorId,
      "issue_secret_key",
      "user",
      userId,
      "Выдан новый секретный ключ"
    );
    return data;
  });
  return { key: issued };
}

export function setUserSections(
  actorId: string,
  userId: string,
  sections: SectionKey[]
) {
  return updateUser(actorId, userId, { sections });
}

export function resetDemo(actorId: string): { token: string; actorId: string } {
  resetAppData();
  let resolvedActorId = actorId;
  mutateAppData((d) => {
    if (!d.users.some((u) => u.id === resolvedActorId)) {
      const superUser = d.users.find((u) => u.role === "superadmin");
      resolvedActorId = superUser?.id ?? resolvedActorId;
    }
    audit(d, resolvedActorId, "reset", "system", "all", "Сброс данных");
    return d;
  });
  // sessions were wiped — выдаём новый токен, чтобы UI не получил 401
  const token = createSession(resolvedActorId);
  return { token, actorId: resolvedActorId };
}

function hasModelFindings(analytics: { findings?: Array<{ text?: string }> } | null | undefined): boolean {
  return Boolean(analytics?.findings?.some((finding) => finding.text?.trim()));
}

function modelWroteAnalyticalNote(analytics: { method?: string; memoSource?: string; answeredByModel?: string; findings?: Array<{ text?: string }> } | null | undefined): boolean {
  return analytics?.memoSource === "model"
    || Boolean(analytics?.answeredByModel)
    || analytics?.method === "разбор пакета по цитатам документов"
    || analytics?.method === "model_note"
    || hasModelFindings(analytics);
}

/** Prod cards written before memoSource/hash existed. Findings alone are enough when the method was not stored. */
function isLegacyModelMemo(analytics: ProjectAnalytics | null | undefined): boolean {
  if (!analytics || analytics.memoSource || analytics.answeredByModel || analytics.sourceDocumentHash || analytics.memoStale) return false;
  return analytics.method === "разбор пакета по цитатам документов"
    || analytics.method === "model_note"
    || hasModelFindings(analytics);
}

const MODEL_MEMO_STALE = "Документы изменились, обновите разбор";

function documentsForHash(documents: Array<{ id: string; fileName: string; fileSize?: number | null; storedPath?: string | null; uploadedAt?: string | null }>) {
  return documents.filter((document) => document.storedPath);
}

type LegacyMemoDocument = {
  id: string;
  fileName: string;
  fileSize?: number | null;
  storedPath?: string | null;
  uploadedAt?: string | null;
  citations?: Array<{ id: string }>;
  versions?: Array<{ at: string }>;
};

function parsedTime(value: string | undefined | null): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** generatedAt, or the older analytics updatedAt when the memo has no generation clock. */
function legacyMemoClock(analytics: ProjectAnalytics): number | undefined {
  return parsedTime(analytics.generatedAt) ?? parsedTime(analytics.updatedAt);
}

function citedSourceIds(analytics: ProjectAnalytics): string[] {
  const ids = [
    ...analytics.citationIds,
    ...analytics.citations.map((citation) => citation.id),
    ...(analytics.findings ?? []).flatMap((finding) => finding.citationIds),
  ];
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function citedDocumentKeys(analytics: ProjectAnalytics): Set<string> {
  const keys = new Set(citedSourceIds(analytics));
  for (const citation of analytics.citations) {
    if (citation.sourceFile.trim()) keys.add(citation.sourceFile);
  }
  for (const finding of analytics.findings ?? []) {
    for (const file of finding.sourceFiles) {
      if (file.trim()) keys.add(file);
    }
  }
  return keys;
}

function documentInCitedSet(document: LegacyMemoDocument, cited: Set<string>): boolean {
  if (cited.has(document.id) || cited.has(document.fileName)) return true;
  return (document.citations ?? []).some((citation) => cited.has(citation.id));
}

function coverageCountsDiffer(analytics: ProjectAnalytics, rebuilt: ProjectAnalytics | undefined): boolean {
  if (!analytics.quality || !rebuilt?.quality) return false;
  return analytics.quality.sourceDocuments !== rebuilt.quality.sourceDocuments
    || analytics.quality.requiredDocumentsFound !== rebuilt.quality.requiredDocumentsFound
    || analytics.quality.citationCount !== rebuilt.quality.citationCount;
}

/** True only when the files or citations show the legacy memo does not cover this set. */
function legacyMemoConflictsWithDocuments(
  analytics: ProjectAnalytics,
  documents: LegacyMemoDocument[],
  rebuilt: ProjectAnalytics | undefined,
): boolean {
  const stored = documents.filter((document) => document.storedPath);
  const clock = legacyMemoClock(analytics);
  if (clock != null) {
    const changedAfterMemo = stored.some((document) => {
      const marks = [document.uploadedAt, ...(document.versions ?? []).map((version) => version.at)];
      return marks.some((mark) => {
        const at = parsedTime(mark);
        return at != null && at > clock;
      });
    });
    if (changedAfterMemo) return true;
  }
  const citedIds = citedSourceIds(analytics);
  if (citedIds.length) {
    const live = new Set<string>();
    for (const document of stored) {
      live.add(document.id);
      for (const citation of document.citations ?? []) live.add(citation.id);
    }
    if (citedIds.some((id) => !live.has(id))) return true;
  }
  const cited = citedDocumentKeys(analytics);
  const missingFromCitedSet = cited.size > 0 && stored.some((document) => !documentInCitedSet(document, cited));
  if (missingFromCitedSet && coverageCountsDiffer(analytics, rebuilt)) return true;
  return false;
}

/** Stamp the current files only when nothing shows they changed after this memo. */
function backfillLegacyModelMemo(
  analytics: ProjectAnalytics | undefined,
  documents: LegacyMemoDocument[],
  rebuilt: ProjectAnalytics | undefined,
): ProjectAnalytics | undefined {
  if (!isLegacyModelMemo(analytics)) return analytics;
  if (legacyMemoConflictsWithDocuments(analytics!, documents, rebuilt)) return analytics;
  return {
    ...analytics!,
    memoSource: "model",
    sourceDocumentHash: documentSetHash(documentsForHash(documents)),
  };
}

/** A model memo stays current only for the document set it was written on. */
function modelMemoIsCurrent(
  analytics: ProjectAnalytics | undefined,
  documents: Array<{ id: string; fileName: string; fileSize?: number | null; storedPath?: string | null; uploadedAt?: string | null }>,
): boolean {
  if (!analytics?.sourceDocumentHash || !modelWroteAnalyticalNote(analytics)) return false;
  return analytics.sourceDocumentHash === documentSetHash(documentsForHash(documents));
}

/** Document coverage can move. The model's review status and claim counts stay. */
function mergedAnalyticsQuality(
  previous: ProjectAnalytics["quality"] | undefined,
  rebuilt: ProjectAnalytics["quality"] | undefined,
): ProjectAnalytics["quality"] | undefined {
  if (!previous) return rebuilt;
  const rejected = previous.rejectedClaims ?? 0;
  return {
    status: rejected > 0 && previous.status === "evidence_backed" ? "needs_review" : previous.status,
    sourceDocuments: rebuilt?.sourceDocuments ?? previous.sourceDocuments,
    requiredDocumentsFound: rebuilt?.requiredDocumentsFound ?? previous.requiredDocumentsFound,
    citationCount: rebuilt?.citationCount ?? previous.citationCount,
    acceptedClaims: previous.acceptedClaims,
    rejectedClaims: previous.rejectedClaims,
  };
}

function withDeterministicCoverage(previous: ProjectAnalytics, rebuilt: ProjectAnalytics): ProjectAnalytics {
  return {
    ...previous,
    missingInputs: rebuilt.missingInputs,
    quality: mergedAnalyticsQuality(previous.quality, rebuilt.quality),
    citations: rebuilt.citations,
    citationIds: rebuilt.citationIds,
  };
}

function localNoteAnalytics(
  built: ProjectAnalytics,
  docs: Array<{ category?: string; fileName: string; estimatePositions?: unknown[] }>,
  stale: boolean,
): ProjectAnalytics {
  const summary = localAnalyticalSummary(built, docs);
  return {
    ...built,
    summary: stale ? `${MODEL_MEMO_STALE}\n\n${summary}` : summary,
    memoSource: "local",
    answeredByModel: undefined,
    sourceDocumentHash: undefined,
    memoStale: stale ? true : undefined,
    findings: undefined,
    customerQuestions: undefined,
  };
}

function localAnalyticalSummary(built: ProjectAnalytics, docs: Array<{ category?: string; fileName: string; estimatePositions?: unknown[] }>): string {
  const verdict = built.recommendation === "participate" ? 7 : built.recommendation === "do_not_participate" ? 3 : 4;
  const verdictText = built.recommendation === "participate"
    ? "Участие возможно после проверки документов."
    : built.recommendation === "do_not_participate"
      ? "Участие не рекомендуется по найденным условиям."
      : "Данных недостаточно для уверенного решения.";
  return composeAnalyticalNote({
    verdict,
    verdictText,
    blocks: [
      built.summary.split("\n\n")[0] || "нет данных",
      docs.some((document) => document.category === "contract" || /договор|контракт/iu.test(document.fileName))
        ? "Условия участия смотрите в договоре и цитатах карточки."
        : "нет данных",
      docs.some((document) => (document.estimatePositions?.length ?? 0) > 0)
        ? `В сметах ${recognizedRowsPhrase(docs.reduce((sum, document) => sum + (document.estimatePositions?.length ?? 0), 0))}.`
        : "нет данных",
      "нет данных",
      built.missingInputs.slice(0, 5).join("\n") || "нет данных",
    ],
  });
}

export function refreshProcurementAnalytics(
  actorId: string,
  procurementId: string
): { unchanged: boolean } {
  let unchanged = false;
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const p = data.procurements.find((x) => x.id === procurementId);
    if (!p) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, p.orgId, "закупки");
    const docs = data.documents.filter((d) => d.procurementId === p.id);
    const built = buildProjectAnalytics(p, docs);
    const original = p.analytics;
    const currentMemo = backfillLegacyModelMemo(original, docs, built);
    if (currentMemo && modelMemoIsCurrent(currentMemo, docs)) {
      const next = withDeterministicCoverage(currentMemo, built);
      const factsSame = original?.summary === next.summary
        && original?.memoSource === next.memoSource
        && original?.sourceDocumentHash === next.sourceDocumentHash
        && JSON.stringify(original?.missingInputs) === JSON.stringify(next.missingInputs)
        && JSON.stringify(original?.quality ?? null) === JSON.stringify(next.quality ?? null)
        && JSON.stringify(original?.citationIds) === JSON.stringify(next.citationIds)
        && JSON.stringify(original?.findings ?? null) === JSON.stringify(next.findings ?? null);
      if (factsSame) {
        unchanged = true;
        return data;
      }
      p.analytics = next;
      audit(data, actorId, "analyze", "procurement", procurementId, "Сводка: обновлены факты, текст записки сохранён");
      return data;
    }
    const staleModel = Boolean(currentMemo && (modelWroteAnalyticalNote(currentMemo) || currentMemo.memoStale));
    const next = localNoteAnalytics(built, docs, staleModel);
    if (original?.summary === next.summary && Boolean(original.memoStale) === Boolean(next.memoStale) && original.memoSource === next.memoSource) {
      unchanged = true;
      return data;
    }
    p.analytics = next;
    audit(data, actorId, "analyze", "procurement", procurementId, `Сводка: ${p.analytics.recommendation}`);
    return data;
  });
  return { unchanged };
}

/** Keep the upload successful, but make a failed model pass visible on the card. */
export function recordProcurementAiFailure(actorId: string, procurementId: string, reason: string) {
  const status = aiAnalysisFailureStatus(reason);
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const procurement = data.procurements.find((item) => item.id === procurementId);
    if (!procurement) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, procurement.orgId, "закупки");
    const documents = data.documents.filter((document) => document.procurementId === procurement.id);
    const base = procurement.analytics ?? buildProjectAnalytics(procurement, documents);
    procurement.analytics = {
      ...base,
      aiFailure: status,
      summary: base.summary.startsWith(status) ? base.summary : `${status}\n\n${base.summary}`,
    };
    audit(data, actorId, "analyze_ai_failed", "procurement", procurementId, status);
    return data;
  });
}

export async function analyzeProcurementPackageWithAI(
  actorId: string,
  procurementId: string
): Promise<{ warning?: string; usedAi: boolean }> {
  // Opening, downloading and package analysis must not create a calculation
  // or GPR and must not move the procurement. That happens only on the
  // explicit «Сформировать расчёт» action.
  const prepared = readAppData();
  const preparedProcurement = prepared.procurements.find((item) => item.id === procurementId);
  const preparedDraft = prepared.calculations.find((item) => item.id === preparedProcurement?.calculationId);
  if (preparedDraft?.resourceScheduleParams && preparedDraft.positions.some((position) => position.sourceDocumentId)) {
    recomputeCalculationCost(actorId, preparedDraft.id, {
      resourceScheduleParams: preparedDraft.resourceScheduleParams,
      useResourceScheduleEconomics: true,
    });
  }
  const snapshot = readAppData();
  const actor = actorUser(snapshot, actorId);
  const procurement = snapshot.procurements.find((item) => item.id === procurementId);
  if (!procurement) throw new Error("Закупка не найдена");
  assertOrgAccess(actor, procurement.orgId, "закупки");
  const documents = snapshot.documents.filter((document) => document.procurementId === procurement.id && document.storedPath);
  const deterministic = buildProjectAnalytics(procurement, documents);
  const draft = snapshot.calculations.find((item) => item.id === procurement.calculationId && item.kind === "resource_draft");
  const legacyCost = isLegacyEstimateSeededCost(draft);
  const officialPositions = (draft?.positions ?? []).filter((position) => legacyCost || position.costRole !== "customer_source");
  const missingRates = officialPositions.filter((position) => position.rateMissing && !position.isWorkItem).length;
  const pricedOfficial = officialPositions.some((position) => positionFeedsOfficialCost(position));
  const directCost = pricedOfficial
    ? (draft?.costSummary?.resourceSlices?.costWithOh ?? draft?.costSummary?.C0 ?? null)
    : null;
  const priceExVat = pricedOfficial ? (draft?.costSummary?.priceExVat ?? null) : null;
  const profit = pricedOfficial ? (draft?.costSummary?.profit ?? draft?.costSummary?.resourceSlices?.profit ?? null) : null;
  const economics = draft ? {
    cost: directCost,
    priceExVat,
    priceWithVat: pricedOfficial ? (draft.costSummary?.priceIncVat ?? null) : null,
    profit,
    profitabilityPercent: directCost != null && directCost > 0 && profit != null
      ? Math.round((profit / directCost) * 10000) / 100
      : null,
    revenueMarginPercent: priceExVat != null && priceExVat > 0 && profit != null
      ? Math.round((profit / priceExVat) * 10000) / 100
      : null,
    incomplete: Boolean(!pricedOfficial || !draft.costSummary || draft.costSummary.totalsIncomplete || draft.costSummary.incomplete?.length || missingRates),
    missingRates,
    missingRateNames: officialPositions.filter((position) => position.rateMissing && !position.isWorkItem).map((position) => position.name),
    incompleteReasons: draft.costSummary?.incomplete ?? [],
    repriceNotCost: Boolean(draft.dataFlags?.includes(REFERENCE_REPRICE_NOT_COST)),
  } : undefined;
  const currentDirectories = snapshot.directories.filter((directory) => directory.current);
  const profile = currentDirectories.find((directory) => directory.type === "profil");
  const fleet = currentDirectories.find((directory) => directory.type === "park");
  const labor = currentDirectories.find((directory) => directory.type === "rascenki");
  const hasValue = (row: Record<string, string | number>, keys: string[]) =>
    keys.some((key) => String(row[key] ?? "").trim().length > 0);
  const companyContext: AnalysisCompanyContext = {
    profileRows: (profile?.rows ?? []).slice(0, 100).map((row) => ({
      ...(row.region ? { region: String(row.region) } : {}),
      ...(row.okpd ? { okpd: String(row.okpd) } : {}),
      ...(row.services || row.service || row.workTypes || row.specialization
        ? { services: String(row.services ?? row.service ?? row.workTypes ?? row.specialization) }
        : {}),
      ...(typeof row.maxNmck === "number" ? { maxNmck: row.maxNmck } : {}),
    })),
    laborRates: (labor?.rows ?? []).slice(0, 100).map((row) => ({
      work: String(row.work ?? row.name ?? row.code ?? ""),
      ...(typeof row.rate === "number" ? { rate: row.rate } : {}),
      ...(row.unit ? { unit: String(row.unit) } : {}),
    })).filter((row) => row.work),
    fleet: (fleet?.rows ?? []).slice(0, 120).map((row) => ({
      ...(row.category ? { category: String(row.category) } : {}),
      name: String(row.name ?? row.code ?? ""),
      ...(typeof row.qty === "number" ? { quantity: row.qty } : {}),
      ...(row.unit ? { unit: String(row.unit) } : {}),
    })).filter((row) => row.name),
    serviceCatalogPresent: Boolean(profile?.rows.some((row) => hasValue(row, ["okpd", "services", "service", "workTypes", "specialization"]))),
    resourceAvailabilityTracked: Boolean(fleet?.rows.some((row) => hasValue(row, ["availableFrom", "availableTo", "availableQty", "freeQty"]))),
    riskRemarks: (snapshot.risks.find((item) => item.procurementId === procurement.id)?.remarks ?? []).slice(0, 40).map((risk) => ({
      severity: risk.severity,
      status: risk.status,
      text: risk.text,
      ...(risk.sourceExcerpt ? { sourceExcerpt: risk.sourceExcerpt } : {}),
    })),
  };
  const previousSummary = prepared.procurements.find((item) => item.id === procurementId)?.analytics?.summary ?? "";
  let generated: ProjectAnalytics;
  let warning: string | undefined;
  let usedAi = true;
  try {
    generated = await analyzeProjectPackageWithModel(procurement, documents, deterministic, economics, companyContext);
  } catch (error) {
    usedAi = false;
    const failure = error instanceof Error ? error.message : "Неизвестная ошибка модели";
    const modelOff = !modelConfigured() && !/пустой ответ|после \d+ попыток/iu.test(failure);
    const previousAnalytics = prepared.procurements.find((item) => item.id === procurementId)?.analytics;
    if (previousAnalytics?.summary?.trim()) {
      warning = "Разбор не удался, записка не менялась — попробуйте позже";
      generated = previousAnalytics;
    } else {
      warning = modelOff
        ? "Разбор не выполнен: модель не подключена"
        : "ИИ-модель не вернула полный ответ. Сохранил расчёт, источники и конкретный список того, что нужно подтвердить.";
      generated = buildProjectAnalysisFallback(procurement, deterministic, economics, companyContext, modelOff ? "модель не подключена" : failure);
    }
  }
  if (usedAi) {
    generated = {
      ...generated,
      sourceDocumentHash: documentSetHash(documents),
      memoSource: "model" as const,
      memoStale: undefined,
    };
  }
  mutateAppData((data) => {
    const currentActor = actorUser(data, actorId);
    const current = data.procurements.find((item) => item.id === procurementId);
    if (!current) throw new Error("Закупка не найдена");
    assertOrgAccess(currentActor, current.orgId, "закупки");
    current.analytics = generated;
    audit(data, actorId, usedAi ? "analyze_ai" : "analyze_fallback", "procurement", procurementId,
      usedAi ? "ИИ-анализ полного пакета документов" : "Сохранена локальная аналитика после ошибки модели");
    return data;
  });
  if (usedAi && generated.summary.trim() === previousSummary.trim()) {
    warning = "Новых данных нет — записка уже актуальна";
  }
  return { warning, usedAi };
}

/** True when the last successful package analysis already covered these files. */
export function packageAnalysisAlreadyCurrent(procurementId: string): boolean {
  const data = readAppData();
  const procurement = data.procurements.find((item) => item.id === procurementId);
  const saved = procurement?.analytics?.sourceDocumentHash;
  if (!saved) return false;
  const documents = data.documents.filter((document) => document.procurementId === procurementId && document.storedPath);
  return documentSetHash(documents) === saved;
}

function estimateDocumentsForProcurement(data: AppData, procurementId: string) {
  return data.documents
    .filter((document) => {
      if (document.procurementId !== procurementId || !document.storedPath) return false;
      const looksLikeEstimate =
        document.category === "estimate" ||
        /smeta|смет/i.test(document.fileName) ||
        Boolean(document.estimatePositions?.length) ||
        (document.analysis?.positionCount ?? 0) > 0;
      const hasEstimateData =
        Boolean(document.estimatePositions?.length) ||
        (document.analysis?.positionCount ?? 0) > 0 ||
        document.analysis?.costThousand != null;
      return looksLikeEstimate && hasEstimateData;
    })
    // Show the newest estimate first. Besides matching the procurement card,
    // this keeps customer totals and source revisions in a stable order when
    // several files are uploaded in quick succession.
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/**
 * Attach all recognized customer estimate files as an immutable original on
 * the procurement. Supports numeric PDF names and keeps each estimate's source.
 */
export function attachCustomerEstimate(
  actorId: string,
  procurementId: string,
  opts?: { fileName?: string; mappedCount?: number }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const p = data.procurements.find((x) => x.id === procurementId);
    if (!p) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, p.orgId, "закупки");
    const now = new Date().toISOString();
    const currentDir =
      data.directories.find((d) => d.type === "rascenki" && d.current) ??
      data.directories[0];

    const estimateDocs = estimateDocumentsForProcurement(data, p.id);
    if (!estimateDocs.length) {
      throw new Error("Сначала загрузите файл сметы заказчика (XLSX / Grand Smeta)");
    }

    const positions = estimateDocs.flatMap((document) => {
      const extracted = document.estimatePositions ?? [];
      const completeSourceRates = extracted.length > 0 && extracted.every(
        (position) => !position.rateMissing && Number.isFinite(position.rate) && position.rate > 0
      );
      if (completeSourceRates) {
        return extracted.map((position, index) => ({
          id: `cp-orig-${document.id}-${position.id || index + 1}`,
          sourceDocumentId: document.id,
          sourcePositionId: position.id,
          code: position.code,
          name: position.name,
          unit: position.unit,
          quantity: position.quantity,
          rate: position.rate,
          ...(position.isWorkItem ? { isWorkItem: true } : {}),
          ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
          ...(position.sectionName ? { sourceSectionName: position.sectionName } : {}),
          ...(position.workName ? { sourceWorkName: position.workName } : {}),
        }));
      }
      const total = document.analysis?.costThousand;
      if (total != null) {
        return [{
          id: `cp-orig-total-${document.id}`,
          sourceDocumentId: document.id,
          code: `CUST-TOTAL-${document.id}`,
          name: `Итог сметы · ${document.analysis?.workName || document.fileName}`,
          unit: "компл",
          quantity: 1,
          rate: Math.round(total * 1000),
        }];
      }
      return extracted.map((position, index) => ({
        id: `cp-orig-${document.id}-${position.id || index + 1}`,
        sourceDocumentId: document.id,
        sourcePositionId: position.id,
        code: position.code,
        name: position.name,
        unit: position.unit,
        quantity: position.quantity,
        rate: 0,
        rateMissing: true,
        ...(position.isWorkItem ? { isWorkItem: true } : {}),
        ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
        ...(position.sectionName ? { sourceSectionName: position.sectionName } : {}),
        ...(position.workName ? { sourceWorkName: position.workName } : {}),
      }));
    });
    if (!positions.length) {
      throw new Error("В файлах не найдены распознанные позиции или итоги смет");
    }
    const sourceNames = estimateDocs.map((document) => document.fileName);
    const recognizedCount = estimateDocs.reduce(
      (count, document) => count + (document.estimatePositions?.length || document.analysis?.positionCount || 0),
      0,
    );

    let oid = p.originalCalculationId;
    const existing = (oid ? data.calculations.find((c) => c.id === oid) : undefined) ??
      data.calculations.find((c) => c.procurementId === p.id && c.kind === "customer_original");
    // Only overwrite an original that already belongs to this org + procurement.
    const ownedOriginal =
      existing &&
      existing.kind === "customer_original" &&
      existing.orgId === p.orgId &&
      existing.procurementId === p.id
        ? existing
        : undefined;
    if (ownedOriginal) {
      ownedOriginal.positions = positions;
      ownedOriginal.title = `Смета заказчика (оригинал) — ${p.title.slice(0, 40)}`;
      ownedOriginal.updatedAt = now;
      ownedOriginal.immutable = true;
      ownedOriginal.assumptions = [
        `Неизменяемый снимок сметы заказчика: ${positions.length} позиций`,
        `Источники: ${sourceNames.join("; ")}`,
        `Распознано строк смет: ${recognizedCount}`,
        "Собственные ресурсы сюда не добавляются",
      ];
      ownedOriginal.dataFlags = [
        "immutable_original",
        "from_estimate_doc",
        "user_attached",
      ];
      oid = ownedOriginal.id;
    } else {
      oid = `c-orig-${Date.now()}`;
      data.calculations.unshift({
        id: oid,
        orgId: p.orgId,
        procurementId: p.id,
        title: `Смета заказчика (оригинал) — ${p.title.slice(0, 40)}`,
        status: "gotovo",
        positions,
        assumptions: [
          `Неизменяемый снимок сметы заказчика: ${positions.length} позиций`,
          `Источники: ${sourceNames.join("; ")}`,
          `Распознано строк смет: ${recognizedCount}`,
          "Собственные ресурсы сюда не добавляются",
        ],
        scenario: "bazovyy",
        scenarioFactor: 1,
        participateDecision: null,
        directoryVersionId: currentDir?.id ?? "dir-rascenki-1",
        version: 1,
        authorId: actorId,
        updatedAt: now,
        kind: "customer_original",
        immutable: true,
        changeLog: [],
        dataFlags: ["immutable_original", "from_estimate_doc", "user_attached"],
        pairedCalculationId: p.calculationId,
      });
      p.originalCalculationId = oid;
    }
    p.originalCalculationId = oid;
    const attachedOriginal = data.calculations.find((calculation) => calculation.id === oid);
    if (attachedOriginal) {
      attachedOriginal.pairedCalculationId = p.calculationId;
      attachedOriginal.assumptions = [
        `Неизменяемый снимок смет заказчика: ${rowCountNominative(positions.length)} итогов и позиций`,
        `Источники: ${sourceNames.join("; ")}`,
        `Распознано строк смет: ${recognizedCount}`,
        "Собственные ресурсы сюда не добавляются",
      ];
    }

    if (p.calculationId) {
      const draft = data.calculations.find((c) => c.id === p.calculationId);
      if (draft && draft.kind !== "customer_original") {
        draft.pairedCalculationId = oid;
      }
    }

    const mappedCount = opts?.mappedCount ?? recognizedCount;
    data.smetaExchanges.unshift({
      id: `sx-${Date.now()}`,
      orgId: p.orgId,
      procurementId: p.id,
      name: opts?.fileName ?? (sourceNames.join(", ") || "Смета заказчика"),
      at: now,
      authorId: actorId,
      positionsMapped: mappedCount,
      discrepancies: [],
      confirmed: true,
    });

    audit(
      data,
      actorId,
      "attach_customer_estimate",
      "procurement",
      procurementId,
      `Оригинал ${oid}; позиций ${positions.length}; распознано строк ${recognizedCount}; файлы ${sourceNames.join("; ")}`
    );
    return data;
  });
}

/** A schedule that still has only the empty navigation stages. */
function isNavigationStub(schedule: { stages: GprStage[] }): boolean {
  const names = new Set(["Подготовка", "Подготовка / мобилизация", "Основные работы"]);
  return schedule.stages.length > 0 && schedule.stages.every((stage) =>
    names.has(stage.name) &&
    (stage.resources ?? []).every((resource) => resource.quantity === 0 && (resource.rate == null || resource.rate === 0))
  );
}

function uploadedDocumentText(fileName: string, storedPath: string | undefined): string {
  if (!storedPath) return "";
  const bytes = readUpload(storedPath);
  if (!bytes?.length) return "";
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".text")) return bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (!lower.endsWith(".docx")) return "";
  const absolute = resolveUploadPath(storedPath);
  if (!absolute) return "";
  const result = spawnSync("unzip", ["-p", absolute, "word/document.xml"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout) return "";
  return result.stdout.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function procurementScheduleWindow(data: AppData, procurement: { id: string }, today: string): { start: string; end: string } | null {
  const documents = data.documents.filter((document) => document.procurementId === procurement.id && (
    document.category === "tz" || document.category === "contract"
    || /тз|техническ|договор|контракт/iu.test(`${document.fileName} ${document.title}`)
  ));
  const text = documents.flatMap((document) => [
    document.analyticalNote,
    ...document.citations.map((citation) => citation.text),
    uploadedDocumentText(document.fileName, document.storedPath),
  ]).join("\n");
  const period = periodFromDocumentText(text);
  if (period) return period;
  const days = calendarDurationDays(text);
  if (!days) return null;
  return { start: today, end: addScheduleDays(today, days - 1) };
}

function addScheduleDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function withMissingDatesNote(assumptions: string[], dated: boolean): string[] {
  if (dated) return assumptions.filter((item) => item !== GPR_DATES_MISSING);
  return assumptions.includes(GPR_DATES_MISSING) ? assumptions : [...assumptions, GPR_DATES_MISSING];
}

function commercialScheduleNotes(stages: GprStage[]): string[] {
  const hasDuration = stages.some((stage) => (stage.durationDays ?? 0) > 0);
  const hasUnconfirmed = stages.some((stage) => stage.durationBasis === "unconfirmed");
  const hasCrew = stages.some((stage) => (stage.benchmarkCrew?.length ?? 0) > 0);
  const hasGesnHintOnly = stages.some((stage) =>
    (stage.gesnHoursHint ?? 0) > 0 && !(stage.benchmarkSource ?? "").startsWith("Нормативные часы сметы"),
  );
  const notes = [GPR_FROM_CUSTOMER_SECTIONS];
  notes.push(hasDuration
    ? GPR_DURATION_FROM_OUTPUT
    : "Даты, длительность и производительность не извлечены из сметы; календарь ГПР нужно подтвердить по ТЗ и условиям объекта.");
  if (hasDuration && hasUnconfirmed) notes.push(GPR_UNCONFIRMED_DURATION);
  if (hasGesnHintOnly) notes.push(GPR_GESN_HINT_ONLY);
  if (hasCrew) notes.push(GPR_CREW_FROM_FILE4);
  notes.push("Ставки ресурсов берутся только из справочника компании; неподтверждённые ставки остаются пустыми.");
  return notes;
}

function normHoursFromProcurementFiles(
  data: AppData,
  procurementId: string,
  positions: Calculation["positions"],
): EstimateNormHours[] {
  const linked = new Set(positions.map((position) => position.sourceDocumentId).filter((id): id is string => Boolean(id)));
  const documents = data.documents.filter((document) =>
    document.procurementId === procurementId
    && document.storedPath
    && (linked.size === 0 || linked.has(document.id))
    && /\.xls[x]?$/iu.test(document.fileName),
  );
  const hints: EstimateNormHours[] = [];
  for (const document of documents) {
    const bytes = readUpload(document.storedPath!);
    if (!bytes?.length) continue;
    try {
      hints.push(...readEstimateNormHours(bytes));
    } catch {
      // One broken workbook does not cancel the other estimates.
    }
  }
  return hints;
}

function scheduleHasRealDuration(schedule: { stages: GprStage[] }): boolean {
  return schedule.stages.some((stage) => (stage.durationDays ?? 0) > 0);
}

function buildDraftStagesFromEstimate(
  positions: Calculation["positions"],
  now: string,
  period: { start: string; end: string } | null | undefined,
  calendar: { weekendDays: number[]; shiftsPerDay: number; hoursPerShift?: number } | undefined,
  hints: EstimateNormHours[],
): GprStage[] {
  return buildStagesFromEstimatePositions(positions, now, period, {
    weekendDays: calendar?.weekendDays ?? [],
    shiftsPerDay: calendar?.shiftsPerDay ?? 2,
    hoursPerShift: calendar?.hoursPerShift ?? 11,
    lookups: listShiftOutputCandidates(getDb()),
    normHours: hints,
  });
}

function repositionDurationStages(stages: GprStage[], weekendDays: number[]): GprStage[] {
  const movable = stages.map((stage, index) => ({ stage, index })).filter((row) => row.stage.durationBasis);
  const anchor = movable[0]?.stage.start;
  if (!anchor) return stages;
  const placed = placeByDuration(anchor, weekendDays, movable.map((row) => row.stage.durationDays ?? null));
  return stages.map((stage, index) => {
    const placeIndex = movable.findIndex((row) => row.index === index);
    if (placeIndex < 0) return stage;
    const spot = placed[placeIndex];
    return spot ? { ...stage, start: spot.start, end: spot.end } : stage;
  });
}

function mergeEstimateRowsIntoDraft(
  existing: Calculation["positions"],
  imported: Calculation["positions"],
  opts?: { legacy?: boolean },
): Calculation["positions"] {
  const importedBySourceId = new Map(
    imported.filter((position) => position.sourcePositionId)
      .map((position) => [position.sourcePositionId!, position])
  );
  const refreshed = existing.map((position) => {
    if (position.costRole === "commercial") return position;
    const source = position.sourcePositionId
      ? importedBySourceId.get(position.sourcePositionId)
      : undefined;
    if (!source) return position;
    if (opts?.legacy && position.costRole !== "customer_source") return position;
    return {
      ...position,
      costRole: "customer_source" as const,
      isWorkItem: source.isWorkItem ?? false,
      ...(source.isWorkItem ? { rateMissing: false } : {}),
      ...(source.resourceKind ? { resourceKind: source.resourceKind } : { resourceKind: undefined }),
      ...(source.sourceSectionName ? { sourceSectionName: source.sourceSectionName } : {}),
      ...(source.sourceWorkName ? { sourceWorkName: source.sourceWorkName } : {}),
    };
  });
  const known = new Set(refreshed.map((position) => position.sourcePositionId).filter(Boolean));
  return [
    ...refreshed,
    ...imported
      .filter((position) => !position.sourcePositionId || !known.has(position.sourcePositionId))
      .map((position) => ({ ...position, costRole: "customer_source" as const })),
  ];
}

/**
 * «Отправить в расчёт»: resource draft only. The schedule is a separate action.
 */
export function createProcurementSchedule(
  actorId: string,
  procurementId: string,
  opts?: { replaceUntagged?: boolean },
) {
  let outcome: "estimate" | "placeholder" | "unchanged" = "unchanged";
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertGprWrite(actor);
    const procurement = data.procurements.find((item) => item.id === procurementId);
    if (!procurement) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, procurement.orgId, "закупки");
    if (!procurement.calculationId) throw new Error("Сначала сформируйте расчёт");
    const now = new Date().toISOString();
    const draft = data.calculations.find((item) => item.id === procurement.calculationId && item.kind !== "customer_original");
    const period = procurementScheduleWindow(data, procurement, now.slice(0, 10));
    const logic = resolveTenderLogicSettings(data.organizations.find((org) => org.id === procurement.orgId));
    const calendar = calendarForNewSchedule(logic.shiftProfile);
    const stampAuthor = (stages: GprStage[]) => stages.map((stage) => ({ ...stage, createdBy: stage.createdBy ?? actorId }));
    const hints = normHoursFromProcurementFiles(data, procurement.id, draft?.positions ?? []);
    const derived = stampAuthor(buildDraftStagesFromEstimate(draft?.positions ?? [], now, period, calendar, hints));
    const existing = procurement.gprId ? data.schedules.find((item) => item.id === procurement.gprId) : undefined;
    const replaceWithOutput = existing
      && derived.length > 0
      && (isNavigationStub(existing) || (opts?.replaceUntagged && !scheduleHasRealDuration(existing)));
    if (replaceWithOutput && existing) {
      existing.stages = stampAuthor(derived);
      existing.calculationId = procurement.calculationId;
      existing.updatedAt = now;
      if (!existing.deadline && period) existing.deadline = period;
      if (opts?.replaceUntagged && calendar) existing.calendar = calendar;
      else if (!existing.calendar && calendar) existing.calendar = calendar;
      existing.assumptions = withMissingDatesNote(commercialScheduleNotes(derived), Boolean(period));
      outcome = "estimate";
      audit(data, actorId, "update", "gpr", existing.id, "Заготовка графика заменена длительностью по выработке");
      return data;
    }
    if (existing && isNavigationStub(existing)) {
      existing.calculationId = procurement.calculationId;
      existing.updatedAt = now;
      outcome = "placeholder";
      return data;
    }
    if (existing) return data;
    const gid = `g-${Date.now()}`;
    const stage1 = `gs-${Date.now()}`;
    const today = now.slice(0, 10);
    const anchor = period?.start ?? today;
    const placeholderStages: GprStage[] = [
      ensureStageResources({
        id: stage1,
        name: "Подготовка / мобилизация",
        start: anchor,
        end: anchor,
        sequence: 1,
        crewSize: 0,
      }),
      ensureStageResources({
        id: `gs-${Date.now() + 1}`,
        name: "Основные работы",
        start: anchor,
        end: anchor,
        sequence: 2,
        dependsOn: stage1,
        dependencyType: "FS",
        crewSize: 0,
      }),
    ];
    data.schedules.unshift({
      id: gid,
      orgId: procurement.orgId,
      procurementId: procurement.id,
      calculationId: procurement.calculationId,
      title: `ГПР (черновик) — ${procurement.title.slice(0, 48)}`,
      status: "v_rabote",
      version: 1,
      authorId: actorId,
      ...(calendar ? { calendar } : {}),
      ...(period ? { deadline: period } : {}),
      assumptions: withMissingDatesNote(derived.length
        ? commercialScheduleNotes(derived)
        : [
            "Начальные даты — заготовка на один день. Срок ТЗ по строкам сметы не делится.",
            "Длительность появится, когда в смете есть объём и норма выработки (ОРЧ, труба, бурение, справочники смен).",
            "Состав и количество ресурсов не подтверждены: заполните строки перед использованием итогов",
          ], Boolean(period)),
      stages: stampAuthor(derived.length ? derived : placeholderStages),
      updatedAt: now,
    });
    procurement.gprId = gid;
    outcome = derived.length ? "estimate" : "placeholder";
    audit(data, actorId, "create", "gpr", gid, "График создан отдельной кнопкой");
    return data;
  });
  return { outcome };
}

/**
 * One click on a draft that still shows «Старая логика себестоимости».
 * Writes the official 43/10/40 parameters and the 2×11 calendar, then rebuilds
 * a schedule that never received an output duration. Saved output stages stay.
 */
export function upgradeCalculationToOfficialLogic(actorId: string, calculationId: string) {
  let procurementId = "";
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((row) => row.id === calculationId);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    const logic = resolveTenderLogicSettings(data.organizations.find((org) => org.id === item.orgId));
    item.resourceScheduleParams = resourceParamsForNewCalculation(logic.shiftProfile);
    item.dataFlags = [
      ...(item.dataFlags ?? []).filter((flag) => flag !== LEGACY_ESTIMATE_SEEDED_COST && flag !== "seeded_from_customer_estimate"),
      "official_43_10_40",
    ];
    item.updatedAt = new Date().toISOString();
    item.changeLog = [
      ...(item.changeLog ?? []),
      {
        id: `cl-${Date.now()}`,
        at: item.updatedAt,
        actorId,
        detail: "Пересчёт по новой логике: 43/10/40 и 2×11",
      },
    ];
    procurementId = item.procurementId;
    audit(data, actorId, "recompute", "calculation", calculationId, "Пересчёт по новой логике 43/10/40 и 2×11");
    return data;
  });
  recomputeCalculationCost(actorId, calculationId, { useResourceScheduleEconomics: true });
  if (procurementId) {
    const procurement = readAppData().procurements.find((item) => item.id === procurementId);
    if (procurement?.calculationId) {
      try {
        createProcurementSchedule(actorId, procurementId, { replaceUntagged: true });
      } catch (error) {
        if (!(error instanceof Error) || !/Недостаточно прав/u.test(error.message)) throw error;
      }
    }
  }
  return readAppData();
}

/**
 * The procurement button «Сделать расчёт с ГПР».
 * A brand-new draft receives 43/10/40 and 2×11. An existing legacy draft is
 * upgraded in the same click. GPR duration comes from output, not an even TZ split.
 */
export function makeOfficialCalculationAndSchedule(actorId: string, procurementId: string) {
  sendProcurementToCalculation(actorId, procurementId);
  const snapshot = readAppData();
  const procurement = snapshot.procurements.find((item) => item.id === procurementId);
  if (!procurement?.calculationId) throw new Error("Расчёт не создан");
  const draft = snapshot.calculations.find((item) => item.id === procurement.calculationId);
  const legacy = isLegacyEstimateSeededCost(draft);
  if (draft && (legacy || !draft.resourceScheduleParams)) {
    upgradeCalculationToOfficialLogic(actorId, draft.id);
  }
  const schedule = createProcurementSchedule(actorId, procurementId, { replaceUntagged: true });
  const after = readAppData();
  const nextDraft = after.calculations.find((item) => item.id === procurement.calculationId);
  return {
    outcome: schedule.outcome,
    upgraded: Boolean(legacy),
    calculationId: procurement.calculationId,
    scheduleId: after.procurements.find((item) => item.id === procurementId)?.gprId ?? null,
    shiftProfile: nextDraft?.resourceScheduleParams
      ? {
          personnelShiftsPerDay: nextDraft.resourceScheduleParams.personnelShiftsPerDay,
          equipmentShiftsPerDay: nextDraft.resourceScheduleParams.equipmentShiftsPerDay,
          hoursPerShift: nextDraft.resourceScheduleParams.hoursPerShift,
          overheadRate: nextDraft.resourceScheduleParams.overheadRate,
          profitMarkupOnCostWithOh: nextDraft.resourceScheduleParams.profitMarkupOnCostWithOh,
        }
      : null,
  };
}

/** Explicit user action. Does not run on read or migration. */
export function applyScheduleAcceleration(actorId: string, scheduleId: string, lever: AccelerationLever) {
  let calculationId = "";
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertGprWrite(actor);
    const item = data.schedules.find((row) => row.id === scheduleId);
    if (!item) throw new Error("ГПР не найден");
    assertOrgAccess(actor, item.orgId, "ГПР");
    const shifts = shiftsForDeadline(item.stages, item.calendar?.shiftsPerDay);
    const view = deadlineView({ stages: item.stages, deadline: item.deadline ?? null, shiftsPerDay: shifts });
    if (!view.applicable) throw new Error("В этом графике нет длительности по выработке");
    if (!(view.overrunDays && view.overrunDays > 0)) throw new Error("Критический путь укладывается в срок ТЗ");
    if (lever === "shift" && !view.shiftAvailable) throw new Error("Смен уже две");
    if (lever === "mechanism" && !view.mechanismAvailable) throw new Error("Механизм добавить не к чему");
    const calc = data.calculations.find((row) => row.id === item.calculationId);
    if (calc) {
      if (calc.orgId !== item.orgId) throw new Error("Нет доступа к данным другой организации (расчёта)");
      assertOrgAccess(actor, calc.orgId, "расчёта");
      assertEditableCalculation(calc);
    }
    const weekendDays = item.calendar?.weekendDays ?? [];
    item.stages = item.stages.map((stage) => {
      if (stage.durationBasis !== "output_shift" && stage.durationBasis !== "site_daily") return stage;
      const next = applyLeverToStored(stage, lever);
      if (next === stage) return stage;
      if (lever === "shift") return { ...next, shiftsPerDay: 2 };
      const previousLinks = stage.mechanismCount;
      const resources = (stage.resources ?? []).map((resource) => {
        if (resource.kind !== "equipment" || previousLinks == null || next.mechanismCount == null) return resource;
        if (resource.quantityBasis != null && resource.quantityBasis !== "count_per_shift") return resource;
        if (resource.quantity !== previousLinks) return resource;
        return { ...resource, quantity: next.mechanismCount };
      });
      return { ...next, resources };
    });
    item.stages = repositionDurationStages(item.stages, weekendDays);
    if (lever === "shift") {
      item.calendar = {
        weekendDays,
        hoursPerShift: item.calendar?.hoursPerShift ?? 11,
        shiftsPerDay: 2,
        timezone: item.calendar?.timezone ?? "Asia/Krasnoyarsk",
      };
      if (calc?.resourceScheduleParams && calc.resourceScheduleParams.equipmentShiftsPerDay < 2) {
        calc.resourceScheduleParams = { ...calc.resourceScheduleParams, equipmentShiftsPerDay: 2 };
      }
    }
    item.updatedAt = new Date().toISOString();
    item.version = (item.version ?? 1) + 1;
    calculationId = calc ? item.calculationId : "";
    audit(data, actorId, "update", "gpr", item.id, lever === "shift" ? "Добавлена смена" : "Добавлен механизм");
    return data;
  });
  if (calculationId) recomputeCalculationCost(actorId, calculationId, { useResourceScheduleEconomics: true });
  return readAppData();
}

/** Explicit volume edit. Saved rows are not rewritten until this is called. */
export function updateVorVolume(
  actorId: string,
  calculationId: string,
  positionId: string,
  patch: { volume?: number; status?: "unconfirmed" | "confirmed" },
) {
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const calc = data.calculations.find((item) => item.id === calculationId);
    if (!calc) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, calc.orgId, "расчёта");
    if (calc.immutable || calc.kind === "customer_original") throw new Error("Этот расчёт нельзя изменять");
    const position = calc.positions.find((item) => item.id === positionId);
    if (!position || position.code !== "ВОР") throw new Error("Строка ведомости не найдена");
    const previousQty = position.quantity;
    const nextQty = patch.volume;
    const volumeChanged = nextQty != null && Number.isFinite(nextQty) && nextQty !== previousQty;
    if (nextQty != null) {
      if (!Number.isFinite(nextQty) || nextQty < 0 || nextQty > MAX_VOR_VOLUME) throw new Error("Укажите объём");
      position.quantity = nextQty;
    }
    if (volumeChanged) position.volumeStatus = "unconfirmed";
    else if (patch.status) position.volumeStatus = patch.status;
    if (volumeChanged && nextQty != null) {
      const schedule = data.schedules.find((item) => item.calculationId === calc.id && item.orgId === calc.orgId);
      const tracked = schedule?.stages.filter((stage) => stage.durationBasis && stageTracksVolumeRow(stage, position)) ?? [];
      if (schedule && tracked.length) {
        schedule.stages = schedule.stages.map((stage) => {
          if (!tracked.some((item) => item.id === stage.id)) return stage;
          const physical = stage.volumeRowIds?.length
            ? stage.volumeRowIds.reduce((sum, id) => sum + (id === position.id ? nextQty : (calc.positions.find((row) => row.id === id)?.quantity ?? 0)), 0)
            : nextQty;
          const priced = formulaAfterVolumeChange(stage, physical);
          return {
            ...stage,
            formulaVolume: priced.formulaVolume,
            durationDays: priced.durationDays,
            formulaPerPhysical: priced.formulaPerPhysical,
            planVolume: priced.planVolume,
          };
        });
        schedule.stages = repositionDurationStages(schedule.stages, schedule.calendar?.weekendDays ?? []);
        schedule.updatedAt = new Date().toISOString();
        schedule.version = (schedule.version ?? 1) + 1;
      }
    }
    calc.updatedAt = new Date().toISOString();
    audit(data, actorId, "update", "calculation", calc.id, "Правка объёма ВОР");
    return data;
  });
  recomputeCalculationCost(actorId, calculationId, { useResourceScheduleEconomics: true });
  return readAppData();
}

export function sendProcurementToCalculation(
  actorId: string,
  procurementId: string
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const p = data.procurements.find((x) => x.id === procurementId);
    if (!p) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, p.orgId, "закупки");
    const now = new Date().toISOString();
    const currentDir =
      data.directories.find((d) => d.type === "rascenki" && d.current) ??
      data.directories[0];

    // Snapshot existing linked calc as customer original if not already typed
    if (p.calculationId) {
      const existing = data.calculations.find((c) => c.id === p.calculationId);
      if (existing && !existing.kind) {
        existing.kind = "resource_draft";
        existing.immutable = false;
      }
      if (
        existing &&
        existing.kind === "customer_original" &&
        !p.originalCalculationId
      ) {
        p.originalCalculationId = existing.id;
      }
    }

    // Build immutable original from estimate document positions if none
    // A tender package can contain several local estimates (often numeric PDF
    // names stored as general documents). Use the same detector as manual attach.
    const estimateDocsWithData = estimateDocumentsForProcurement(data, p.id);
    const allEstimatePositions = estimateDocsWithData.flatMap((document) =>
      (document.estimatePositions ?? []).map((position) => ({ document, position }))
    );
    if (
      !p.originalCalculationId &&
      estimateDocsWithData.length > 0
    ) {
      const oid = `c-orig-${Date.now()}`;
      const customerSourcePositions = estimateDocsWithData.flatMap((document) => {
        const extracted = document.estimatePositions ?? [];
        const completeRates = extracted.length > 0 && extracted.every(
          (position) => !position.rateMissing && Number.isFinite(position.rate) && position.rate > 0
        );
        if (completeRates) {
          return extracted.map((position) => ({
            id: position.id,
            sourceDocumentId: document.id,
            sourcePositionId: position.id,
            code: position.code,
            name: position.name,
            unit: position.unit,
            quantity: position.quantity,
            rate: position.rate,
            ...(position.isWorkItem ? { isWorkItem: true } : {}),
          }));
        }
        const total = document.analysis?.costThousand;
        return total != null
          ? [{
              id: `cp-orig-${document.id}`,
              sourceDocumentId: document.id,
              code: "CUST-TOTAL",
              name: document.analysis?.workName || `Итог сметы · ${document.fileName}`,
              unit: "компл",
              quantity: 1,
              rate: Math.round(total * 1000),
            }]
          : [];
      });
      const sourceFileNames = estimateDocsWithData.map((document) => document.fileName);
      const rowsWithoutSourceRates = allEstimatePositions.filter(({ position }) =>
        position.rateMissing || !(Number.isFinite(position.rate) && position.rate > 0)
      ).length;
      data.calculations.unshift({
        id: oid,
        orgId: p.orgId,
        procurementId: p.id,
        title: `Смета заказчика (оригинал) — ${p.title.slice(0, 40)}`,
        status: "gotovo",
        positions: customerSourcePositions.length
          ? customerSourcePositions
          : [{ id: `cp-orig-${Date.now()}`, code: "CUST-TOTAL", name: "Итог сметы заказчика", unit: "компл", quantity: 1, rate: 0, rateMissing: true }],
        assumptions: [
          rowsWithoutSourceRates
            ? `${recognizedRowsPhrase(allEstimatePositions.length).replace(/^./u, (letter) => letter.toUpperCase())} по ${estimateDocsWithData.length} сметам; для ${rowCountGenitive(rowsWithoutSourceRates)} исходная ставка не извлечена надёжно, поэтому оригинал показывает подтверждённый итог каждой сметы без подмены ставок нулями.`
            : `Неизменяемый снимок сметы заказчика: ${allEstimatePositions.length} распознанных позиций.`,
          `Источники: ${sourceFileNames.join("; ")}`,
          "Собственные ресурсы сюда не добавляются",
        ],
        scenario: "bazovyy",
        scenarioFactor: 1,
        participateDecision: null,
        directoryVersionId: currentDir?.id ?? "dir-rascenki-1",
        version: 1,
        authorId: actorId,
        updatedAt: now,
        kind: "customer_original",
        immutable: true,
        changeLog: [],
        dataFlags: ["immutable_original", "from_estimate_doc"],
      });
      p.originalCalculationId = oid;
    }

    // Customer estimate is a price ceiling, not our cost. translation_table
    // keeps a source sheet; empty_packages leaves the commercial draft empty of those rows.
    const logic = resolveTenderLogicSettings(data.organizations.find((org) => org.id === p.orgId));
    const positionsFromEstimate = logic.importEstimateRowsMode === "empty_packages"
      ? []
      : allEstimatePositions
      .filter(({ position }) =>
        Boolean(position.code && position.name && position.unit) &&
        Number.isFinite(position.quantity) &&
        position.quantity !== 0
      )
      .map(({ document, position }) => {
        const hit = position.isWorkItem ? null : matchingDirectoryRate(data, {
          code: position.code,
          name: position.name,
          unit: position.unit,
          resourceKind: position.resourceKind,
          isWorkItem: position.isWorkItem,
        }, EXCEL_RESOURCE_SCHEDULE_DEFAULTS.personHourRate);
        const unitCompatible = Boolean(hit);
        return {
          id: `draft-${position.id}`,
          costRole: "customer_source" as const,
          code: position.code,
          name: position.name,
          unit: position.unit,
          quantity: position.quantity,
          // The customer rate is never copied. A directory rate is only for the reference reprice.
          rate: unitCompatible ? hit!.rate : 0,
          rateMissing: !unitCompatible && !position.isWorkItem,
          ...(position.isWorkItem ? { isWorkItem: true } : {}),
          ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
          ...(position.sectionName ? { sourceSectionName: position.sectionName } : {}),
          ...(position.workName ? { sourceWorkName: position.workName } : {}),
          sourceDocumentId: document.id,
          sourcePositionId: position.id,
          ...(unitCompatible ? {
            rateSourceDirectoryId: hit!.dirId,
            rateBasis: hit!.basis === "person_hour" ? "person_hour" as const : "directory" as const,
          } : {}),
        };
      });
    let draftId = p.calculationId;
    const linked = draftId
      ? data.calculations.find((c) => c.id === draftId)
      : undefined;
    if (!linked || linked.kind === "customer_original" || linked.immutable) {
      draftId = `c-draft-${Date.now()}`;
      const seedPositions =
        linked && !linked.immutable && linked.positions.length > 0
          ? structuredClone(linked.positions)
          : positionsFromEstimate;
      data.calculations.unshift({
        id: draftId,
        orgId: p.orgId,
        procurementId: p.id,
        title: `Ресурсный черновик — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        positions: seedPositions,
        assumptions: [
          seedPositions.length
            ? `Ведомость из сметы заказчика (${seedPositions.length} строк) записана отдельно от коммерческого черновика. Исходные сметы неизменны. Это не расчёт себестоимости.`
            : logic.importEstimateRowsMode === "empty_packages" && allEstimatePositions.length
              ? "Коммерческий черновик создан без строк сметы заказчика. Оригинал сметы и распознанные позиции сохранены."
              : "Ресурсный черновик создан пустым: в документах нет распознанных строк сметы",
          seedPositions.length
            ? `В ведомость перенесены только код, наименование, единица и количество. ${COMPANY_RATE_RULE}; цена заказчика не копировалась. Ставка справочника нужна только для справочной переоценки.`
            : "Загрузите смету XLSX с позициями или добавьте ресурсы из справочников; система не будет угадывать объёмы и тарифы",
          "Проверьте состав ресурсов и каждую ставку до использования итогов",
          "Не является утверждённой нормативной сметой",
          "Цифры из справочников / объёмов; причины отклонений без выдумок",
          ...(p.nmck == null ? ["НМЦК источник не публикует"] : []),
        ],
        scenario: "bazovyy",
        scenarioFactor: 1,
        participateDecision: "na_rassmotrenii",
        directoryVersionId: currentDir?.id ?? "dir-rascenki-1",
        version: 1,
        authorId: actorId,
        updatedAt: now,
        kind: "resource_draft",
        immutable: false,
        ...defaultOwnerFields(data, p.orgId, actorId),
        pairedCalculationId: p.originalCalculationId,
        changeLog: [
          {
            id: `cl-${Date.now()}`,
            at: now,
            actorId,
            detail: "Создан при «Отправить в расчёт»",
          },
        ],
        dataFlags: [
          "requires_manual_check",
          "no_accuracy_promise",
          ...(seedPositions.length ? ["official_43_10_40", ESTIMATE_ROWS_AS_SOURCE_SHEET] : ["awaiting_estimate_rows"]),
        ],
        ...(seedPositions.length
          ? { resourceScheduleParams: resourceParamsForNewCalculation(logic.shiftProfile) }
          : {}),
      });
      p.calculationId = draftId;
    } else {
      linked.kind = "resource_draft";
      linked.immutable = false;
      if (!linked.ownerUserId) {
        const owner = defaultOwnerFields(data, p.orgId, linked.authorId || actorId);
        linked.ownerUserId = owner.ownerUserId;
        linked.ownerRole = owner.ownerRole;
      }
      linked.pairedCalculationId = p.originalCalculationId;
      linked.status = "v_rabote";
      if (positionsFromEstimate.length > 0) {
        const previousCount = linked.positions.length;
        linked.positions = mergeEstimateRowsIntoDraft(linked.positions, positionsFromEstimate, {
          legacy: isLegacyEstimateSeededCost(linked),
        });
        const addedCount = linked.positions.length - previousCount;
        if (addedCount > 0 && previousCount > 0) {
          linked.assumptions = [
            ...(linked.assumptions ?? []),
            `В ведомость добавлено ${rowCountNominative(addedCount)} сметы заказчика. Ручные коммерческие позиции сохранены и не смешаны с ведомостью.`,
          ];
        }
      }
      if (linked.positions.length > 0 && positionsFromEstimate.length > 0) {
        linked.assumptions = [
          ...(linked.assumptions ?? []).filter(
            (assumption) => !assumption.startsWith("Ресурсный черновик создан пустым:")
          ),
          `Ведомость из ${estimateDocsWithData.length} смет(ы) записана отдельно. Исходные сметы неизменны. Это не расчёт себестоимости.`,
          `Для строк ведомости перенесены только код, наименование, единица и количество. ${COMPANY_RATE_RULE}; цена заказчика не копировалась.`,
          "Проверьте состав ресурсов и каждую ставку до использования итогов",
        ];
        linked.dataFlags = [
          ...(linked.dataFlags ?? []).filter((flag) => flag !== "awaiting_estimate_rows" && flag !== "seeded_from_customer_estimate"),
          ESTIMATE_ROWS_AS_SOURCE_SHEET,
          "requires_manual_check",
        ];
        // Defaults belong to the first draft only. A repeat send must not
        // fill a missing coefficient into an existing schedule or replace an edit.
        linked.resourceScheduleParams ??= resourceParamsForNewCalculation(logic.shiftProfile);
      }
      linked.updatedAt = now;
      linked.changeLog = [
        ...(linked.changeLog ?? []),
        {
          id: `cl-${Date.now()}`,
          at: now,
          actorId,
          detail: "Повторная отправка в расчёт",
        },
      ];
      draftId = linked.id;
      p.calculationId = draftId;
    }

    if (p.originalCalculationId) {
      const orig = data.calculations.find(
        (c) => c.id === p.originalCalculationId
      );
      if (orig) {
        orig.pairedCalculationId = draftId;
        orig.immutable = true;
        orig.kind = "customer_original";
      }
    }

    if (p.gprId) {
      const workPositionIds = new Set(
        positionsFromEstimate.filter((position) => position.isWorkItem).map((position) => position.id)
      );
      const workPositionsByName = new Map<string, typeof positionsFromEstimate>();
      for (const position of positionsFromEstimate) {
        if (!position.isWorkItem) continue;
        const key = (position.sourceWorkName?.trim() || position.name.trim()).toLocaleLowerCase("ru-RU");
        workPositionsByName.set(key, [...(workPositionsByName.get(key) ?? []), position]);
      }
      data.schedules = data.schedules.map((s) => {
        if (s.id !== p.gprId) return s;
        if (isNavigationStub(s)) return { ...s, calculationId: draftId!, updatedAt: now };

        // Migrate the old PDF mapping where ФирЕР work rows appeared as people.
        // Preserve user-entered dates, volumes, unrelated resources and facts.
        const stages = s.stages.map((stage) => {
          const key = (stage.workName?.trim() || stage.name.trim()).toLocaleLowerCase("ru-RU");
          const workRows = workPositionsByName.get(key) ?? [];
          if (!workRows.length) return stage;
          const units = new Set(workRows.map((position) => position.unit));
          const volume = units.size === 1
            ? workRows.reduce((total, position) => total + position.quantity, 0)
            : null;
          return {
            ...stage,
            ...(stage.planVolume == null && volume != null
              ? { planVolume: volume, planUnit: workRows[0].unit }
              : {}),
            resources: (stage.resources ?? []).filter((resource) =>
              !resource.sourceKey || !workPositionIds.has(resource.sourceKey)
            ),
          };
        });
        const migrated = stages.some((stage, index) =>
          (stage.resources ?? []).length !== (s.stages[index].resources ?? []).length ||
          stage.planVolume !== s.stages[index].planVolume
        );
        return {
          ...s,
          calculationId: draftId!,
          updatedAt: now,
          ...(migrated ? {
            stages,
            assumptions: [
              ...(s.assumptions ?? []).filter((item) => !item.startsWith("Строки работ ФирЕР")),
              "Строки работ ФирЕР показаны как физический объём этапа, не как численность людей. Даты и производительность сохранены; проверьте состав и ставки ресурсов.",
            ],
          } : {}),
        };
      });
    }

    if (p.reviewStatus === "novaya") {
      p.reviewStatus = "na_rassmotrenii";
    }
    p.status = "v_rabote";
    const rebuilt = buildProjectAnalytics(
      p,
      data.documents.filter((d) => d.procurementId === p.id)
    );
    const scheduleDocs = data.documents.filter((document) => document.procurementId === p.id);
    const previous = backfillLegacyModelMemo(p.analytics, scheduleDocs, rebuilt);
    if (previous && modelMemoIsCurrent(previous, scheduleDocs)) {
      p.analytics = withDeterministicCoverage(previous, rebuilt);
    } else {
      const staleModel = Boolean(previous && (modelWroteAnalyticalNote(previous) || previous.memoStale));
      p.analytics = localNoteAnalytics(rebuilt, scheduleDocs, staleModel);
    }

    audit(
      data,
      actorId,
      "send_to_calc",
      "procurement",
      procurementId,
      `Черновик ${draftId}; оригинал ${p.originalCalculationId ?? "нет"}`
    );
    return data;
  });
}

/** Self-registration: create org + first admin (not superadmin). No email. */
export function registerNewOrganization(input: {
  orgName: string;
  inn: string;
  name: string;
  email: string;
  password: string;
}): { token: string; joinCode: string; userId: string; orgId: string } {
  const email = input.email.trim().toLowerCase();
  const orgName = input.orgName.trim();
  const inn = input.inn.trim();
  if (!orgName || !inn || !input.name.trim() || !email || !input.password) {
    throw new Error("Укажите организацию, ИНН, имя, email и пароль");
  }
  if (input.password.length < 8) {
    throw new Error("Пароль не короче 8 символов");
  }
  let token = "";
  let joinCode = "";
  let userId = "";
  let orgId = "";
  mutateAppData((data) => {
    if (data.users.some((u) => u.email.toLowerCase() === email)) {
      throw new Error("Пользователь с таким email уже существует");
    }
    if (data.organizations.some((o) => o.inn === inn)) {
      throw new Error("Организация с таким ИНН уже есть — используйте код вступления");
    }
    orgId = `org-${Date.now()}`;
    userId = `u-${Date.now()}`;
    joinCode = `JOIN-${inn.slice(-4)}-${randomBytes(2).toString("hex").toUpperCase()}`;
    data.organizations.push({
      id: orgId,
      name: orgName,
      inn,
      active: true,
      joinCode,
    });
    data.users.push({
      id: userId,
      email,
      password: hashPassword(input.password),
      name: input.name.trim(),
      role: "admin",
      orgId,
      blocked: false,
      sections: DEFAULT_SECTIONS.admin,
      createdAt: new Date().toISOString(),
    });
    data.roleHistory.unshift({
      id: `rh-${Date.now()}`,
      userId,
      fromRole: null,
      toRole: "admin",
      changedBy: userId,
      at: new Date().toISOString(),
      comment: "Саморегистрация организации",
    });
    audit(
      data,
      userId,
      "create",
      "organization",
      orgId,
      `Саморегистрация ${orgName}`
    );
    return data;
  });
  token = createSession(userId);
  return { token, joinCode, userId, orgId };
}

/** Join existing org by join code — tender role only, no privilege escalation. */
export function joinOrganizationByCode(input: {
  joinCode: string;
  name: string;
  email: string;
  password: string;
}): { token: string; userId: string; orgId: string } {
  const email = input.email.trim().toLowerCase();
  const code = input.joinCode.trim().toUpperCase();
  if (!code || !input.name.trim() || !email || !input.password) {
    throw new Error("Укажите код вступления, имя, email и пароль");
  }
  if (input.password.length < 8) {
    throw new Error("Пароль не короче 8 символов");
  }
  let token = "";
  let userId = "";
  let orgId = "";
  mutateAppData((data) => {
    if (data.users.some((u) => u.email.toLowerCase() === email)) {
      throw new Error("Пользователь с таким email уже существует");
    }
    const org = data.organizations.find(
      (o) => (o.joinCode ?? "").toUpperCase() === code && o.active
    );
    if (!org) throw new Error("Код вступления недействителен");
    orgId = org.id;
    userId = `u-${Date.now()}`;
    data.users.push({
      id: userId,
      email,
      password: hashPassword(input.password),
      name: input.name.trim(),
      role: "tender",
      orgId,
      blocked: false,
      sections: DEFAULT_SECTIONS.tender,
      createdAt: new Date().toISOString(),
    });
    data.roleHistory.unshift({
      id: `rh-${Date.now()}`,
      userId,
      fromRole: null,
      toRole: "tender",
      changedBy: userId,
      at: new Date().toISOString(),
      comment: "Вступление по коду организации",
    });
    audit(
      data,
      userId,
      "create",
      "user",
      userId,
      `Join org ${orgId} as tender`
    );
    return data;
  });
  token = createSession(userId);
  return { token, userId, orgId };
}

function markMissingCommercialCost(item: Calculation) {
  if (isLegacyEstimateSeededCost(item)) return;
  const priced = item.positions.some((position) => positionFeedsOfficialCost(position));
  if (priced && item.costSummary) {
    const customerKeys = new Set(
      item.positions
        .filter((position) => position.costRole === "customer_source")
        .flatMap((position) => [position.id, position.code, position.name]),
    );
    item.costSummary.incomplete = item.costSummary.incomplete.filter((flag) => {
      if (flag === "no_commercial_rows") return false;
      const label = flag.includes(":") ? flag.slice(flag.indexOf(":") + 1) : "";
      return !(label && customerKeys.has(label) && (flag.startsWith("rate:") || flag.startsWith("missing_rate:")));
    });
    const billable = item.positions.filter((position) =>
      position.costRole !== "customer_source" && !position.isWorkItem && position.code !== "НР" && position.code !== "СП",
    );
    if (billable.length > 0 && billable.every((position) => !position.rateMissing)) {
      item.costSummary.totalsIncomplete = item.costSummary.incomplete.length > 0;
    }
    return;
  }
  const at = new Date().toISOString();
  if (!item.costSummary) {
    item.costSummary = {
      C0: 0,
      C: 0,
      reserve: 0,
      profit: 0,
      priceExVat: 0,
      vatAmount: null,
      priceIncVat: null,
      method: "cost-engine:no-commercial-rows",
      incomplete: ["no_commercial_rows"],
      totalsIncomplete: true,
      at,
    };
    return;
  }
  item.costSummary.totalsIncomplete = true;
  if (!item.costSummary.incomplete.includes("no_commercial_rows")) {
    item.costSummary.incomplete = [...item.costSummary.incomplete, "no_commercial_rows"];
  }
}

function attachReferenceReprice(
  item: Calculation,
  data: AppData,
  patch?: {
    siteOverhead?: number;
    officeOverhead?: number;
    reserve?: number;
    profitMethod?: "markup" | "margin";
    profitRate?: number;
    includeReserveInPriceBase?: boolean;
    useResourceScheduleEconomics?: boolean;
  },
) {
  const source = item.positions.filter((position) => position.costRole === "customer_source");
  if (!source.length) {
    delete item.referenceReprice;
    item.dataFlags = (item.dataFlags ?? []).filter((flag) => flag !== REFERENCE_REPRICE_NOT_COST);
    return;
  }
  const useRs = patch?.useResourceScheduleEconomics ?? Boolean(item.resourceScheduleParams);
  const buckets = bucketsFromPositions(source, item.scenarioFactor || 1, { includeCustomerSource: true });
  const northern = northernInputsForEngine(item);
  const rs = item.resourceScheduleParams;
  const direct = buckets.labor + buckets.materials + buckets.equipment + buckets.other;
  const site = useRs
    ? patch?.siteOverhead ?? Math.round(direct * (rs?.overheadRate ?? 0.43) * 100) / 100
    : patch?.siteOverhead ?? overheadsFromWorks(buckets.labor + buckets.equipment).nr;
  const profitRate = useRs
    ? patch?.profitRate ?? rs?.profitMarkupOnCostWithOh ?? 0.4
    : patch?.profitRate ?? 0.08;
  const engine = runCostEngine({
    directLabor: buckets.labor,
    directMaterials: buckets.materials,
    directEquipment: buckets.equipment,
    directSubcontract: buckets.other,
    logisticsIncludingBus: 0,
    siteOverhead: site,
    officeOverhead: 0,
    reserve: 0,
    profitMethod: patch?.profitMethod ?? "markup",
    profitRate,
    includeReserveInPriceBase: patch?.includeReserveInPriceBase ?? (useRs ? false : true),
    vatPercent: item.vatPercent ?? null,
    northern,
  });
  const linkedSchedule = data.schedules.find((schedule) => schedule.calculationId === item.id);
  const matNeeds = buildMaterialNeeds({ positions: source, stages: linkedSchedule?.stages });
  const incomplete = [
    ...engine.incomplete,
    ...source
      .filter((position) => position.rateMissing && !position.isWorkItem)
      .slice(0, 20)
      .map((position) => `missing_rate:${position.code || position.id}`),
    ...(buckets.materialsUnpriced ? ["materials_positions"] : []),
    ...materialNeedsIncomplete(matNeeds).slice(0, 20),
  ];
  const summary: CostSummarySnapshot = {
    C0: engine.C0,
    C: engine.C,
    reserve: engine.reserve,
    profit: engine.profit,
    priceExVat: engine.priceExVat,
    vatAmount: engine.vatAmount,
    priceIncVat: engine.priceIncVat,
    method: `reference-reprice-not-cost+${useRs ? "resource-schedule-excel" : engine.profitMethod}`,
    incomplete,
    totalsIncomplete: incomplete.length > 0,
    at: new Date().toISOString(),
  };
  const saved = item.costSummary;
  item.costSummary = summary;
  applyNorthernFold(item, buckets.labor);
  item.referenceReprice = item.costSummary;
  item.costSummary = saved;
  if (item.referenceReprice && !item.referenceReprice.method.includes("reference-reprice-not-cost")) {
    item.referenceReprice.method = `reference-reprice-not-cost+${item.referenceReprice.method}`;
  }
  item.dataFlags = [
    ...(item.dataFlags ?? []).filter((flag) => flag !== REFERENCE_REPRICE_NOT_COST),
    REFERENCE_REPRICE_NOT_COST,
  ];
}

function assignCommitteeSnapshot(item: Calculation, data: AppData) {
  const procurement = data.procurements.find((row) => row.id === item.procurementId);
  const commercial = item.positions.filter((position) =>
    position.costRole !== "customer_source" && !position.isWorkItem && position.code !== "НР" && position.code !== "СП",
  );
  const confirmed = Boolean(
    item.costSummary
    && commercial.some((position) => positionFeedsOfficialCost(position))
    && commercial.every((position) => !position.rateMissing)
    && item.costSummary.C0 > 0,
  );
  item.committeeSnapshot = buildCommitteeSnapshot({
    nmck: procurement?.nmck,
    officialCost: item.costSummary?.C,
    officialConfirmed: confirmed,
  });
}

export function shiftGprStage(
  actorId: string,
  scheduleId: string,
  stageId: string,
  deltaDays: number,
  opts?: { cascade?: boolean; resizeDays?: number | null }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    assertGprWrite(actor);
    const item = data.schedules.find((s) => s.id === scheduleId);
    if (!item) throw new Error("ГПР не найден");
    assertOrgAccess(actor, item.orgId, "ГПР");
    const previousStages = item.stages;
    const result = shiftStages(item.stages, stageId, deltaDays, opts);
    const oldStageById = new Map(previousStages.map((stage) => [stage.id, stage]));
    item.stages = result.stages.map((stage) => {
      const previous = oldStageById.get(stage.id);
      if (!previous) return stage;
      const oldCalendarDays = Math.max(1, totalStageCalendarDays([previous]));
      const newCalendarDays = Math.max(1, totalStageCalendarDays([stage]));
      const weekendDays = item.calendar?.weekendDays ?? [0, 6];
      const oldWorkDays = Math.max(1, workingDaysBetween(previous.start, previous.end, weekendDays));
      const newWorkDays = Math.max(1, workingDaysBetween(stage.start, stage.end, weekendDays));
      if (oldWorkDays === newWorkDays && oldCalendarDays === newCalendarDays) return stage;
      return {
        ...stage,
        resources: (stage.resources ?? []).map((resource) => {
          if (resource.kind === "material") return resource;
          // Resource duration follows its GPR stage until the user gives it a
          // different P value. Explicitly shortened/extended resource windows
          // therefore stay independent from the stage calendar.
          return resource.days == null || resource.days === oldWorkDays || resource.days === oldCalendarDays
            ? { ...resource, days: newWorkDays }
            : resource;
        }),
      };
    });
    item.conflicts = result.conflicts;
    item.updatedAt = new Date().toISOString();
    item.version = (item.version ?? 1) + 1;
    // Recalc dependent calendar costs on linked draft (bus days ← stage lengths)
    const calc = data.calculations.find((c) => c.id === item.calculationId);
    const syncedResourceDraft = Boolean(
      calc &&
        calc.kind !== "customer_original" &&
        isResourceLinkedDraft(calc) &&
        calc.resourceScheduleParams &&
        scheduleHasPopulatedResources(item.stages)
    );
    if (calc && syncedResourceDraft) {
      const reserve = calc.costSummary?.reserve ?? 0;
      Object.assign(
        calc,
        syncDraftFromStages(calc, item.stages, { replacePositions: true }).calc
      );
      if (calc.costSummary) calc.costSummary.reserve = reserve;
      finishSyncedCommercialCost(calc);
    }
    if (calc && calc.kind !== "customer_original") {
      const days = gprCoveredDays(item.stages, item.calendar).length;
      if (calc.busRoutes?.length) {
        calc.busRoutes = calc.busRoutes.map((r) => ({ ...r, days }));
      }
      let shiftLabor = 0;
      if (!syncedResourceDraft && (calc.costSummary || (calc.busRoutes?.length ?? 0) > 0)) {
        const buckets = bucketsFromPositions(
          calc.positions,
          calc.scenarioFactor || 1
        );
        let logistics = 0;
        for (const r of calc.busRoutes ?? []) {
          logistics =
            Math.round((logistics + busCost(r).total) * 100) / 100;
        }
        const northern = northernInputsForEngine(calc);
        const rs = calc.resourceScheduleParams;
        const useRs = Boolean(rs);
        shiftLabor = buckets.labor;
        const Dapprox =
          buckets.labor +
          buckets.materials +
          buckets.equipment +
          buckets.other +
          logistics;
        const site = useRs
          ? Math.round(Dapprox * rs!.overheadRate * 100) / 100
          : overheadsFromWorks(buckets.labor + buckets.equipment).nr;
        const engine = runCostEngine({
          directLabor: buckets.labor,
          directMaterials: buckets.materials,
          directEquipment: buckets.equipment,
          directSubcontract: buckets.other,
          logisticsIncludingBus: logistics,
          siteOverhead: site,
          officeOverhead: 0,
          reserve: calc.costSummary?.reserve ?? 0,
          profitMethod: "markup",
          profitRate: useRs ? rs!.profitMarkupOnCostWithOh : 0.08,
          includeReserveInPriceBase: useRs ? false : true,
          vatPercent: calc.vatPercent ?? null,
          northern,
        });
        calc.costSummary = {
          C0: engine.C0,
          C: engine.C,
          reserve: engine.reserve,
          profit: engine.profit,
          priceExVat: engine.priceExVat,
          vatAmount: engine.vatAmount,
          priceIncVat: engine.priceIncVat,
          direct: engine.direct.D,
          overhead: site,
          method: useRs
            ? `cost-engine:${engine.profitMethod}+gpr-shift+resource-schedule-excel`
            : `cost-engine:${engine.profitMethod}+gpr-shift`,
          incomplete: engine.incomplete,
          at: new Date().toISOString(),
        };
      }
      if (calc.resourceScheduleParams && !syncedResourceDraft) {
        applyNorthernFold(calc, shiftLabor);
        applyClientEconomics(calc);
      }
      markMissingCommercialCost(calc);
      assignCommitteeSnapshot(calc, data);
      calc.dataFlags = [
        ...(calc.dataFlags ?? []).filter((f) => f !== "gpr_dates_shifted"),
        "gpr_dates_shifted",
      ];
      calc.updatedAt = new Date().toISOString();
    }
    audit(
      data,
      actorId,
      "shift",
      "gpr",
      scheduleId,
      `Сдвиг ${stageId} на ${deltaDays} дн.; конфликтов ${result.conflicts.length}; связанные рабочие дни автобуса=${gprCoveredDays(item.stages, item.calendar).length}`
    );
    return data;
  });
}

function northernInputsForEngine(calc: Calculation): NorthernInputs {
  const fold = calc.northern?.applicable !== false && calc.resourceScheduleParams?.districtCoefficient != null;
  return calc.northern ?? {
    applicable: fold,
    confirmedItems: [],
    notes: fold ? [] : ["Северные затраты отключены"],
  };
}

function northernDelta(district: number, allowance: number, params: { overheadRate: number; profitMarkupOnCostWithOh: number }) {
  const extraDirect = Math.round((district + allowance) * 100) / 100;
  const extraOverhead = Math.round(extraDirect * params.overheadRate * 100) / 100;
  const extraProfit = Math.round((extraDirect + extraOverhead) * params.profitMarkupOnCostWithOh * 100) / 100;
  return {
    extraDirect,
    extraOverhead,
    extraProfit,
    added: Math.round((extraDirect + extraOverhead + extraProfit) * 100) / 100,
  };
}

function applyNorthernFold(calc: Calculation, labor: number) {
  const params = calc.resourceScheduleParams;
  const summary = calc.costSummary;
  if (!summary || params?.districtCoefficient == null || calc.northern?.applicable === false) return;
  const share = params.northernPayrollShare ?? 0.8;
  const lines = northernAdditionLines(labor, {
    districtCoefficient: params.districtCoefficient,
    northernPayrollShare: share,
    overheadRate: params.overheadRate,
  });
  const district = lines[0]?.amount ?? 0;
  const allowance = lines[1]?.amount ?? 0;
  const next = northernDelta(district, allowance, params);
  // A stored total may already contain this fold. Remove that copy before
  // writing the current one so a second pass does not add it again.
  const previous = summary.northernAdjustments
    ? northernDelta(summary.northernAdjustments.district, summary.northernAdjustments.allowance, params)
    : null;
  const basePrice = Math.round((summary.priceExVat - (previous?.added ?? 0)) * 100) / 100;
  const baseC0 = Math.round((summary.C0 - (previous ? previous.extraDirect + previous.extraOverhead : 0)) * 100) / 100;
  const baseProfit = Math.round((summary.profit - (previous?.extraProfit ?? 0)) * 100) / 100;
  const priceExVat = Math.round((basePrice + next.added) * 100) / 100;
  const C0 = Math.round((baseC0 + next.extraDirect + next.extraOverhead) * 100) / 100;
  const profit = Math.round((baseProfit + next.extraProfit) * 100) / 100;
  const { extraDirect, extraOverhead, extraProfit, added } = next;
  const vatAmount = calc.vatPercent == null
    ? summary.vatAmount
    : Math.round(priceExVat * calc.vatPercent) / 100;
  const foldedDirect = typeof summary.direct === "number"
    ? Math.round((summary.direct - (previous?.extraDirect ?? 0) + extraDirect) * 100) / 100
    : undefined;
  const foldedOverhead = typeof summary.overhead === "number"
    ? Math.round((summary.overhead - (previous?.extraOverhead ?? 0) + extraOverhead) * 100) / 100
    : undefined;
  calc.costSummary = {
    ...summary,
    C0,
    C: Math.round((C0 + (summary.reserve ?? 0)) * 100) / 100,
    profit,
    priceExVat,
    vatAmount,
    priceIncVat: vatAmount == null ? null : Math.round((priceExVat + vatAmount) * 100) / 100,
    ...(foldedDirect != null ? { direct: foldedDirect } : {}),
    ...(foldedOverhead != null ? { overhead: foldedOverhead } : {}),
    northernAdjustments: {
      district,
      allowance,
      overhead: lines[2]?.amount ?? extraOverhead,
      total: priceExVat,
    },
    ...(summary.resourceSlices ? {
      resourceSlices: {
        ...summary.resourceSlices,
        direct: Math.round((summary.resourceSlices.direct - (previous?.extraDirect ?? 0) + extraDirect) * 100) / 100,
        overhead: Math.round((summary.resourceSlices.overhead - (previous?.extraOverhead ?? 0) + extraOverhead) * 100) / 100,
        costWithOh: Math.round((summary.resourceSlices.costWithOh - (previous ? previous.extraDirect + previous.extraOverhead : 0) + extraDirect + extraOverhead) * 100) / 100,
        profit: Math.round((summary.resourceSlices.profit - (previous?.extraProfit ?? 0) + extraProfit) * 100) / 100,
        total: Math.round((summary.resourceSlices.total - (previous?.added ?? 0) + added) * 100) / 100,
      },
    } : {}),
  };
}

function mergeEconomicsManual(
  current: EconomicsManual | undefined,
  patch: {
    overhead?: EconomicsManual["overhead"] | null;
    reserve?: EconomicsManual["reserve"] | null;
    profit?: EconomicsManual["profit"] | null;
  },
): EconomicsManual {
  const next: EconomicsManual = { ...(current ?? {}) };
  for (const key of ["overhead", "reserve", "profit"] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const clean = sanitizeEconomicsOverride(patch[key]);
    if (clean == null) delete next[key];
    else next[key] = clean;
  }
  return next;
}

/**
 * Same tail as a full resource recompute: office overhead, northern extras,
 * then the client 43/10/40 price. A raw tree rollup has none of those.
 */
function finishSyncedCommercialCost(calc: Calculation) {
  if (!calc.resourceScheduleParams || !calc.costSummary) return;
  if (calc.costSummary.resourceSlices) applyResourceDraftAdjustments(calc);
  applyNorthernFold(calc, calc.costSummary?.resourceSlices?.labor ?? 0);
  applyClientEconomics(calc);
}

/** Official price only. Reference reprice keeps reserve 0 and is not passed here. */
function applyClientEconomics(calc: Calculation) {
  const summary = calc.costSummary;
  const params = calc.resourceScheduleParams;
  if (!summary || !params) return;
  const next = applyClientCommercialFormula({
    C0: summary.C0,
    profit: summary.profit,
    direct: summary.resourceSlices?.direct ?? summary.direct ?? null,
    overhead: summary.resourceSlices?.overhead ?? summary.overhead ?? null,
    formulaProfitRate: params.profitMarkupOnCostWithOh,
    vatPercent: calc.vatPercent ?? null,
    manual: calc.economicsManual,
  });
  calc.costSummary = {
    ...summary,
    C0: next.C0,
    C: next.C,
    reserve: next.reserve,
    profit: next.profit,
    priceExVat: next.priceExVat,
    vatAmount: next.vatAmount,
    priceIncVat: next.priceIncVat,
    ...(next.direct != null ? { direct: next.direct } : {}),
    ...(next.overhead != null ? { overhead: next.overhead } : {}),
    ...(summary.northernAdjustments ? {
      northernAdjustments: {
        ...summary.northernAdjustments,
        total: next.priceExVat,
      },
    } : {}),
    ...(summary.resourceSlices ? {
      resourceSlices: {
        ...summary.resourceSlices,
        ...(next.manualLines.includes("overhead") && next.overhead != null
          ? { overhead: next.overhead, costWithOh: next.C0 }
          : {}),
        ...(next.manualLines.includes("profit") || next.manualLines.includes("overhead")
          ? { profit: next.profit }
          : {}),
        total: next.priceExVat,
      },
    } : {}),
    manualLines: next.manualLines,
  };
}

function applyResourceDraftAdjustments(calc: Calculation) {
  const current = calc.costSummary;
  const slices = current?.resourceSlices;
  const params = calc.resourceScheduleParams;
  if (!current || !slices || !params) return;
  // Unlinked commercial and volume rows in the «other» bucket are folded into
  // slices.direct. Labor, materials and equipment do not cover that remainder.
  const otherDirect = Math.round((
    (slices.direct ?? 0) - (slices.labor ?? 0) - (slices.materials ?? 0) - (slices.equipment ?? 0)
  ) * 100) / 100;
  const engine = runCostEngine({
    directLabor: slices.labor,
    directMaterials: slices.materials,
    directEquipment: slices.equipment,
    directSubcontract: otherDirect > 0 ? otherDirect : 0,
    logisticsIncludingBus: 0,
    siteOverhead: slices.overhead,
    officeOverhead: Math.max(0, calc.officeOverhead ?? 0),
    reserve: Math.max(0, current.reserve ?? 0),
    profitMethod: "markup",
    profitRate: params.profitMarkupOnCostWithOh,
    // Preserve the Excel formula: contingency is separate from the markup base.
    includeReserveInPriceBase: false,
    vatPercent: calc.vatPercent ?? null,
    northern: northernInputsForEngine(calc),
  });
  const incomplete = [...new Set([...current.incomplete, ...engine.incomplete])];
  calc.costSummary = {
    ...current,
    C0: engine.C0,
    C: engine.C,
    reserve: engine.reserve,
    profit: engine.profit,
    priceExVat: engine.priceExVat,
    vatAmount: engine.vatAmount,
    priceIncVat: engine.priceIncVat,
    method: `${current.method}+office-reserve-separate`,
    incomplete,
    totalsIncomplete: incomplete.length > 0,
    at: new Date().toISOString(),
  };
}

function volumeNameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

export function recomputeCalculationCost(
  actorId: string,
  calcId: string,
  patch?: {
    northern?: NorthernInputs;
    busRoutes?: BusRouteInput[];
    siteOverhead?: number;
    officeOverhead?: number;
    reserve?: number;
    profitMethod?: "markup" | "margin";
    profitRate?: number;
    vatPercent?: number | null;
    includeReserveInPriceBase?: boolean;
    resourceScheduleParams?: ResourceScheduleParams;
    /** When true (default if resourceScheduleParams set): OH = D×overheadRate. */
    useResourceScheduleEconomics?: boolean;
    /** null on a line clears that manual correction. Omitted lines stay as saved. */
    economicsManual?: {
      overhead?: EconomicsManual["overhead"] | null;
      reserve?: EconomicsManual["reserve"] | null;
      profit?: EconomicsManual["profit"] | null;
    };
  }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((c) => c.id === calcId);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    if (patch?.northern) item.northern = patch.northern;
    if (patch?.busRoutes) item.busRoutes = patch.busRoutes;
    if (patch && Object.prototype.hasOwnProperty.call(patch, "vatPercent")) {
      item.vatPercent = patch.vatPercent ?? null;
    }
    if (patch?.resourceScheduleParams) {
      item.resourceScheduleParams = patch.resourceScheduleParams;
    }
    if (patch?.economicsManual) {
      item.economicsManual = mergeEconomicsManual(item.economicsManual, patch.economicsManual);
    }
    if (patch?.officeOverhead != null) {
      item.officeOverhead = Math.max(0, patch.officeOverhead);
    }

    const linkedSchedule = data.schedules.find(
      (s) => s.calculationId === item.id
    );
    const useRs =
      patch?.useResourceScheduleEconomics ?? Boolean(item.resourceScheduleParams);
    if (useRs && !item.resourceScheduleParams) {
      const logic = resolveTenderLogicSettings(
        data.organizations.find((org) => org.id === item.orgId),
      );
      item.resourceScheduleParams = resourceParamsForNewCalculation(logic.shiftProfile);
    }

    // Unified path only for explicit resource-linked drafts.
    if (
      useRs &&
      linkedSchedule?.stages?.length &&
      isResourceLinkedDraft(item) &&
      scheduleHasPopulatedResources(linkedSchedule.stages)
    ) {
      const reserve = Math.max(
        0,
        patch?.reserve ?? item.costSummary?.reserve ?? 0
      );
      for (const stage of linkedSchedule.stages) {
        for (const resource of stage.resources ?? []) {
          if ((resource.rate ?? 0) > 0) continue;
          const priced = item.positions.find((position) => position.code === "ВОР"
            && !position.isWorkItem
            && !position.rateMissing
            && position.rate > 0
            && volumeNameKey(position.name) === volumeNameKey(resource.name));
          if (priced) resource.rate = priced.rate;
        }
      }
      const synced = syncDraftFromStages(item, linkedSchedule.stages, {
        replacePositions: true,
      });
      Object.assign(item, synced.calc);
      if (item.costSummary) item.costSummary.reserve = reserve;
      applyResourceDraftAdjustments(item);
      const stageLabor = item.costSummary?.resourceSlices?.labor ?? 0;
      applyNorthernFold(item, stageLabor);
      applyClientEconomics(item);
      const matNeeds = buildMaterialNeeds({
        positions: item.positions.filter((position) => position.costRole !== "customer_source"),
        stages: stagesForOfficialCost(item, linkedSchedule.stages),
      });
      const extra = materialNeedsIncomplete(matNeeds).slice(0, 20);
      if (extra.length && item.costSummary) {
        item.costSummary.incomplete = [
          ...new Set([...(item.costSummary.incomplete ?? []), ...extra]),
        ];
        item.costSummary.totalsIncomplete = true;
      }
      markMissingCommercialCost(item);
      attachReferenceReprice(item, data, patch);
      assignCommitteeSnapshot(item, data);
      audit(
        data,
        actorId,
        "recompute",
        "calculation",
        calcId,
        "Cost-engine unified tree → V/W/X/Y/Z"
      );
      return data;
    }

    const buckets = bucketsFromPositions(item.positions, item.scenarioFactor || 1);
    const routes = item.busRoutes ?? [];
    let logistics = 0;
    const busFlags: string[] = [];
    for (const r of routes) {
      const b = busCost(r);
      logistics = Math.round((logistics + b.total) * 100) / 100;
      busFlags.push(...b.flags);
    }
    const northern: NorthernInputs = northernInputsForEngine(item);
    const northernFold = northern.applicable && item.resourceScheduleParams?.districtCoefficient != null;
    const rs = item.resourceScheduleParams;
    const Dapprox =
      buckets.labor + buckets.materials + buckets.equipment + buckets.other + logistics;
    const site = useRs
      ? patch?.siteOverhead ??
        Math.round(Dapprox * (rs?.overheadRate ?? 0.43) * 100) / 100
      : patch?.siteOverhead ??
        overheadsFromWorks(buckets.labor + buckets.equipment).nr;
    const office = patch?.officeOverhead ?? item.officeOverhead ?? 0;
    // Contingency reserve ≠ vacation reserve; Excel sheet has no project contingency.
    const reserve = patch?.reserve ?? item.costSummary?.reserve ?? 0;
    const profitRate = useRs
      ? patch?.profitRate ?? rs?.profitMarkupOnCostWithOh ?? 0.4
      : patch?.profitRate ?? 0.08;
    const engine = runCostEngine({
      directLabor: buckets.labor,
      directMaterials: buckets.materials,
      directEquipment: buckets.equipment,
      directSubcontract: buckets.other,
      logisticsIncludingBus: logistics,
      siteOverhead: site,
      officeOverhead: office,
      reserve,
      profitMethod: patch?.profitMethod ?? "markup",
      profitRate,
      // Excel marks up cost-with-OH; contingency (if any) stays separate unless confirmed.
      includeReserveInPriceBase:
        patch?.includeReserveInPriceBase ?? (useRs ? false : true),
      vatPercent: item.vatPercent ?? null,
      northern,
    });
    const officialPositions = item.positions.filter((position) => position.costRole !== "customer_source");
    const matNeeds = buildMaterialNeeds({
      positions: officialPositions,
      stages: linkedSchedule?.stages,
    });
    const incomplete = [
      ...engine.incomplete,
      ...officialPositions
        .filter((position) => position.rateMissing && !position.isWorkItem)
        .slice(0, 20)
        .map((position) => `missing_rate:${position.code || position.id}`),
      ...(buckets.materialsUnpriced ? ["materials_positions"] : []),
      ...materialNeedsIncomplete(matNeeds).slice(0, 20),
    ];
    item.costSummary = {
      C0: engine.C0,
      C: engine.C,
      reserve: engine.reserve,
      profit: engine.profit,
      priceExVat: engine.priceExVat,
      vatAmount: engine.vatAmount,
      priceIncVat: engine.priceIncVat,
      direct: engine.direct.D,
      overhead: site,
      method: useRs
        ? `cost-engine:${engine.profitMethod}+resource-schedule-excel`
        : `cost-engine:${engine.profitMethod}`,
      incomplete,
      totalsIncomplete: incomplete.length > 0,
      at: new Date().toISOString(),
    };
    applyNorthernFold(item, buckets.labor);
    if (useRs) applyClientEconomics(item);
    item.dataFlags = [
      ...(item.dataFlags ?? []).filter((f) => !f.startsWith("cost_")),
      "cost_engine_v1",
      ...(useRs ? ["resource_schedule_excel_economics"] : []),
      ...engine.flags.filter((flag) => !(northernFold && flag === "northern_not_applicable")),
      ...busFlags,
      ...(engine.incomplete.length ? ["requires_manual_check"] : []),
    ];
    markMissingCommercialCost(item);
    attachReferenceReprice(item, data, patch);
    assignCommitteeSnapshot(item, data);
    item.changeLog = [
      ...(item.changeLog ?? []),
      {
        id: `cl-${Date.now()}`,
        at: new Date().toISOString(),
        actorId,
        detail: `Пересчёт cost-engine C0=${engine.C0} C=${engine.C}`,
      },
    ];
    item.updatedAt = new Date().toISOString();
    audit(data, actorId, "recalc_cost", "calculation", calcId, "cost-engine");
    return data;
  });
}

/**
 * Won → production without duplicating the project card.
 * Freezes plan-fact baseline; keeps same procurement id.
 */
export function transferProcurementToProduction(
  actorId: string,
  procurementId: string
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const p = data.procurements.find((x) => x.id === procurementId);
    if (!p) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, p.orgId, "закупки");
    if (p.lifecycle === "production") {
      audit(
        data,
        actorId,
        "transfer",
        "procurement",
        procurementId,
        "Уже в производстве — без дубля"
      );
      return data;
    }
    const now = new Date().toISOString();
    p.lifecycle = "won";
    p.wonAt = now;
    p.reviewStatus = "odobrena";

    // ensure plan/fact on same procurement
    if (!p.planFactId) {
      const obj =
        data.objects.find((o) => o.id === p.objectId) ??
        data.objects.find((o) => o.orgId === p.orgId);
      const id = `pf-${Date.now()}`;
      data.planFacts.unshift({
        id,
        orgId: p.orgId,
        objectId: obj?.id ?? "obj-1",
        procurementId: p.id,
        title: `План/факт — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        entries: productionEntriesForProcurement(data, p.id),
        dailyFacts: [],
        updatedAt: now,
      });
      p.planFactId = id;
    }
    const pf = data.planFacts.find((x) => x.id === p.planFactId)!;
    // Migrate legacy synthetic 100% placeholder to measured estimate rows, or
    // an empty plan when the customer has not provided physical quantities.
    if (
      !pf.baselineEntries &&
      (pf.dailyFacts ?? []).length === 0 &&
      pf.entries.length === 1 &&
      pf.entries[0].workName === "Общий объём" &&
      pf.entries[0].unit === "%"
    ) {
      pf.entries = productionEntriesForProcurement(data, p.id);
    }
    if (!pf.baselineEntries && (pf.dailyFacts ?? []).length === 0 && pf.entries.length === 0) {
      pf.entries = productionEntriesForProcurement(data, p.id);
    }
    if (!pf.baselineEntries) {
      pf.baselineEntries = structuredClone(pf.entries) as PlanFactEntry[];
      pf.baselineAt = now;
    }
    pf.dailyFacts = pf.dailyFacts ?? [];
    pf.pnl = pf.pnl ?? {
      earnedValue: 0,
      incurredCosts: 0,
      cashIn: 0,
      cashOut: 0,
      recognizedRevenue: null,
      notes: [
        "Физический факт ≠ платёж",
        "earnedValue / incurredCosts отделены от cashIn / cashOut",
      ],
    };
    p.lifecycle = "production";
    if (!p.objectId) {
      const obj = data.objects.find((o) => o.orgId === p.orgId);
      p.objectId = obj?.id;
    }
    audit(
      data,
      actorId,
      "transfer",
      "procurement",
      procurementId,
      "Выигран → производство без дубля проекта; baseline зафиксирован"
    );
    return data;
  });
}

export function addDailyProductionFact(
  actorId: string,
  planFactId: string,
  fact: Omit<DailyFact, "id" | "authorId" | "at" | "photos"> & {
    photos?: DailyFact["photos"];
    factId?: string;
  }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const pf = data.planFacts.find((p) => p.id === planFactId);
    if (!pf) throw new Error("План/факт не найден");
    assertOrgAccess(actor, pf.orgId, "план/факт");
    const workName = fact.workName.trim();
    // Match by workName only — unit from the plan row wins (UI may send «ед»).
    const row = pf.entries.find((e) => e.workName === workName);
    const unit = row?.unit ?? fact.unit;
    const currentFacts = pf.dailyFacts ?? [];
    const existing = fact.factId
      ? currentFacts.find((item) => item.id === fact.factId)
      : undefined;
    const incomingPhotos = fact.photos ?? [];
    const photos = [...(existing?.photos ?? [])];
    const usedPaths = uploadPathsInUse(data);
    for (const photo of incomingPhotos) {
      if (photos.some((item) => item.id === photo.id)) continue;
      const canonical = photo.storedPath ? canonicalUploadPath(photo.storedPath) : null;
      if (!canonical || usedPaths.has(canonical)) {
        const { storedPath: _planted, ...rest } = photo;
        void _planted;
        photos.push(rest);
        continue;
      }
      photos.push({ ...photo, storedPath: canonical });
      usedPaths.add(canonical);
    }
    const entry: DailyFact = {
      id: existing?.id ?? fact.factId ?? `df-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: fact.date,
      workName,
      unit,
      quantity: fact.quantity,
      people: fact.people ?? existing?.people,
      equipment: fact.equipment ?? existing?.equipment,
      materialsNote: fact.materialsNote ?? existing?.materialsNote,
      resourceLines: fact.resourceLines ?? existing?.resourceLines,
      comment: fact.comment ?? existing?.comment,
      photos,
      authorId: actorId,
      at: new Date().toISOString(),
      entryId: row?.id ?? existing?.entryId,
    };
    // New submissions are ledger entries, so several updates of one work/day
    // add up. An explicit factId edits that entry without double-counting it.
    pf.dailyFacts = [
      ...currentFacts.filter(
        (item) => item.id !== entry.id
      ),
      entry,
    ];
    // Daily records are source of truth for works that have them
    recomputeEntriesFromDaily(pf);
    // Physical index ≠ money; economics only from confirmed rates
    const proc = data.procurements.find((x) => x.id === pf.procurementId);
    const calc = data.calculations.find(
      (c) => c.id === proc?.calculationId && c.kind !== "customer_original"
    ) ?? data.calculations.find(
      (c) => c.procurementId === pf.procurementId && c.kind === "resource_draft"
    );
    const customerEstimate = data.calculations.find(
      (c) => c.id === proc?.originalCalculationId && c.kind === "customer_original"
    ) ?? data.calculations.find(
      (c) => c.procurementId === pf.procurementId && c.kind === "customer_original"
    );
    const eco = economicsFromVolumes({
      entries: pf.entries,
      daily: pf.dailyFacts,
      positions: calc?.positions ?? [],
      customerEstimatePositions: customerEstimate?.positions ?? null,
      directories: data.directories ?? [],
    });
    const prev = pf.pnl ?? {
      earnedValue: 0,
      incurredCosts: 0,
      cashIn: 0,
      cashOut: 0,
      recognizedRevenue: null,
      notes: [],
    };
    const incurred =
      prev.incurredManual === true
        ? prev.incurredCosts
        : eco.incomplete.length
          ? prev.incurredCosts
          : eco.autoIncurred;
    pf.pnl = {
      ...prev,
      earnedValue: eco.physicalIndex,
      economicsAuto: eco.incomplete.length ? null : eco.autoIncurred,
      valueOfFactByCustomerEstimate: eco.customerEstimateValue,
      remainingValueByCustomerEstimate: eco.customerEstimateRemainingValue,
      customerEstimateIncomplete: eco.customerEstimateIncomplete,
      incurredCosts: incurred,
      incomplete: eco.incomplete,
      notes: [
        "earnedValue = физ. индекс объёма (не ₽)",
        "economicsAuto = объём×подтверждённые расценки (иначе null)",
        "valueOfFactByCustomerEstimate = физический объём×ставки исходной сметы (не акт/не оплата)",
        "касса / признанная выручка — отдельные ручные поля",
        ...(prev.notes ?? []).filter(
          (n) =>
            !n.startsWith("earnedValue") &&
            !n.startsWith("Нормативная") &&
            !n.startsWith("economicsAuto") &&
            !n.startsWith("valueOfFactByCustomerEstimate")
        ),
      ],
    };
    pf.updatedAt = new Date().toISOString();
    audit(
      data,
      actorId,
      "daily_fact",
      "planfact",
      planFactId,
      `${fact.date} ${workName} = ${fact.quantity} ${unit}`
    );
    return data;
  });
}


const SUPPLY_STATUS_RU: Record<SupplyStatus, string> = {
  need: "Потребность",
  quoted_draft: "Черновик КП",
  ordered: "Заказано",
  in_transit: "В пути",
  delivered: "Поставлено",
  accepted: "Принято",
  cancelled: "Отменено",
};

export function supplyStatusLabel(s: SupplyStatus): string {
  return SUPPLY_STATUS_RU[s] ?? s;
}

export function upsertSupplier(
  actorId: string,
  input: Omit<SupplierDirectoryEntry, "id" | "orgId" | "createdAt" | "updatedAt"> & { id?: string }
) {
  let saved!: SupplierDirectoryEntry;
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    data.suppliers = data.suppliers ?? [];
    const now = new Date().toISOString();
    const existing = input.id ? data.suppliers.find((item) => item.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("Поставщик не найден");
    if (existing) {
      assertOrgAccess(actor, existing.orgId, "поставщика");
      Object.assign(existing, {
        name: input.name.trim(), email: input.email.trim().toLowerCase(),
        materialKeywords: [...new Set(input.materialKeywords.map((value) => value.trim()).filter(Boolean))],
        regions: [...new Set(input.regions.map((value) => value.trim()).filter(Boolean))],
        website: input.website?.trim() || undefined, note: input.note?.trim() || undefined, updatedAt: now,
      });
      for (const supply of data.supplyRequests ?? []) {
        if (supply.orgId !== existing.orgId) continue;
        const project = data.procurements.find((item) => item.id === supply.procurementId);
        if (supplierIdsForMaterial(data, existing.orgId, supply.materialName, project?.region).includes(existing.id)) {
          supply.supplierIds = [...new Set([...(supply.supplierIds ?? []), existing.id])];
        }
      }
      audit(data, actorId, "update", "supplier", existing.id, existing.name);
      saved = structuredClone(existing);
      return data;
    }
    const supplier: SupplierDirectoryEntry = {
      id: `supplier-${Date.now()}-${randomBytes(3).toString("hex")}`,
      orgId: actor.orgId, name: input.name.trim(), email: input.email.trim().toLowerCase(),
      materialKeywords: [...new Set(input.materialKeywords.map((value) => value.trim()).filter(Boolean))],
      regions: [...new Set(input.regions.map((value) => value.trim()).filter(Boolean))],
      website: input.website?.trim() || undefined, note: input.note?.trim() || undefined,
      createdBy: actor.id,
      createdAt: now, updatedAt: now,
    };
    data.suppliers.unshift(supplier);
    for (const supply of data.supplyRequests ?? []) {
      if (supply.orgId !== supplier.orgId) continue;
      const project = data.procurements.find((item) => item.id === supply.procurementId);
      if (supplierIdsForMaterial(data, supplier.orgId, supply.materialName, project?.region).includes(supplier.id)) {
        supply.supplierIds = [...new Set([...(supply.supplierIds ?? []), supplier.id])];
      }
    }
    audit(data, actorId, "create", "supplier", supplier.id, supplier.name);
    saved = structuredClone(supplier);
    return data;
  });
  return saved;
}

export function deleteSupplier(actorId: string, supplierId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const supplier = data.suppliers?.find((item) => item.id === supplierId);
    if (!supplier) throw new Error("Поставщик не найден");
    assertOrgAccess(actor, supplier.orgId, "поставщика");
    assertDeleteAllowed(actor, supplier.createdBy, "zakupki", "поставщика");
    data.suppliers = (data.suppliers ?? []).filter((item) => item.id !== supplierId);
    data.supplyRequests = (data.supplyRequests ?? []).map((item) => ({
      ...item,
      supplierIds: (item.supplierIds ?? []).filter((id) => id !== supplierId),
      sentToSupplierIds: (item.sentToSupplierIds ?? []).filter((id) => id !== supplierId),
    }));
    audit(data, actorId, "delete", "supplier", supplierId, supplier.name);
    return data;
  });
}

export function saveOrganizationCompanyCard(actorId: string, card: Omit<OrganizationCompanyCard, "orgId" | "uploadedAt" | "uploadedBy">) {
  let saved!: OrganizationCompanyCard;
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    data.companyCards = data.companyCards ?? [];
    const row: OrganizationCompanyCard = {
      ...card, orgId: actor.orgId, uploadedAt: new Date().toISOString(), uploadedBy: actorId,
    };
    data.companyCards = data.companyCards.filter((item) => item.orgId !== actor.orgId);
    data.companyCards.unshift(row);
    audit(data, actorId, "upload", "company_card", actor.orgId, card.fileName);
    saved = structuredClone(row);
    return data;
  });
  return saved;
}

export function upsertSupplyRequest(
  actorId: string,
  input: {
    id?: string;
    procurementId: string;
    materialName: string;
    unit: string;
    qtyNeed: number;
    needBy: string;
    workName?: string;
    source?: SupplyRequest["source"];
    sourceFiles?: string[];
    quantityNeedsReview?: boolean;
    status?: SupplyStatus;
    quoteDraftText?: string;
    supplierName?: string;
    supplierEmail?: string;
    supplierIds?: string[];
    supplierNote?: string;
    qtyOrdered?: number;
    qtyDelivered?: number;
    unitPrice?: number | null;
  }
): AppData & { supplyCreated: boolean; supplyId: string } {
  let supplyCreated = false;
  let supplyId = "";
  const data = mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const p = data.procurements.find((x) => x.id === input.procurementId);
    if (!p) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, p.orgId, "поставок");
    data.supplyRequests = data.supplyRequests ?? [];
    const now = new Date().toISOString();
    if (input.id) {
      const row = data.supplyRequests.find((s) => s.id === input.id);
      if (!row) throw new Error("Потребность не найдена");
      Object.assign(row, {
        materialName: input.materialName,
        unit: input.unit,
        qtyNeed: input.qtyNeed,
        needBy: input.needBy,
        workName: input.workName,
        source: input.source ?? row.source,
        sourceFiles: input.sourceFiles ?? row.sourceFiles,
        quantityNeedsReview: input.quantityNeedsReview ?? row.quantityNeedsReview,
        status: input.status ?? row.status,
        quoteDraftText: input.quoteDraftText ?? row.quoteDraftText,
        supplierName: input.supplierName ?? row.supplierName,
        supplierEmail: input.supplierEmail ?? row.supplierEmail,
        supplierIds: input.supplierIds ?? supplierIdsForMaterial(data, p.orgId, input.materialName, p.region),
        supplierNote: input.supplierNote ?? row.supplierNote,
        qtyOrdered: input.qtyOrdered ?? row.qtyOrdered,
        qtyDelivered: input.qtyDelivered ?? row.qtyDelivered,
        unitPrice:
          input.unitPrice === undefined ? row.unitPrice : input.unitPrice,
        updatedAt: now,
      });
      audit(data, actorId, "update", "supply", row.id, row.materialName);
      supplyCreated = false;
      supplyId = row.id;
      return data;
    }
    const wanted = supplyNeedKey({
      materialName: input.materialName,
      unit: input.unit,
      workName: input.workName,
      source: input.source ?? "manual",
    });
    const duplicate = data.supplyRequests.find((item) =>
      item.procurementId === p.id
      && item.status !== "cancelled"
      && supplyNeedKey(item) === wanted
    );
    if (duplicate) {
      supplyCreated = false;
      supplyId = duplicate.id;
      return data;
    }
    const id = `sup-${Date.now()}`;
    const row: SupplyRequest = {
      id,
      orgId: p.orgId,
      procurementId: p.id,
      materialName: input.materialName,
      unit: input.unit,
      qtyNeed: input.qtyNeed,
      qtyOrdered: input.qtyOrdered ?? 0,
      qtyDelivered: input.qtyDelivered ?? 0,
      needBy: input.needBy,
      status: input.status ?? "need",
      quoteDraftText: input.quoteDraftText,
      supplierName: input.supplierName,
      supplierEmail: input.supplierEmail,
      supplierIds: input.supplierIds ?? supplierIdsForMaterial(data, p.orgId, input.materialName, p.region),
      supplierNote: input.supplierNote,
      unitPrice: input.unitPrice ?? null,
      workName: input.workName,
      source: input.source ?? "manual",
      sourceFiles: input.sourceFiles,
      quantityNeedsReview: input.quantityNeedsReview,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };
    data.supplyRequests.unshift(row);
    p.supplyRequestIds = [...(p.supplyRequestIds ?? []), id];
    audit(data, actorId, "create", "supply", id, row.materialName);
    supplyCreated = true;
    supplyId = id;
    return data;
  });
  return Object.assign(data, { supplyCreated, supplyId });
}

export function deleteSupplyRequest(actorId: string, supplyId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const row = (data.supplyRequests ?? []).find((item) => item.id === supplyId);
    if (!row) throw new Error("Потребность не найдена");
    assertOrgAccess(actor, row.orgId, "поставок");
    assertDeleteAllowed(actor, row.createdBy, "zakupki", "потребность");
    data.supplyRequests = (data.supplyRequests ?? []).filter((item) => item.id !== supplyId);
    const procurement = data.procurements.find((item) => item.id === row.procurementId);
    if (procurement) {
      procurement.supplyRequestIds = (procurement.supplyRequestIds ?? []).filter((id) => id !== supplyId);
    }
    audit(data, actorId, "delete", "supply", supplyId, row.materialName);
    return data;
  });
}

function normalizeSupplierTerm(value: string) {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function bareMaterialName(name: string) {
  return name.replace(/^возврат:\s*/iu, "").trim();
}

/** Same material and unit is one supply line, including a return written as «Возврат:». */
function manifestMaterialKey(name: string, unit: string) {
  return `${normalizeSupplierTerm(bareMaterialName(name))}|${normalizeSupplierTerm(unit)}`;
}

/** Skip only the estimate row that repeats the same work. Another work of this material still counts. */
function manifestSourceKey(name: string, unit: string, workName?: string) {
  return `${manifestMaterialKey(name, unit)}|${normalizeSupplierTerm(workName ?? "")}`;
}

function signedManifestQuantity(name: string, quantity: number) {
  const value = Math.abs(quantity);
  return /^возврат:/iu.test(name) ? -value : value;
}

function supplierIdsForMaterial(data: AppData, orgId: string, materialName: string, region = "") {
  const name = normalizeSupplierTerm(materialName);
  const projectRegion = normalizeSupplierTerm(region);
  return (data.suppliers ?? []).filter((supplier) => supplier.orgId === orgId &&
    (!supplier.regions.length || !projectRegion || supplier.regions.some((value) => projectRegion.includes(normalizeSupplierTerm(value)) || normalizeSupplierTerm(value).includes(projectRegion))) &&
    supplier.materialKeywords.some((keyword) => {
      const term = normalizeSupplierTerm(keyword);
      return term.length >= 3 && (name.includes(term) || term.includes(name));
    })).map((supplier) => supplier.id);
}

/** Build an idempotent buy list from confirmed material rows in GPR and parsed estimates/VOR. */
export function generateProcurementMaterialManifest(actorId: string, procurementId: string) {
  let created = 0;
  let withSupplier = 0;
  let withoutSupplier = 0;
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const procurement = data.procurements.find((item) => item.id === procurementId);
    if (!procurement) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, procurement.orgId, "поставок");
    data.supplyRequests = data.supplyRequests ?? [];
    const schedule = data.schedules.find((item) => item.id === procurement.gprId && item.orgId === procurement.orgId);
    const docs = data.documents.filter((item) => item.procurementId === procurementId && item.orgId === procurement.orgId);
    const rows: Array<{ name: string; unit: string; quantity: number; workName?: string; needBy?: string; source: "gpr" | "estimate"; sourceFiles?: string[] }> = [];
    const gprKeys = new Set<string>();
    for (const stage of schedule?.stages ?? []) {
      for (const resource of stage.resources ?? []) {
        if (resource.kind !== "material" || !Number.isFinite(resource.quantity) || resource.quantity <= 0) continue;
        gprKeys.add(manifestSourceKey(resource.name, resource.unit, stage.name));
        rows.push({ name: resource.name.trim(), unit: resource.unit || "шт", quantity: resource.quantity, workName: stage.name, needBy: stage.end, source: "gpr" });
      }
    }
    for (const doc of docs) {
      for (const position of doc.estimatePositions ?? []) {
        if (position.isWorkItem || position.resourceKind !== "material" || !Number.isFinite(position.quantity) || position.quantity <= 0) continue;
        const stage = (schedule?.stages ?? []).find((item) =>
          (position.workName && normalizeSupplierTerm(item.name) === normalizeSupplierTerm(position.workName)) ||
          (position.sectionName && item.sectionName && normalizeSupplierTerm(item.sectionName) === normalizeSupplierTerm(position.sectionName))
        );
        const workName = stage?.name ?? position.workName ?? position.sectionName;
        if (gprKeys.has(manifestSourceKey(position.name, position.unit, workName))) continue;
        rows.push({ name: position.name.trim(), unit: position.unit || "шт", quantity: position.quantity, workName, needBy: stage?.end, source: "estimate", sourceFiles: [doc.fileName] });
      }
    }
    const merged = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const key = manifestMaterialKey(row.name, row.unit);
      const signed = signedManifestQuantity(row.name, row.quantity);
      const previous = merged.get(key);
      if (previous) {
        previous.quantity += signed;
        previous.sourceFiles = [...new Set([...(previous.sourceFiles ?? []), ...(row.sourceFiles ?? [])])];
        if (row.source === "gpr") previous.source = "gpr";
      } else merged.set(key, { ...row, name: bareMaterialName(row.name), quantity: signed });
    }
    for (const row of merged.values()) {
      if (Math.abs(row.quantity) < 1e-9) continue;
      const materialName = row.quantity < 0 ? `Возврат: ${row.name}` : row.name;
      const qtyNeed = Math.abs(row.quantity);
      const existing = data.supplyRequests.find((item) => item.procurementId === procurementId &&
        manifestMaterialKey(item.materialName, item.unit) === manifestMaterialKey(materialName, row.unit) &&
        item.status !== "cancelled");
      if (existing) continue;
      const now = new Date().toISOString();
      const id = `sup-${Date.now()}-${randomBytes(3).toString("hex")}`;
      const supplierIds = supplierIdsForMaterial(data, procurement.orgId, row.name, procurement.region);
      if (supplierIds.length) withSupplier += 1;
      else withoutSupplier += 1;
      data.supplyRequests.unshift({
        id, orgId: procurement.orgId, procurementId, workName: row.workName,
        materialName, unit: row.unit, qtyNeed,
        qtyOrdered: 0, qtyDelivered: 0, needBy: row.needBy ?? procurement.deadline ?? now.slice(0, 10),
        status: "need", source: row.source, sourceFiles: row.sourceFiles,
        quantityNeedsReview: !row.needBy,
        supplierIds,
        createdBy: actor.id,
        createdAt: now, updatedAt: now,
      });
      procurement.supplyRequestIds = [...(procurement.supplyRequestIds ?? []), id];
      audit(data, actorId, "create", "supply", id, `Ведомость материалов · ${materialName}`);
      created += 1;
    }
    return data;
  });
  return { created, withSupplier, withoutSupplier };
}

export function markSupplyRequestSent(actorId: string, supplyId: string, supplierId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const supply = data.supplyRequests?.find((item) => item.id === supplyId);
    const supplier = data.suppliers?.find((item) => item.id === supplierId);
    if (!supply || !supplier) throw new Error("Потребность или поставщик не найдены");
    assertOrgAccess(actor, supply.orgId, "поставок");
    assertOrgAccess(actor, supplier.orgId, "поставщика");
    if (supply.orgId !== supplier.orgId || !(supply.supplierIds ?? []).includes(supplier.id)) {
      throw new Error("Поставщик не сопоставлен с этой позицией материала");
    }
    supply.sentToSupplierIds = [...new Set([...(supply.sentToSupplierIds ?? []), supplier.id])];
    supply.updatedAt = new Date().toISOString();
    audit(data, actorId, "send", "supplier_rfq", supply.id, `${supplier.name} · ${supply.materialName}`);
    return data;
  });
}

export function recordSupplierQuote(
  actorId: string,
  supplyId: string,
  quote: Omit<SupplierQuote, "id" | "receivedAt"> & { id?: string }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const supply = data.supplyRequests?.find((item) => item.id === supplyId);
    if (!supply) throw new Error("Потребность не найдена");
    assertOrgAccess(actor, supply.orgId, "поставок");
    if (!quote.supplierName.trim()) throw new Error("Укажите поставщика в КП");
    if (!Number.isFinite(quote.unitPrice) || quote.unitPrice < 0) {
      throw new Error("Цена КП должна быть неотрицательным числом");
    }
    if (quote.deliveryDays != null && (!Number.isFinite(quote.deliveryDays) || quote.deliveryDays < 0)) {
      throw new Error("Срок поставки должен быть неотрицательным числом");
    }
    const now = new Date().toISOString();
    const row: SupplierQuote = {
      id: quote.id ?? `quote-${Date.now()}-${randomBytes(3).toString("hex")}`,
      supplierName: quote.supplierName.trim(),
      supplierEmail: quote.supplierEmail?.trim() || undefined,
      unitPrice: quote.unitPrice,
      deliveryDays: quote.deliveryDays ?? null,
      note: quote.note?.trim() || undefined,
      receivedAt: now,
    };
    supply.quotes = supply.quotes ?? [];
    const existing = supply.quotes.findIndex((item) => item.id === row.id);
    if (existing >= 0) supply.quotes[existing] = { ...supply.quotes[existing], ...row };
    else supply.quotes.unshift(row);
    supply.updatedAt = now;
    audit(data, actorId, existing >= 0 ? "update" : "create", "supplier_quote", row.id, `${supply.materialName} · ${row.supplierName}`);
    return data;
  });
}

export function selectSupplierQuote(actorId: string, supplyId: string, quoteId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const supply = data.supplyRequests?.find((item) => item.id === supplyId);
    if (!supply) throw new Error("Потребность не найдена");
    assertOrgAccess(actor, supply.orgId, "поставок");
    const quote = supply.quotes?.find((item) => item.id === quoteId);
    if (!quote) throw new Error("КП не найдено в этой потребности");
    supply.selectedQuoteId = quote.id;
    supply.supplierName = quote.supplierName;
    supply.supplierEmail = quote.supplierEmail;
    supply.unitPrice = quote.unitPrice;
    supply.updatedAt = new Date().toISOString();
    audit(data, actorId, "select", "supplier_quote", quote.id, `${supply.materialName} · ${quote.supplierName} · ${quote.unitPrice}`);
    return data;
  });
}

/** Production updates receipt facts for materials linked to its own project. */
export function updateProductionSupplyReceipt(
  actorId: string,
  input: {
    planFactId: string;
    supplyId: string;
    qtyDelivered: number;
    status?: SupplyStatus;
  }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const plan = data.planFacts.find((item) => item.id === input.planFactId);
    if (!plan) throw new Error("План/факт не найден");
    assertOrgAccess(actor, plan.orgId, "производства");
    if (!Number.isFinite(input.qtyDelivered) || input.qtyDelivered < 0) {
      throw new Error("Количество поставки должно быть неотрицательным числом");
    }
    data.supplyRequests = data.supplyRequests ?? [];
    const supply = data.supplyRequests.find(
      (item) => item.id === input.supplyId && item.procurementId === plan.procurementId
    );
    if (!supply) throw new Error("Потребность материала не найдена в этом проекте");
    supply.qtyDelivered = input.qtyDelivered;
    if (input.status) supply.status = input.status;
    supply.updatedAt = new Date().toISOString();
    audit(data, actorId, "update", "supply", supply.id, `Факт поставки: ${supply.qtyDelivered} ${supply.unit}; ${supply.status}`);
    return data;
  });
}

export function addMoneyPayment(
  actorId: string,
  moneyId: string,
  payment: Omit<MoneyPayment, "id">
): { paymentId: string; created: boolean } {
  let result = { paymentId: "", created: false };
  mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const plan = data.moneyPlans.find((m) => m.id === moneyId);
    if (!plan) throw new Error("Денежный план не найден");
    assertOrgAccess(actor, plan.orgId, "денежного плана");
    const amountError = paymentAmountError(payment.amount);
    if (amountError) throw new Error(amountError);
    const storedType = paymentTypeForSave(payment);
    const title = payment.title?.trim() || "Платёж";
    const existingId = recentPaymentId(plan.payments, { ...payment, type: storedType, title });
    if (existingId) {
      result = { paymentId: existingId, created: false };
      return data;
    }
    const row: MoneyPayment = {
      ...payment,
      title,
      type: storedType,
      id: `pay-${Date.now()}`,
    };
    plan.payments = [...plan.payments, row];
    plan.updatedAt = new Date().toISOString();
    audit(data, actorId, "create", "money_payment", row.id, row.title);
    result = { paymentId: row.id, created: true };
    return data;
  });
  return result;
}

export function deleteMoneyPayment(actorId: string, moneyId: string, paymentId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const plan = data.moneyPlans.find((item) => item.id === moneyId);
    if (!plan) throw new Error("Денежный план не найден");
    assertOrgAccess(actor, plan.orgId, "денежного плана");
    const payment = plan.payments.find((item) => item.id === paymentId);
    if (!payment) throw new Error("Платёж не найден");
    plan.payments = plan.payments.filter((item) => item.id !== paymentId);
    plan.updatedAt = new Date().toISOString();
    audit(data, actorId, "delete", "money_payment", paymentId, payment.title);
    return data;
  });
}

export function ensureMoneyPlan(actorId: string, procurementId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const p = data.procurements.find((x) => x.id === procurementId);
    if (!p) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, p.orgId, "денежного плана");
    if (p.moneyId) {
      const existing = data.moneyPlans.find((m) => m.id === p.moneyId);
      if (existing) return data;
    }
    const id = `m-${Date.now()}`;
    const now = new Date().toISOString();
    data.moneyPlans.unshift({
      id,
      orgId: p.orgId,
      procurementId: p.id,
      title: `Деньги — ${p.title.slice(0, 48)}`,
      status: "v_rabote",
      payments: [],
      updatedAt: now,
    });
    p.moneyId = id;
    audit(data, actorId, "create", "money", id, "План создан в карточке проекта");
    return data;
  });
}
