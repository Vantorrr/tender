import { DEFAULT_SECTIONS, REVIEW_LABELS } from "@/lib/roles";
import type {
  AppData,
  Calculation,
  CardStatus,
  DailyFact,
  DocumentItem,
  GprSchedule,
  MoneyPayment,
  MoneyPlan,
  PlanFact,
  PlanFactEntry,
  ReviewStatus,
  RiskRegistry,
  Role,
  SectionKey,
  SupplyRequest,
  SupplyStatus,
  User,
} from "@/lib/types";
import { rateFromRow, resolveDirectoryRate } from "@/lib/client-dirs";
import { buildProjectAnalytics } from "@/lib/project-analytics";
import { analyzeProjectPackageWithModel } from "@/server/project-analysis-ai";
import {
  bucketsFromPositions,
  busCost,
  runCostEngine,
  shiftStages,
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
import { totalStageCalendarDays } from "@/lib/plan-from-gpr";
import { recomputeEntriesFromDaily } from "@/lib/plan-fact-agg";
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
    const { orgId: _o, id: _i, ...safe } = patch;
    void _o;
    void _i;
    data.procurements = data.procurements.map((p) =>
      p.id === id ? { ...p, ...safe } : p
    );
    audit(data, actorId, "update", "procurement", id, "Обновление закупки");
    return data;
  });
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
      const hit = resolveDirectoryRate(data.directories, p.code);
      if (!hit) return p;
      return {
        ...p,
        rate: hit.rate,
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
      return {
        ...d,
        title: d.title.startsWith("Разбор поставлен") ? prepared.title : d.title,
        status: prepared.status,
        versions: [...d.versions, version],
        analyticalNote: prepared.analyticalNote,
        citations: stampCitationSourceVersion(prepared.citations, versionLabel),
        highlights: prepared.highlights,
        analysis: prepared.analysis,
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
        positions: [
          {
            id: `cp-${Date.now()}`,
            code: "01-01-001-01",
            name: "Подготовительные работы (авто)",
            unit: "компл",
            quantity: 1,
            rate: Math.round(p.nmck * 0.02),
          },
        ],
        assumptions: [
          "Сформировано из карточки закупки",
          "Требует проверки сметчика",
          "Собственные ресурсы только в черновике — не в смете заказчика",
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
        stages: [
          ensureStageResources({
            id: stage1,
            name: "Подготовка",
            start,
            end: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
            sequence: 1,
            crewSize: 4,
          }),
          ensureStageResources({
            id: stage2,
            name: "Основные работы",
            start: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
            end: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
            sequence: 2,
            dependsOn: stage1,
            dependencyType: "FS",
            crewSize: 6,
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
        payments: [
          {
            id: `mp-${Date.now()}`,
            type: "avans",
            title: "Аванс 30%",
            amount: Math.round(p.nmck * 0.3),
            date: now.slice(0, 10),
            week: Math.ceil(
              (new Date().getTime() -
                new Date(new Date().getFullYear(), 0, 1).getTime()) /
                604800000
            ),
            month: new Date().getMonth() + 1,
          },
        ],
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
        entries: [
          {
            id: `pfe-${Date.now()}`,
            workName: "Общий объём",
            unit: "%",
            plan: 100,
            fact: 0,
          },
        ],
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
    data.schedules = data.schedules.map((s) =>
      s.id === id
        ? { ...s, ...safe, updatedAt: new Date().toISOString() }
        : s
    );
    // Only resync explicit resource-linked drafts — never rewrite unrelated/legacy positions.
    const updated = data.schedules.find((s) => s.id === id)!;
    if (safe.stages) {
      const calc = data.calculations.find((c) => c.id === updated.calculationId);
      if (calc && isResourceLinkedDraft(calc)) {
        const synced = syncDraftFromStages(calc, updated.stages, {
          replacePositions: true,
        });
        Object.assign(calc, synced.calc);
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
    quantity?: number;
    rate?: number | null;
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
      { quantity: input.quantity, rate: input.rate },
      input.stageId
    );
    schedule.updatedAt = new Date().toISOString();
    if (calc && isResourceLinkedDraft(calc)) {
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
) {
  const snapshot = readAppData();
  const actor = actorUser(snapshot, actorId);
  const procurement = snapshot.procurements.find((item) => item.id === procurementId);
  if (!procurement) throw new Error("Закупка не найдена");
  assertOrgAccess(actor, procurement.orgId, "закупки");
  const documents = snapshot.documents.filter((document) => document.procurementId === procurement.id);
  const deterministic = buildProjectAnalytics(procurement, documents);
  const generated = await analyzeProjectPackageWithModel(procurement, documents, deterministic);
  mutateAppData((data) => {
    const currentActor = actorUser(data, actorId);
    const current = data.procurements.find((item) => item.id === procurementId);
    if (!current) throw new Error("Закупка не найдена");
    assertOrgAccess(currentActor, current.orgId, "закупки");
    current.analytics = generated;
    audit(data, actorId, "analyze_ai", "procurement", procurementId, "ИИ-анализ полного пакета документов");
    return data;
  });
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
    const estimateDoc = data.documents.find(
      (d) =>
        d.procurementId === p.id &&
        (d.category === "estimate" || /smeta|смет/i.test(d.fileName))
    );
    if (!p.originalCalculationId && estimateDoc?.analysis?.positionCount) {
      const oid = `c-orig-${Date.now()}`;
      const extractedPositions = estimateDoc.estimatePositions ?? [];
      const qty = Math.max(1, estimateDoc.analysis.positionCount);
      const rate =
        estimateDoc.analysis.costThousand != null
          ? Math.round((estimateDoc.analysis.costThousand * 1000) / qty)
          : 0;
      data.calculations.unshift({
        id: oid,
        orgId: p.orgId,
        procurementId: p.id,
        title: `Смета заказчика (оригинал) — ${p.title.slice(0, 40)}`,
        status: "gotovo",
        positions: extractedPositions.length
          ? extractedPositions.map((position) => ({
              id: position.id,
              code: position.code,
              name: position.name,
              unit: position.unit,
              quantity: position.quantity,
              rate: position.rate,
            }))
          : [
              {
                id: `cp-orig-${Date.now()}`,
                code: "CUST-TOTAL",
                name: estimateDoc.analysis.workName || "Итог сметы заказчика",
                unit: "компл",
                quantity: 1,
                rate:
                  estimateDoc.analysis.costThousand != null
                    ? Math.round(estimateDoc.analysis.costThousand * 1000)
                    : rate,
              },
            ],
        assumptions: [
          extractedPositions.length
            ? `Неизменяемый снимок сметы заказчика: ${extractedPositions.length} распознанных позиций`
            : "Неизменяемый снимок сметы заказчика; построчная выгрузка недоступна, показан только итог",
          `Источник: ${estimateDoc.fileName}`,
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
    let draftId = p.calculationId;
    const linked = draftId
      ? data.calculations.find((c) => c.id === draftId)
      : undefined;
    if (!linked || linked.kind === "customer_original" || linked.immutable) {
      draftId = `c-draft-${Date.now()}`;
      const seedPositions =
        linked && !linked.immutable
          ? structuredClone(linked.positions)
          : [
              {
                id: `cp-${Date.now()}`,
                code: "01-01-001-01",
                name: "Подготовительные работы (ресурсный черновик)",
                unit: "компл",
                quantity: 1,
                rate: Math.round(p.nmck * 0.02),
              },
            ];
      data.calculations.unshift({
        id: draftId,
        orgId: p.orgId,
        procurementId: p.id,
        title: `Ресурсный черновик — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        positions: seedPositions,
        assumptions: [
          "Ресурсный метод: черновик для редактирования",
          "Не является утверждённой нормативной сметой",
          "Цифры из справочников / объёмов; причины отклонений без выдумок",
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
        dataFlags: ["requires_manual_check", "no_accuracy_promise"],
      });
      p.calculationId = draftId;
    } else {
      linked.kind = "resource_draft";
      linked.immutable = false;
      linked.pairedCalculationId = p.originalCalculationId;
      linked.status = "v_rabote";
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

    // GPR stub linked to draft
    if (!p.gprId) {
      const gid = `g-${Date.now()}`;
      const stage1 = `gs-${Date.now()}`;
      data.schedules.unshift({
        id: gid,
        orgId: p.orgId,
        procurementId: p.id,
        calculationId: draftId!,
        title: `ГПР (черновик) — ${p.title.slice(0, 48)}`,
        status: "v_rabote",
        version: 1,
        authorId: actorId,
        stages: [
          ensureStageResources({
            id: stage1,
            name: "Подготовка / мобилизация",
            start: now.slice(0, 10),
            end: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
            sequence: 1,
            crewSize: 4,
          }),
          ensureStageResources({
            id: `gs-${Date.now() + 1}`,
            name: "Основные работы",
            start: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
            end: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
            sequence: 2,
            dependsOn: stage1,
            dependencyType: "FS",
            crewSize: 6,
          }),
        ],
        updatedAt: now,
      });
      p.gprId = gid;
    } else {
      data.schedules = data.schedules.map((s) =>
        s.id === p.gprId
          ? { ...s, calculationId: draftId!, updatedAt: now }
          : s
      );
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
      const oldDays = Math.max(1, totalStageCalendarDays([previous]));
      const newDays = Math.max(1, totalStageCalendarDays([stage]));
      if (oldDays === newDays) return stage;
      return {
        ...stage,
        resources: (stage.resources ?? []).map((resource) => {
          if (resource.kind === "material") return resource;
          // Resource duration follows its GPR stage until the user gives it a
          // different P value. Explicitly shortened/extended resource windows
          // therefore stay independent from the stage calendar.
          return resource.days == null || resource.days === oldDays
            ? { ...resource, days: newDays }
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
        calc.resourceScheduleParams
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
      const days = totalStageCalendarDays(item.stages);
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
          vatPercent: null,
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
      `Сдвиг ${stageId} на ${deltaDays} дн.; конфликтов ${result.conflicts.length}; связанные дни автобуса=${totalStageCalendarDays(item.stages)}`
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
    vatPercent: null,
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
      isResourceLinkedDraft(item)
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
      vatPercent: patch?.vatPercent ?? null,
      northern,
    });
    const matNeeds = buildMaterialNeeds({
      positions: item.positions,
      stages: linkedSchedule?.stages,
    });
    const incomplete = [
      ...engine.incomplete,
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
        entries: [
          {
            id: `pfe-${Date.now()}`,
            workName: "Общий объём",
            unit: "%",
            plan: 100,
            fact: 0,
            contractRemaining: 100,
          },
        ],
        dailyFacts: [],
        updatedAt: now,
      });
      p.planFactId = id;
    }
    const pf = data.planFacts.find((x) => x.id === p.planFactId)!;
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
    const sameDay = currentFacts.filter(
      (item) => item.date === fact.date && item.workName === workName
    );
    const latest = sameDay.reduce<DailyFact | undefined>(
      (best, item) => (!best || item.at > best.at ? item : best),
      undefined
    );
    const incomingPhotos = fact.photos ?? [];
    const photos = [...sameDay.flatMap((item) => item.photos ?? [])];
    for (const photo of incomingPhotos) {
      if (!photos.some((existing) => existing.id === photo.id)) photos.push(photo);
    }
    const entry: DailyFact = {
      id: latest?.id ?? `df-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: fact.date,
      workName,
      unit,
      quantity: fact.quantity,
      people: fact.people ?? latest?.people,
      equipment: fact.equipment ?? latest?.equipment,
      materialsNote: fact.materialsNote ?? latest?.materialsNote,
      resourceLines: fact.resourceLines ?? latest?.resourceLines,
      comment: fact.comment ?? latest?.comment,
      // Saving a day edits its current record. Previously attached photos stay
      // with that day; a newly uploaded photo is appended once.
      photos,
      authorId: actorId,
      at: new Date().toISOString(),
    };
    // Older versions could create duplicate rows for the same day/work. Fold
    // those rows into this one so another save cannot inflate physical volume.
    pf.dailyFacts = [
      ...currentFacts.filter(
        (item) => item.date !== fact.date || item.workName !== workName
      ),
      entry,
    ];
    // Daily records are source of truth for works that have them
    recomputeEntriesFromDaily(pf);
    // Physical index ≠ money; economics only from confirmed rates
    const proc = data.procurements.find((x) => x.id === pf.procurementId);
    const calc = data.calculations.find(
      (c) => c.id === proc?.calculationId || c.procurementId === pf.procurementId
    );
    const eco = economicsFromVolumes({
      entries: pf.entries,
      daily: pf.dailyFacts,
      positions: calc?.positions ?? [],
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
      incurredCosts: incurred,
      incomplete: eco.incomplete,
      notes: [
        "earnedValue = физ. индекс объёма (не ₽)",
        "economicsAuto = объём×подтверждённые расценки (иначе null)",
        "касса / признанная выручка — отдельные ручные поля",
        ...(prev.notes ?? []).filter(
          (n) =>
            !n.startsWith("earnedValue") &&
            !n.startsWith("Нормативная") &&
            !n.startsWith("economicsAuto")
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
