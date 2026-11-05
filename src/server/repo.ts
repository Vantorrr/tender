import { DEFAULT_SECTIONS, REVIEW_LABELS } from "@/lib/roles";
import type {
  AppData,
  Calculation,
  CardStatus,
  DocumentItem,
  GprSchedule,
  MoneyPlan,
  PlanFact,
  ReviewStatus,
  RiskRegistry,
  Role,
  SectionKey,
  User,
} from "@/lib/types";
import { rateFromRow, resolveDirectoryRate } from "@/lib/client-dirs";
import { mutateAppData, readAppData, resetAppData } from "@/server/db";
import { hashPassword } from "@/server/passwords";
import { createSession, publicUser } from "@/server/auth";
import { randomBytes } from "node:crypto";

function assertOrgAccess(user: User, orgId: string, label = "записи") {
  if (user.role === "superadmin") return;
  if (orgId !== user.orgId) {
    throw new Error(`Нет доступа к данным другой организации (${label})`);
  }
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
    const { orgId: _o, id: _i, ...safe } = patch;
    void _o;
    void _i;
    data.calculations = data.calculations.map((c) =>
      c.id === id
        ? { ...c, ...safe, updatedAt: new Date().toISOString() }
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
  const factor =
    scenario === "optimisticheskiy"
      ? 0.95
      : scenario === "pessimisticheskiy"
        ? 1.08
        : 1;
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.calculations.find((c) => c.id === id);
    if (!item) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, item.orgId, "расчёта");
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
    const works = positions
      .filter((p) => p.code !== "НР" && p.code !== "СП")
      .reduce((s, p) => s + p.quantity * p.rate, 0);
    const withExtras = positions.map((p) => {
      if (p.code === "НР") {
        return { ...p, rate: Math.round(works * 0.15), unit: "руб" };
      }
      if (p.code === "СП") {
        return { ...p, rate: Math.round(works * 0.08), unit: "руб" };
      }
      return p;
    });
    const rasc = data.directories.find((d) => d.type === "rascenki" && d.current);
    data.calculations = data.calculations.map((c) =>
      c.id === id
        ? {
            ...c,
            positions: withExtras,
            scenario,
            scenarioFactor: factor,
            directoryVersionId: rasc?.id ?? c.directoryVersionId,
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
      `Пересчёт сценария ${scenario} по текущим справочникам`
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
    data.documents = data.documents.map((d) =>
      d.id === id ? { ...d, ...safe } : d
    );
    audit(data, actorId, "update", "document", id, "Обновление документа");
    return data;
  });
}

export function reanalyzeDocument(actorId: string, id: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.documents.find((d) => d.id === id);
    if (!item) throw new Error("Документ не найден");
    assertOrgAccess(actor, item.orgId, "документа");
    data.documents = data.documents.map((d) => {
      if (d.id !== id) return d;
      const nextVersion = d.versions.length + 1;
      return {
        ...d,
        status: "gotovo" as CardStatus,
        versions: [
          ...d.versions,
          {
            id: `dv-${Date.now()}`,
            version: nextVersion,
            authorId: actorId,
            at: new Date().toISOString(),
            note: "Повторный разбор (серверный pipeline)",
          },
        ],
        analyticalNote:
          d.analyticalNote +
          "\n\n[Повторный разбор] Уточнены цитаты и подсветки. Pipeline выполнен на сервере.",
        highlights: [
          ...d.highlights,
          {
            id: `h-re-${Date.now()}`,
            text: "Автоматическая проверка после re-analyze",
            reason: "Требует подтверждения специалистом",
            severity: "info" as const,
            page: 1,
          },
        ],
      };
    });
    audit(data, actorId, "reanalyze", "document", id, "Серверный разбор документа");
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
    fileType: "pdf" | "docx" | "xlsx";
    storedPath?: string;
    fileSize?: number;
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
    const id = `d-${Date.now()}`;
    documentId = id;
    const doc: DocumentItem = {
      id,
      orgId: input.orgId,
      procurementId: input.procurementId,
      title: input.title,
      fileName: input.fileName,
      fileType: input.fileType,
      status: "v_rabote",
      versions: [
        {
          id: `dv-${Date.now()}`,
          version: 1,
          authorId: actorId,
          at: new Date().toISOString(),
          note: "Загрузка на сервер",
        },
      ],
      analyticalNote:
        "Разбор поставлен в очередь. Предварительная записка сформируется после pipeline.",
      citations: [],
      highlights: [],
      uploadedBy: actorId,
      uploadedAt: new Date().toISOString(),
      storedPath: input.storedPath,
      fileSize: input.fileSize,
    };
    data.documents.unshift(doc);
    proc.documentIds = [...proc.documentIds, id];
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
        title: `Черновой расчёт — ${p.title.slice(0, 48)}`,
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
        ],
        scenario: "bazovyy",
        scenarioFactor: 1,
        participateDecision: "na_rassmotrenii",
        directoryVersionId: currentDir?.id ?? "dir-rascenki-1",
        version: 1,
        authorId: actorId,
        updatedAt: now,
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
          {
            id: stage1,
            name: "Подготовка",
            start,
            end: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
            sequence: 1,
          },
          {
            id: stage2,
            name: "Основные работы",
            start: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
            end: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
            sequence: 2,
            dependsOn: stage1,
          },
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
    audit(data, actorId, "update", "gpr", id, "Обновление ГПР");
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

export function injectRiskParse(actorId: string, riskId: string) {
  return mutateAppData((data) => {
    const actor = actorUser(data, actorId);
    const item = data.risks.find((r) => r.id === riskId);
    if (!item) throw new Error("Реестр рисков не найден");
    assertOrgAccess(actor, item.orgId, "реестра рисков");
    const now = Date.now();
    data.risks = data.risks.map((r) =>
      r.id !== riskId
        ? r
        : {
            ...r,
            contractParsed: true,
            status: "trebuet_proverki" as const,
            remarks: [
              ...r.remarks,
              {
                id: `rm-${now}`,
                text: "Штраф за срыв сроков свыше 0,1% в сутки",
                sourceExcerpt: "п. 8.3 договора подряда",
                status: "otkryto" as const,
                severity: "high" as const,
              },
              {
                id: `rm-${now + 1}`,
                text: "Обеспечение исполнения контракта 10%",
                sourceExcerpt: "п. 5.1",
                status: "otkryto" as const,
                severity: "medium" as const,
              },
              {
                id: `rm-${now + 2}`,
                text: "Гарантийный срок 60 месяцев",
                sourceExcerpt: "п. 12.2",
                status: "otkryto" as const,
                severity: "low" as const,
              },
            ],
            updatedAt: new Date().toISOString(),
          }
    );
    audit(data, actorId, "parse", "risk", riskId, "Разбор договора (мок)");
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
    audit(d, resolvedActorId, "reset", "system", "all", "Сброс демо-данных");
    return d;
  });
  // sessions were wiped — выдаём новый токен, чтобы UI не получил 401
  const token = createSession(resolvedActorId);
  return { token, actorId: resolvedActorId };
}
