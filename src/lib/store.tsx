"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createSeedData, SESSION_KEY, STORAGE_KEY } from "./seed";
import type {
  AppData,
  Calculation,
  CardStatus,
  DocumentItem,
  GprSchedule,
  MoneyPlan,
  NotificationItem,
  PlanFact,
  Procurement,
  ReviewStatus,
  RiskRegistry,
  Role,
  SectionKey,
  User,
} from "./types";
import { DEFAULT_SECTIONS } from "./roles";

interface Session {
  userId: string;
}

interface StoreContextValue {
  ready: boolean;
  data: AppData;
  user: User | null;
  login: (email: string, password: string) => { ok: boolean; error?: string };
  logout: () => void;
  requestRecovery: (email: string) => { ok: boolean; message: string };
  resetData: () => void;
  markNotificationRead: (id: string) => void;
  updateUser: (id: string, patch: Partial<User>) => void;
  createUser: (input: Omit<User, "id" | "createdAt">) => void;
  setUserRole: (userId: string, role: Role, comment: string) => void;
  setUserSections: (userId: string, sections: SectionKey[]) => void;
  setProcurementReview: (id: string, status: ReviewStatus) => void;
  updateCalculation: (id: string, patch: Partial<Calculation>) => void;
  recalcCalculation: (id: string, scenario: Calculation["scenario"]) => void;
  updateDocument: (id: string, patch: Partial<DocumentItem>) => void;
  reanalyzeDocument: (id: string) => void;
  updateSchedule: (id: string, patch: Partial<GprSchedule>) => void;
  updateMoney: (id: string, patch: Partial<MoneyPlan>) => void;
  updateRisk: (id: string, patch: Partial<RiskRegistry>) => void;
  updatePlanFact: (id: string, patch: Partial<PlanFact>) => void;
  setDirectoryCurrent: (id: string) => void;
  importDirectoryRows: (
    type: AppData["directories"][0]["type"],
    rows: Record<string, string | number>[]
  ) => void;
  confirmSmetaExchange: (id: string) => void;
  addAudit: (action: string, entity: string, entityId: string, detail: string) => void;
  orgProcurements: Procurement[];
  orgDocuments: DocumentItem[];
  unreadCount: number;
}

const StoreContext = createContext<StoreContextValue | null>(null);

function loadData(): AppData {
  if (typeof window === "undefined") return createSeedData();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppData;
  } catch {
    /* ignore */
  }
  return createSeedData();
}

function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw) as Session;
  } catch {
    /* ignore */
  }
  return null;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<AppData>(createSeedData);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    setData(loadData());
    setSession(loadSession());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, ready]);

  useEffect(() => {
    if (!ready) return;
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }, [session, ready]);

  const user = useMemo(
    () => data.users.find((u) => u.id === session?.userId) ?? null,
    [data.users, session]
  );

  const persist = useCallback((updater: (prev: AppData) => AppData) => {
    setData((prev) => updater(prev));
  }, []);

  const addAudit = useCallback(
    (action: string, entity: string, entityId: string, detail: string) => {
      persist((prev) => ({
        ...prev,
        auditLog: [
          {
            id: `aud-${Date.now()}`,
            at: new Date().toISOString(),
            actorId: session?.userId ?? "system",
            action,
            entity,
            entityId,
            detail,
          },
          ...prev.auditLog,
        ],
      }));
    },
    [persist, session?.userId]
  );

  const login = useCallback(
    (email: string, password: string) => {
      const found = data.users.find(
        (u) => u.email.toLowerCase() === email.trim().toLowerCase()
      );
      if (!found || found.password !== password) {
        return { ok: false, error: "Неверный email или пароль" };
      }
      if (found.blocked) {
        return { ok: false, error: "Учётная запись заблокирована" };
      }
      setSession({ userId: found.id });
      return { ok: true };
    },
    [data.users]
  );

  const logout = useCallback(() => setSession(null), []);

  const requestRecovery = useCallback(
    (email: string) => {
      const found = data.users.find(
        (u) => u.email.toLowerCase() === email.trim().toLowerCase()
      );
      if (!found) {
        return {
          ok: true,
          message:
            "Если аккаунт существует, на почту отправлена ссылка для восстановления (мок: проверьте демо-пароли в инструкции).",
        };
      }
      return {
        ok: true,
        message: `Письмо отправлено на ${found.email}. Демо-пароль: ${found.password}`,
      };
    },
    [data.users]
  );

  const resetData = useCallback(() => {
    const seed = createSeedData();
    setData(seed);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
  }, []);

  const markNotificationRead = useCallback(
    (id: string) => {
      persist((prev) => ({
        ...prev,
        notifications: prev.notifications.map((n) =>
          n.id === id ? { ...n, read: true } : n
        ),
      }));
    },
    [persist]
  );

  const updateUser = useCallback(
    (id: string, patch: Partial<User>) => {
      persist((prev) => ({
        ...prev,
        users: prev.users.map((u) => (u.id === id ? { ...u, ...patch } : u)),
      }));
      addAudit("update", "user", id, "Обновление пользователя");
    },
    [persist, addAudit]
  );

  const createUser = useCallback(
    (input: Omit<User, "id" | "createdAt">) => {
      const id = `u-${Date.now()}`;
      persist((prev) => ({
        ...prev,
        users: [
          ...prev.users,
          { ...input, id, createdAt: new Date().toISOString() },
        ],
        roleHistory: [
          {
            id: `rh-${Date.now()}`,
            userId: id,
            fromRole: null,
            toRole: input.role,
            changedBy: session?.userId ?? "system",
            at: new Date().toISOString(),
            comment: "Создание пользователя",
          },
          ...prev.roleHistory,
        ],
      }));
      addAudit("create", "user", id, `Создан пользователь ${input.email}`);
    },
    [persist, addAudit, session?.userId]
  );

  const setUserRole = useCallback(
    (userId: string, role: Role, comment: string) => {
      persist((prev) => {
        const current = prev.users.find((u) => u.id === userId);
        if (!current) return prev;
        return {
          ...prev,
          users: prev.users.map((u) =>
            u.id === userId
              ? { ...u, role, sections: DEFAULT_SECTIONS[role] }
              : u
          ),
          roleHistory: [
            {
              id: `rh-${Date.now()}`,
              userId,
              fromRole: current.role,
              toRole: role,
              changedBy: session?.userId ?? "system",
              at: new Date().toISOString(),
              comment,
            },
            ...prev.roleHistory,
          ],
        };
      });
      addAudit("role_change", "user", userId, comment);
    },
    [persist, addAudit, session?.userId]
  );

  const setUserSections = useCallback(
    (userId: string, sections: SectionKey[]) => {
      updateUser(userId, { sections });
    },
    [updateUser]
  );

  const setProcurementReview = useCallback(
    (id: string, status: ReviewStatus) => {
      persist((prev) => ({
        ...prev,
        procurements: prev.procurements.map((p) =>
          p.id === id ? { ...p, reviewStatus: status } : p
        ),
      }));
      addAudit("review", "procurement", id, `Статус рассмотрения: ${status}`);
    },
    [persist, addAudit]
  );

  const updateCalculation = useCallback(
    (id: string, patch: Partial<Calculation>) => {
      persist((prev) => ({
        ...prev,
        calculations: prev.calculations.map((c) =>
          c.id === id
            ? { ...c, ...patch, updatedAt: new Date().toISOString() }
            : c
        ),
      }));
    },
    [persist]
  );

  const recalcCalculation = useCallback(
    (id: string, scenario: Calculation["scenario"]) => {
      const factor =
        scenario === "optimisticheskiy"
          ? 0.95
          : scenario === "pessimisticheskiy"
            ? 1.08
            : 1;
      updateCalculation(id, {
        scenario,
        scenarioFactor: factor,
        status: "trebuet_proverki" as CardStatus,
      });
      addAudit("recalc", "calculation", id, `Сценарий: ${scenario}`);
    },
    [updateCalculation, addAudit]
  );

  const updateDocument = useCallback(
    (id: string, patch: Partial<DocumentItem>) => {
      persist((prev) => ({
        ...prev,
        documents: prev.documents.map((d) =>
          d.id === id ? { ...d, ...patch } : d
        ),
      }));
    },
    [persist]
  );

  const reanalyzeDocument = useCallback(
    (id: string) => {
      persist((prev) => ({
        ...prev,
        documents: prev.documents.map((d) => {
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
                authorId: session?.userId ?? "system",
                at: new Date().toISOString(),
                note: "Повторный разбор",
              },
            ],
            analyticalNote:
              d.analyticalNote +
              "\n\n[Повторный разбор] Уточнены цитаты и подсветки для ручной проверки.",
          };
        }),
      }));
      addAudit("reanalyze", "document", id, "Повторный разбор документа");
    },
    [persist, addAudit, session?.userId]
  );

  const updateSchedule = useCallback(
    (id: string, patch: Partial<GprSchedule>) => {
      persist((prev) => ({
        ...prev,
        schedules: prev.schedules.map((s) =>
          s.id === id
            ? { ...s, ...patch, updatedAt: new Date().toISOString() }
            : s
        ),
      }));
    },
    [persist]
  );

  const updateMoney = useCallback(
    (id: string, patch: Partial<MoneyPlan>) => {
      persist((prev) => ({
        ...prev,
        moneyPlans: prev.moneyPlans.map((m) =>
          m.id === id
            ? { ...m, ...patch, updatedAt: new Date().toISOString() }
            : m
        ),
      }));
    },
    [persist]
  );

  const updateRisk = useCallback(
    (id: string, patch: Partial<RiskRegistry>) => {
      persist((prev) => ({
        ...prev,
        risks: prev.risks.map((r) =>
          r.id === id
            ? { ...r, ...patch, updatedAt: new Date().toISOString() }
            : r
        ),
      }));
    },
    [persist]
  );

  const updatePlanFact = useCallback(
    (id: string, patch: Partial<PlanFact>) => {
      persist((prev) => ({
        ...prev,
        planFacts: prev.planFacts.map((p) =>
          p.id === id
            ? { ...p, ...patch, updatedAt: new Date().toISOString() }
            : p
        ),
      }));
    },
    [persist]
  );

  const setDirectoryCurrent = useCallback(
    (id: string) => {
      persist((prev) => {
        const target = prev.directories.find((d) => d.id === id);
        if (!target) return prev;
        return {
          ...prev,
          directories: prev.directories.map((d) =>
            d.type === target.type
              ? { ...d, current: d.id === id }
              : d
          ),
        };
      });
      addAudit("directory", "directory", id, "Установлена текущая версия справочника");
    },
    [persist, addAudit]
  );

  const importDirectoryRows = useCallback(
    (
      type: AppData["directories"][0]["type"],
      rows: Record<string, string | number>[]
    ) => {
      const sameType = data.directories.filter((d) => d.type === type);
      const nextVersion =
        Math.max(0, ...sameType.map((d) => d.version)) + 1;
      const id = `dir-${type}-${nextVersion}`;
      persist((prev) => ({
        ...prev,
        directories: [
          ...prev.directories.map((d) =>
            d.type === type ? { ...d, current: false } : d
          ),
          {
            id,
            type,
            name:
              type === "normy"
                ? "Нормы (импорт Excel)"
                : type === "rascenki"
                  ? "Расценки (импорт Excel)"
                  : type === "ceny"
                    ? "Цены (импорт Excel)"
                    : "Профиль закупок (импорт)",
            version: nextVersion,
            authorId: session?.userId ?? "system",
            at: new Date().toISOString(),
            current: true,
            rows,
          },
        ],
      }));
      addAudit("import", "directory", id, `Импорт Excel, версия ${nextVersion}`);
    },
    [data.directories, persist, addAudit, session?.userId]
  );

  const confirmSmetaExchange = useCallback(
    (id: string) => {
      persist((prev) => ({
        ...prev,
        smetaExchanges: prev.smetaExchanges.map((s) =>
          s.id === id ? { ...s, confirmed: true } : s
        ),
      }));
      addAudit("confirm", "smeta", id, "Подтверждён обмен со сметным ПО");
    },
    [persist, addAudit]
  );

  const orgId = user?.orgId;

  const orgProcurements = useMemo(
    () => data.procurements.filter((p) => p.orgId === orgId),
    [data.procurements, orgId]
  );

  const orgDocuments = useMemo(
    () => data.documents.filter((d) => d.orgId === orgId),
    [data.documents, orgId]
  );

  const unreadCount = useMemo(() => {
    if (!user) return 0;
    return data.notifications.filter((n) => n.userId === user.id && !n.read)
      .length;
  }, [data.notifications, user]);

  const value: StoreContextValue = {
    ready,
    data,
    user,
    login,
    logout,
    requestRecovery,
    resetData,
    markNotificationRead,
    updateUser,
    createUser,
    setUserRole,
    setUserSections,
    setProcurementReview,
    updateCalculation,
    recalcCalculation,
    updateDocument,
    reanalyzeDocument,
    updateSchedule,
    updateMoney,
    updateRisk,
    updatePlanFact,
    setDirectoryCurrent,
    importDirectoryRows,
    confirmSmetaExchange,
    addAudit,
    orgProcurements,
    orgDocuments,
    unreadCount,
  };

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

export function userNotifications(
  notifications: NotificationItem[],
  userId: string
) {
  return notifications.filter((n) => n.userId === userId);
}
