import { DEFAULT_SECTIONS, REVIEW_LABELS } from "@/lib/roles";
import type {
  AppData,
  Calculation,
  CardStatus,
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
  Role,
  SectionKey,
  SupplyRequest,
  SupplierQuote,
  SupplyStatus,
  User,
} from "@/lib/types";
import { rateFromRow, resolveDirectoryRate } from "@/lib/client-dirs";
import { buildProjectAnalytics } from "@/lib/project-analytics";
import {
  analyzeProjectPackageWithModel,
  buildProjectAnalysisFallback,
  type AnalysisCompanyContext,
} from "@/server/project-analysis-ai";
import {
  bucketsFromPositions,
  busCost,
  classifyDirectCostBucket,
  runCostEngine,
  shiftStages,
  workingDaysBetween,
  type BusRouteInput,
  type NorthernInputs,
} from "@/lib/cost-engine";
import { assertOrgAccess } from "@/server/acl";
import {
  overheadsFromWorks,
  scenarioFactor,
  worksSubtotal,
} from "@/lib/calc-math";
import { stampCitationSourceVersion } from "@/server/grand-smeta";
import { parseContractRisks } from "@/server/contract-risk";
import type { UploadAnalysis } from "@/server/grand-smeta";
import { mutateAppData, readAppData, resetAppData } from "@/server/db";
import { hashPassword } from "@/server/passwords";
import { createSession, publicUser } from "@/server/auth";
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
  syncDraftFromStages,
} from "@/lib/unified-resource-sync";

export { assertOrgAccess };

function comparableUnit(value: string) {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[\s.·]/g, "")
    .replace(/м2/g, "м²")
    .replace(/м3/g, "м³");
}

function matchingDirectoryRate(data: AppData, code: string, unit: string) {
  const hit = resolveDirectoryRate(data.directories, code);
  if (!hit) return null;
  if (
    hit.unit &&
    !hit.unit.toLocaleLowerCase("ru-RU").startsWith("руб") &&
    comparableUnit(hit.unit) !== comparableUnit(unit)
  ) {
    return null;
  }
  return hit;
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
      documents: data.documents.filter((d) => d.orgId === orgId),
      calculations: data.calculations.filter((c) => c.orgId === orgId),
      schedules: data.schedules.filter((s) => s.orgId === orgId),
      moneyPlans: data.moneyPlans.filter((m) => m.orgId === orgId),
      risks: data.risks.filter((r) => r.orgId === orgId),
      planFacts: data.planFacts.filter((p) => p.orgId === orgId),
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
      ...safe
    } = patch;
    void _o;
    void _i;
    void _im;
    void _k;
    const entry = {
      id: `cl-${Date.now()}`,
      at: new Date().toISOString(),
      actorId,
      detail: "Ручное обновление черновика",
    };
    data.calculations = data.calculations.map((c) =>
      c.id === id
        ? {
            ...c,
            ...safe,
            changeLog: [...(c.changeLog ?? []), entry],
            updatedAt: new Date().toISOString(),
          }
        : c
    );
    audit(data, actorId, "update", "calculation", id, "Обновление расчёта");
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
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((c) => c.id === id);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
    assertEditableCalculation(item);
    const positions = item.positions.map((p) => {
      if (p.code === "НР" || p.code === "СП") return p;
      const hit = matchingDirectoryRate(data, p.code, p.unit);
      if (!hit) return p;
      return {
        ...p,
        rate: hit.rate,
        rateMissing: false,
        rateSourceDirectoryId: hit.dirId,
        name: hit.name ?? p.name,
        unit: hit.unit && !hit.unit.startsWith("руб") ? hit.unit : p.unit,
      };
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
    const rate = rateFromRow(row, input.rateKey);
    if (rate == null) throw new Error("В строке нет ставки");
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
    const { orgId: _o, id: _i, ...safe } = patch;
    void _o;
    void _i;
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
        analyticalNote: prepared.analyticalNote,
        citations: stampCitationSourceVersion(prepared.citations, versionLabel),
        highlights: prepared.highlights,
        analysis: prepared.analysis,
        estimatePositions,
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
          note: input.prepared?.noteByModel
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
        changeLog: [
          {
            id: `cl-${Date.now()}`,
            at: now,
            actorId,
            detail: "Создан ресурсный черновик",
          },
        ],
        dataFlags: ["auto_chain", "requires_manual_check"],
      });
      p.calculationId = id;
      created.push("расчёт");
    }

    if (!p.gprId) {
      const id = `g-${Date.now()}`;
      const start = now.slice(0, 10);
      const stage1 = `gs-${Date.now()}`;
      const stage2 = `gs-${Date.now() + 1}`;
      data.schedules.unshift({
        id,
        orgId: p.orgId,
        procurementId: p.id,
        calculationId: p.calculationId ?? "",
        title: `ГПР — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        version: 1,
        authorId: actorId,
        assumptions: [
          "Начальные даты и этапы — только навигационная заготовка; замените их по ТЗ, производительности и календарю объекта",
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
      const dailyHasFact = (plan.dailyFacts ?? []).some((daily) => daily.workName.trim() === entry.workName.trim());
      const fact = dailyHasFact
        ? Math.round(sumDailyQty(plan.dailyFacts, { workName: entry.workName }) * 1000) / 1000
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
    const item = data.schedules.find((s) => s.id === id);
    if (!item) throw new Error("ГПР не найден");
    assertOrgAccess(actor, item.orgId, "ГПР");
    const { orgId: _o, id: _i, ...safe } = patch;
    void _o;
    void _i;
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
      const stages = safe.stages
        ? linkEstimateWorksToStages(safe.stages, calc?.positions ?? [])
        : s.stages;
      return { ...s, ...safe, stages, updatedAt: new Date().toISOString() };
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
      }
      if (previousPhysicalPlan !== physicalPlanSignature(updated.stages)) {
        syncProductionPlanFromSchedule(data, updated);
      }
    }
    audit(data, actorId, "update", "gpr", id, "Обновление ГПР");
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
    const { orgId: _o, id: _i, ...safe } = patch;
    void _o;
    void _i;
    data.planFacts = data.planFacts.map((p) =>
      p.id === id
        ? { ...p, ...safe, updatedAt: new Date().toISOString() }
        : p
    );
    audit(data, actorId, "update", "planfact", id, "Обновление план/факт");
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
        ? `Разбор договора (эвристика-помощник, ${remarks.length} замечаний; не юрэкспертиза)`
        : remarks.length === 0
          ? "Разбор договора: нет данных (пусто/короткий текст, без выдуманных рисков)"
          : `Разбор договора (эвристика-помощник, ${remarks.length} замечаний)`
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

export function refreshProcurementAnalytics(
  actorId: string,
  procurementId: string
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const p = data.procurements.find((x) => x.id === procurementId);
    if (!p) throw new Error("Закупка не найдена");
    assertOrgAccess(actor, p.orgId, "закупки");
    const docs = data.documents.filter((d) => d.procurementId === p.id);
    p.analytics = buildProjectAnalytics(p, docs);
    audit(
      data,
      actorId,
      "analyze",
      "procurement",
      procurementId,
      `Сводка: ${p.analytics.recommendation}`
    );
    return data;
  });
}

export async function analyzeProcurementPackageWithAI(
  actorId: string,
  procurementId: string
): Promise<{ warning?: string; usedAi: boolean }> {
  // Every entry point (including automatic upload analysis) needs the same
  // current resource draft. Previously only the explicit UI action prepared it.
  sendProcurementToCalculation(actorId, procurementId);
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
  const missingRates = draft?.positions.filter((position) => position.rateMissing && !position.isWorkItem).length ?? 0;
  const directCost = draft?.costSummary?.resourceSlices?.costWithOh ?? draft?.costSummary?.C0 ?? null;
  const priceExVat = draft?.costSummary?.priceExVat ?? null;
  const profit = draft?.costSummary?.profit ?? draft?.costSummary?.resourceSlices?.profit ?? null;
  const economics = draft ? {
    cost: directCost,
    priceExVat,
    priceWithVat: draft.costSummary?.priceIncVat ?? null,
    profit,
    profitabilityPercent: directCost != null && directCost > 0 && profit != null
      ? Math.round((profit / directCost) * 10000) / 100
      : null,
    revenueMarginPercent: priceExVat != null && priceExVat > 0 && profit != null
      ? Math.round((profit / priceExVat) * 10000) / 100
      : null,
    incomplete: Boolean(!draft.costSummary || draft.positions.length === 0 ||
      draft.costSummary.totalsIncomplete || draft.costSummary.incomplete?.length || missingRates),
    missingRates,
    missingRateNames: draft.positions.filter((position) => position.rateMissing && !position.isWorkItem).map((position) => position.name),
    incompleteReasons: draft.costSummary?.incomplete ?? [],
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
  let generated: ProjectAnalytics;
  let warning: string | undefined;
  let usedAi = true;
  try {
    generated = await analyzeProjectPackageWithModel(procurement, documents, deterministic, economics, companyContext);
  } catch (error) {
    usedAi = false;
    warning = "ИИ-модель не вернула полный ответ. Сохранил расчёт, источники и конкретный список того, что нужно подтвердить.";
    const failure = error instanceof Error ? error.message : "Неизвестная ошибка модели";
    generated = buildProjectAnalysisFallback(procurement, deterministic, economics, companyContext, failure);
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
  return { warning, usedAi };
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
    .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
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
        `Неизменяемый снимок смет заказчика: ${positions.length} строк итогов и позиций`,
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
      name: `Смета заказчика · ${opts?.fileName ?? sourceNames.join(", ")} · ${p.number} · ${p.id}`,
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

/** Build work stages from parsed estimate sections and work-item parent rows. */
function buildDraftStagesFromEstimate(
  positions: Calculation["positions"],
  now: string
): GprStage[] {
  const sections = new Map<string, { sectionName: string; workName: string; positions: Calculation["positions"] }>();
  for (const position of positions) {
    const section = position.sourceSectionName?.trim();
    if (!section) continue;
    const workName = position.sourceWorkName?.trim() || section;
    const key = `${section}\u0000${workName}`;
    const group = sections.get(key) ?? { sectionName: section, workName, positions: [] };
    group.positions.push(position);
    sections.set(key, group);
  }

  return [...sections.values()].map(({ sectionName, workName, positions: rows }, index) => {
    const stageId = `gs-${Date.now()}-${index + 1}`;
    const workPositions = rows.filter((position) => position.isWorkItem && position.name === workName);
    const workUnits = new Set(workPositions.map((position) => position.unit));
    const workVolume = workPositions.length > 0 && workUnits.size === 1
      ? workPositions.reduce((total, position) => total + position.quantity, 0)
      : null;
    const resources: GprStageResource[] = rows.flatMap((position) => {
      if (position.isWorkItem) return [];
      const code = position.code.toLocaleUpperCase("ru-RU");
      const unit = position.unit.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
      let kind: GprStageResource["kind"] | null = position.resourceKind ?? null;
      if (!kind && /автобус|bus|^BUS(?:[-\s]|$)/iu.test(`${code} ${position.name}`)) kind = "bus";
      else if (!kind && (/^(?:ФСЭМ|ТСЭМ|EQ(?:-|\s|$))/iu.test(code) || classifyDirectCostBucket(position) === "equipment")) kind = "equipment";
      else if (!kind && /^ФССЦПГ/iu.test(code)) kind = "other";
      else if (!kind && (/^(?:ФССЦ|ТССЦ|ФСБЦ|MAT(?:-|\s|$))/iu.test(code) || /щебен|геотекстил|песок|грунт|цемент/iu.test(position.name) || classifyDirectCostBucket(position) === "materials")) kind = "material";
      else if (!kind && (/^(?:LAB(?:-|\s|$)|ОТ|ЗП)/iu.test(code) || classifyDirectCostBucket(position) === "labor")) kind = "labor";
      if (!kind) return [];

      const quantityBasis: GprStageResource["quantityBasis"] = kind === "material"
        ? "material_qty"
        : /(?:маш|чел|н)[\s.-]*ч/u.test(unit)
          ? "total_hours"
          : "uncertain";
      return [{
        id: `res-${stageId}-${position.id}`,
        sourceKey: position.id,
        kind,
        name: position.name,
        quantity: position.quantity,
        unit: position.unit,
        rate: position.rateMissing || !(Number.isFinite(position.rate) && position.rate > 0)
          ? null
          : position.rate,
        quantityBasis,
      }];
    });

    return {
      id: stageId,
      name: workName,
      ...(workName !== sectionName ? { sectionName } : {}),
      start: now.slice(0, 10),
      end: now.slice(0, 10),
      sequence: index + 1,
      crewSize: 0,
      ...(workName !== sectionName ? { workName } : {}),
      ...(workVolume != null ? { planVolume: workVolume, planUnit: workPositions[0].unit } : {}),
      resources,
    };
  });
}

function mergeEstimateRowsIntoDraft(
  existing: Calculation["positions"],
  imported: Calculation["positions"]
): Calculation["positions"] {
  const importedBySourceId = new Map(
    imported.filter((position) => position.sourcePositionId)
      .map((position) => [position.sourcePositionId!, position])
  );
  const refreshed = existing.map((position) => {
    const source = position.sourcePositionId
      ? importedBySourceId.get(position.sourcePositionId)
      : undefined;
    if (!source) return position;
    return {
      ...position,
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
    ...imported.filter((position) => !position.sourcePositionId || !known.has(position.sourcePositionId)),
  ];
}

/**
 * «Отправить в расчёт»: resource draft + GPR, preserve docs,
 * freeze customer estimate as immutable original when present.
 */
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
            ? `Распознано ${allEstimatePositions.length} строк по ${estimateDocsWithData.length} сметам; для ${rowsWithoutSourceRates} строк исходная ставка не извлечена надёжно, поэтому оригинал показывает подтверждённый итог каждой сметы без подмены ставок нулями.`
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

    // Create or refresh editable resource draft
    const positionsFromEstimate = allEstimatePositions
      .filter(({ position }) =>
        Boolean(position.code && position.name && position.unit) &&
        Number.isFinite(position.quantity) &&
        position.quantity > 0
      )
      .map(({ document, position }) => {
        const hit = position.isWorkItem ? null : matchingDirectoryRate(data, position.code, position.unit);
        const unitCompatible = Boolean(hit);
        return {
          id: `draft-${position.id}`,
          code: position.code,
          name: position.name,
          unit: position.unit,
          quantity: position.quantity,
          // The customer rate is never copied into our editable draft.
          rate: unitCompatible ? hit!.rate : 0,
          rateMissing: !unitCompatible && !position.isWorkItem,
          ...(position.isWorkItem ? { isWorkItem: true } : {}),
          ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
          ...(position.sectionName ? { sourceSectionName: position.sectionName } : {}),
          ...(position.workName ? { sourceWorkName: position.workName } : {}),
          sourceDocumentId: document.id,
          sourcePositionId: position.id,
          ...(unitCompatible ? { rateSourceDirectoryId: hit!.dirId } : {}),
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
            ? `Черновик заполнен ${seedPositions.length} распознанными строками из ${estimateDocsWithData.length} смет(ы). Исходные сметы сохранены отдельно и неизменны.`
            : "Ресурсный черновик создан пустым: в документах нет распознанных строк сметы",
          seedPositions.length
            ? "В черновик перенесены только код, наименование, единица и количество. Ставки взяты только из точного совпадения кода и единицы в справочниках; цена заказчика не копировалась."
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
          ...(seedPositions.length ? ["seeded_from_customer_estimate"] : ["awaiting_estimate_rows"]),
        ],
        ...(seedPositions.length
          ? { resourceScheduleParams: EXCEL_RESOURCE_SCHEDULE_DEFAULTS }
          : {}),
      });
      p.calculationId = draftId;
    } else {
      linked.kind = "resource_draft";
      linked.immutable = false;
      linked.pairedCalculationId = p.originalCalculationId;
      linked.status = "v_rabote";
      if (positionsFromEstimate.length > 0) {
        const previousCount = linked.positions.length;
        linked.positions = mergeEstimateRowsIntoDraft(linked.positions, positionsFromEstimate);
        const addedCount = linked.positions.length - previousCount;
        if (addedCount > 0 && previousCount > 0) {
          linked.assumptions = [
            ...(linked.assumptions ?? []),
            `Добавлено ${addedCount} распознанных строк сметы заказчика; существующие ручные позиции сохранены.`,
          ];
        }
      }
      if (linked.positions.length > 0 && positionsFromEstimate.length > 0) {
        linked.assumptions = [
          ...(linked.assumptions ?? []).filter(
            (assumption) => !assumption.startsWith("Ресурсный черновик создан пустым:")
          ),
          `Черновик содержит распознанные строки из ${estimateDocsWithData.length} смет(ы). Исходные сметы сохранены отдельно и неизменны.`,
          "Для импортированных строк перенесены только код, наименование, единица и количество. Ставки взяты только из точного совпадения кода и единицы в справочниках; цена заказчика не копировалась.",
          "Проверьте состав ресурсов и каждую ставку до использования итогов",
        ];
        linked.dataFlags = [
          ...(linked.dataFlags ?? []).filter((flag) => flag !== "awaiting_estimate_rows"),
          "seeded_from_customer_estimate",
          "requires_manual_check",
        ];
        linked.resourceScheduleParams ??= EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
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

    const derivedGprStages = buildDraftStagesFromEstimate(positionsFromEstimate, now);

    // GPR scaffold from explicitly parsed estimate sections; unknown dates and rates stay unconfirmed.
    if (!p.gprId) {
      const gid = `g-${Date.now()}`;
      const stage1 = `gs-${Date.now()}`;
      const placeholderStages: GprStage[] = [
        ensureStageResources({
          id: stage1,
          name: "Подготовка / мобилизация",
          start: now.slice(0, 10),
          end: now.slice(0, 10),
          sequence: 1,
          crewSize: 0,
        }),
        ensureStageResources({
          id: `gs-${Date.now() + 1}`,
          name: "Основные работы",
          start: now.slice(0, 10),
          end: now.slice(0, 10),
          sequence: 2,
          dependsOn: stage1,
          dependencyType: "FS",
          crewSize: 0,
        }),
      ];
      data.schedules.unshift({
        id: gid,
        orgId: p.orgId,
        procurementId: p.id,
        calculationId: draftId!,
        title: `ГПР (черновик) — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        version: 1,
        authorId: actorId,
        assumptions: [
          ...(derivedGprStages.length
            ? [
                "Виды работ и вложенные ресурсы сгруппированы по разделам распознанной сметы. Проверьте состав строк и сопоставьте их с видами работ объекта.",
                "Даты, длительность и производительность не извлечены из сметы; календарь ГПР нужно подтвердить по ТЗ и условиям объекта.",
                "Ставки ресурсов берутся только из справочника компании; неподтверждённые ставки остаются пустыми.",
              ]
            : [
                "Начальные даты и этапы — только навигационная заготовка; замените их по ТЗ, производительности и календарю объекта",
                "Состав и количество ресурсов не подтверждены: заполните строки перед использованием итогов",
              ]),
        ],
        stages: derivedGprStages.length ? derivedGprStages : placeholderStages,
        updatedAt: now,
      });
      p.gprId = gid;
    } else {
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
        const isPlaceholder = s.stages.every((stage) =>
          ["Подготовка / мобилизация", "Основные работы"].includes(stage.name) &&
          (stage.resources ?? []).every((resource) => resource.quantity === 0)
        );
        if (derivedGprStages.length > 0 && isPlaceholder) {
          return {
            ...s,
            calculationId: draftId!,
            updatedAt: now,
            stages: derivedGprStages,
            assumptions: [
              ...(s.assumptions ?? []).filter((item) => !item.startsWith("Начальные даты и этапы")),
              "Виды работ и вложенные ресурсы сгруппированы по разделам распознанной сметы. Проверьте состав строк и сопоставьте их с видами работ объекта.",
              "Даты, длительность и производительность не извлечены из сметы; календарь ГПР нужно подтвердить по ТЗ и условиям объекта.",
              "Ставки ресурсов берутся только из справочника компании; неподтверждённые ставки остаются пустыми.",
            ],
          };
        }

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
    p.analytics = buildProjectAnalytics(
      p,
      data.documents.filter((d) => d.procurementId === p.id)
    );

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

export function shiftGprStage(
  actorId: string,
  scheduleId: string,
  stageId: string,
  deltaDays: number,
  opts?: { cascade?: boolean; resizeDays?: number | null }
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
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
      applyResourceDraftAdjustments(calc);
    }
    if (calc && calc.kind !== "customer_original") {
      const days = gprCoveredDays(item.stages, item.calendar).length;
      if (calc.busRoutes?.length) {
        calc.busRoutes = calc.busRoutes.map((r) => ({ ...r, days }));
      }
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
        const northern = calc.northern ?? {
          applicable: false,
          confirmedItems: [],
          notes: ["Северные ставки не подтверждены"],
        };
        const rs = calc.resourceScheduleParams;
        const useRs = Boolean(rs);
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
          method: useRs
            ? `cost-engine:${engine.profitMethod}+gpr-shift+resource-schedule-excel`
            : `cost-engine:${engine.profitMethod}+gpr-shift`,
          incomplete: engine.incomplete,
          at: new Date().toISOString(),
        };
      }
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

function applyResourceDraftAdjustments(calc: Calculation) {
  const current = calc.costSummary;
  const slices = current?.resourceSlices;
  const params = calc.resourceScheduleParams;
  if (!current || !slices || !params) return;
  const engine = runCostEngine({
    directLabor: slices.labor,
    directMaterials: slices.materials,
    directEquipment: slices.equipment,
    directSubcontract: 0,
    logisticsIncludingBus: 0,
    siteOverhead: slices.overhead,
    officeOverhead: Math.max(0, calc.officeOverhead ?? 0),
    reserve: Math.max(0, current.reserve ?? 0),
    profitMethod: "markup",
    profitRate: params.profitMarkupOnCostWithOh,
    // Preserve the Excel formula: contingency is separate from the markup base.
    includeReserveInPriceBase: false,
    vatPercent: calc.vatPercent ?? null,
    northern: calc.northern ?? {
      applicable: false,
      confirmedItems: [],
      notes: [],
    },
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
    if (patch?.officeOverhead != null) {
      item.officeOverhead = Math.max(0, patch.officeOverhead);
    }

    const linkedSchedule = data.schedules.find(
      (s) => s.calculationId === item.id
    );
    const useRs =
      patch?.useResourceScheduleEconomics ?? Boolean(item.resourceScheduleParams);
    if (useRs && !item.resourceScheduleParams) {
      item.resourceScheduleParams = EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
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
      const synced = syncDraftFromStages(item, linkedSchedule.stages, {
        replacePositions: true,
      });
      Object.assign(item, synced.calc);
      if (item.costSummary) item.costSummary.reserve = reserve;
      applyResourceDraftAdjustments(item);
      const matNeeds = buildMaterialNeeds({
        positions: item.positions,
        stages: linkedSchedule.stages,
      });
      const extra = materialNeedsIncomplete(matNeeds).slice(0, 20);
      if (extra.length && item.costSummary) {
        item.costSummary.incomplete = [
          ...new Set([...(item.costSummary.incomplete ?? []), ...extra]),
        ];
        item.costSummary.totalsIncomplete = true;
      }
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

    const buckets = bucketsFromPositions(
      item.positions,
      item.scenarioFactor || 1
    );
    const routes = item.busRoutes ?? [];
    let logistics = 0;
    const busFlags: string[] = [];
    for (const r of routes) {
      const b = busCost(r);
      logistics = Math.round((logistics + b.total) * 100) / 100;
      busFlags.push(...b.flags);
    }
    const northern: NorthernInputs = item.northern ?? {
      applicable: false,
      confirmedItems: [],
      notes: [
        "Северные/вахтовые элементы есть в эталоне (ШР/ТС/Персонал); универсальный коэффициент не применяем без подтверждения базы",
      ],
    };
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
    const matNeeds = buildMaterialNeeds({
      positions: item.positions,
      stages: linkedSchedule?.stages,
    });
    const incomplete = [
      ...engine.incomplete,
      ...item.positions
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
      method: useRs
        ? `cost-engine:${engine.profitMethod}+resource-schedule-excel`
        : `cost-engine:${engine.profitMethod}`,
      incomplete,
      totalsIncomplete: incomplete.length > 0,
      at: new Date().toISOString(),
    };
    item.dataFlags = [
      ...(item.dataFlags ?? []).filter((f) => !f.startsWith("cost_")),
      "cost_engine_v1",
      ...(useRs ? ["resource_schedule_excel_economics"] : []),
      ...engine.flags,
      ...busFlags,
      ...(engine.incomplete.length ? ["requires_manual_check"] : []),
    ];
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
    for (const photo of incomingPhotos) {
      if (!photos.some((existing) => existing.id === photo.id)) photos.push(photo);
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
    status?: SupplyStatus;
    quoteDraftText?: string;
    supplierName?: string;
    supplierEmail?: string;
    supplierNote?: string;
    qtyOrdered?: number;
    qtyDelivered?: number;
    unitPrice?: number | null;
  }
) {
  return mutateAppData((data) => {
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
        status: input.status ?? row.status,
        quoteDraftText: input.quoteDraftText ?? row.quoteDraftText,
        supplierName: input.supplierName ?? row.supplierName,
        supplierEmail: input.supplierEmail ?? row.supplierEmail,
        supplierNote: input.supplierNote ?? row.supplierNote,
        qtyOrdered: input.qtyOrdered ?? row.qtyOrdered,
        qtyDelivered: input.qtyDelivered ?? row.qtyDelivered,
        unitPrice:
          input.unitPrice === undefined ? row.unitPrice : input.unitPrice,
        updatedAt: now,
      });
      audit(data, actorId, "update", "supply", row.id, row.materialName);
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
      supplierNote: input.supplierNote,
      unitPrice: input.unitPrice ?? null,
      workName: input.workName,
      createdAt: now,
      updatedAt: now,
    };
    data.supplyRequests.unshift(row);
    p.supplyRequestIds = [...(p.supplyRequestIds ?? []), id];
    audit(data, actorId, "create", "supply", id, row.materialName);
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
) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const plan = data.moneyPlans.find((m) => m.id === moneyId);
    if (!plan) throw new Error("Денежный план не найден");
    assertOrgAccess(actor, plan.orgId, "денежного плана");
    const row: MoneyPayment = { ...payment, id: `pay-${Date.now()}` };
    plan.payments = [...plan.payments, row];
    plan.updatedAt = new Date().toISOString();
    audit(data, actorId, "create", "money_payment", row.id, row.title);
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
