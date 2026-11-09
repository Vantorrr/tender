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
import { createSeedData } from "./seed";
import { api, setClientToken } from "./api";
import type {
  AppData,
  Calculation,
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

type PublicUser = Omit<User, "password" | "secretKey" | "secretKeyHash"> & {
  hasSecretKey?: boolean;
};

interface BootstrapResponse {
  user: PublicUser;
  data: AppData;
  jobs?: unknown[];
}

interface StoreContextValue {
  ready: boolean;
  data: AppData;
  user: PublicUser | null;
  login: (
    email: string,
    password: string
  ) => Promise<{ ok: boolean; error?: string }>;
  loginWithSecret: (
    secretKey: string
  ) => Promise<{ ok: boolean; error?: string }>;
  issueSecretKey: (userId: string) => Promise<string>;
  logout: () => Promise<void>;
  requestRecovery: (email: string) => Promise<{ ok: boolean; message: string }>;
  resetPasswordWithCode: (
    email: string,
    code: string,
    newPassword: string
  ) => Promise<{ ok: boolean; message: string }>;
  resetData: () => Promise<void>;
  refresh: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  updateUser: (id: string, patch: Partial<User>) => Promise<void>;
  createUser: (input: Omit<User, "id" | "createdAt">) => Promise<void>;
  setUserRole: (userId: string, role: Role, comment: string) => Promise<void>;
  setUserSections: (userId: string, sections: SectionKey[]) => Promise<void>;
  setProcurementReview: (id: string, status: ReviewStatus) => Promise<void>;
  updateCalculation: (id: string, patch: Partial<Calculation>) => Promise<void>;
  recalcCalculation: (
    id: string,
    scenario: Calculation["scenario"]
  ) => Promise<void>;
  addCalcFromDirectory: (
    id: string,
    input: {
      type: "rascenki" | "ceny" | "park";
      code: string;
      quantity?: number;
      rateKey?: string;
    }
  ) => Promise<void>;
  updateDocument: (id: string, patch: Partial<DocumentItem>) => Promise<void>;
  reanalyzeDocument: (id: string, opts?: { useLlm?: boolean }) => Promise<void>;
  createDocumentUpload: (input: {
    procurementId: string;
    title?: string;
    file: File;
    category?: string;
  }) => Promise<void>;
  updateSchedule: (id: string, patch: Partial<GprSchedule>) => Promise<void>;
  patchScheduleResource: (
    scheduleId: string,
    input: {
      resourceId: string;
      stageId?: string;
      quantity?: number;
      rate?: number | null;
    }
  ) => Promise<void>;
  updateMoney: (id: string, patch: Partial<MoneyPlan>) => Promise<void>;
  updateRisk: (id: string, patch: Partial<RiskRegistry>) => Promise<void>;
  parseRiskContract: (id: string) => Promise<void>;
  updatePlanFact: (id: string, patch: Partial<PlanFact>) => Promise<void>;
  setDirectoryCurrent: (id: string) => Promise<void>;
  importDirectoryRows: (
    type: AppData["directories"][0]["type"],
    rows: Record<string, string | number>[]
  ) => Promise<void>;
  importDirectoryFile: (
    type: AppData["directories"][0]["type"],
    file: File
  ) => Promise<void>;
  confirmSmetaExchange: (id: string) => Promise<void>;
  importSmetaFile: (file: File, calcId?: string) => Promise<void>;
  runSyncJob: () => Promise<void>;
  ensureChain: (procurementId: string) => Promise<void>;
  sendToCalculation: (procurementId: string) => Promise<void>;
  refreshAnalytics: (procurementId: string) => Promise<void>;
  analyzeProjectWithAI: (procurementId: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  setOrganizationActive: (orgId: string, active: boolean) => Promise<void>;
  importClientXlsx: () => Promise<{
    equipment: number;
    labor: number;
    fleet: number;
    files?: string[];
    source?: string;
  }>;
  addAudit: (
    action: string,
    entity: string,
    entityId: string,
    detail: string
  ) => void;
  orgProcurements: Procurement[];
  orgDocuments: DocumentItem[];
  unreadCount: number;
}

const StoreContext = createContext<StoreContextValue | null>(null);

function applyBootstrap(
  payload: BootstrapResponse,
  setUser: (u: PublicUser | null) => void,
  setData: (d: AppData) => void
) {
  setUser(payload.user);
  setData(payload.data);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<AppData>(createSeedData);
  const [user, setUser] = useState<PublicUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: PublicUser | null }>("/api/auth/me");
      if (!me.user) {
        setClientToken(null);
        setUser(null);
        setData(createSeedData());
        return;
      }
      const boot = await api<BootstrapResponse>("/api/bootstrap");
      applyBootstrap(boot, setUser, setData);
    } catch {
      setClientToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setReady(true));
  }, [refresh]);

  const applyBoot = useCallback((boot: BootstrapResponse & { token?: string }) => {
    if (boot.token) setClientToken(boot.token);
    applyBootstrap(boot, setUser, setData);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await api<{ user: PublicUser; token: string }>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ email, password }),
        }
      );
      setClientToken(res.token);
      const boot = await api<BootstrapResponse>("/api/bootstrap");
      applyBootstrap(boot, setUser, setData);
      return { ok: true };
    } catch (e) {
      setClientToken(null);
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Ошибка входа",
      };
    }
  }, []);

  const loginWithSecret = useCallback(async (secretKey: string) => {
    try {
      const res = await api<{ user: PublicUser; token: string }>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ secretKey }),
        }
      );
      setClientToken(res.token);
      const boot = await api<BootstrapResponse>("/api/bootstrap");
      applyBootstrap(boot, setUser, setData);
      return { ok: true };
    } catch (e) {
      setClientToken(null);
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Ошибка входа",
      };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setClientToken(null);
    setUser(null);
    setData(createSeedData());
  }, []);

  const requestRecovery = useCallback(async (email: string) => {
    const res = await api<{ message: string }>("/api/auth/recover", {
      method: "POST",
      body: JSON.stringify({ email, action: "request" }),
    });
    return { ok: true, message: res.message };
  }, []);

  const resetPasswordWithCode = useCallback(
    async (email: string, code: string, newPassword: string) => {
      const res = await api<{ message: string }>("/api/auth/recover", {
        method: "POST",
        body: JSON.stringify({ email, code, newPassword, action: "reset" }),
      });
      return { ok: true, message: res.message };
    },
    []
  );

  const resetData = useCallback(async () => {
    const boot = await api<BootstrapResponse>("/api/admin", {
      method: "POST",
      body: JSON.stringify({ action: "reset" }),
    });
    applyBoot(boot);
  }, [applyBoot]);

  const markNotificationRead = useCallback(
    async (id: string) => {
      const boot = await api<BootstrapResponse>("/api/notifications", {
        method: "PATCH",
        body: JSON.stringify({ id }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const markAllNotificationsRead = useCallback(async () => {
    const boot = await api<BootstrapResponse>("/api/notifications", {
      method: "PATCH",
      body: JSON.stringify({ markAll: true }),
    });
    applyBoot(boot);
  }, [applyBoot]);

  const setOrganizationActive = useCallback(
    async (orgId: string, active: boolean) => {
      const boot = await api<BootstrapResponse & { token?: string }>(
        "/api/admin",
        {
          method: "POST",
          body: JSON.stringify({ action: "setOrgActive", orgId, active }),
        }
      );
      applyBoot(boot);
    },
    [applyBoot]
  );

  const importClientXlsx = useCallback(async () => {
    const boot = await api<
      BootstrapResponse & {
        importResult?: {
          equipment: number;
          labor: number;
          fleet: number;
          files?: string[];
          source?: string;
        };
      }
    >("/api/admin", {
      method: "POST",
      body: JSON.stringify({ action: "importClientXlsx" }),
    });
    applyBoot(boot);
    return (
      boot.importResult ?? { equipment: 0, labor: 0, fleet: 0 }
    );
  }, [applyBoot]);

  const updateUser = useCallback(
    async (id: string, patch: Partial<User>) => {
      const boot = await api<BootstrapResponse>("/api/users", {
        method: "PATCH",
        body: JSON.stringify({ id, patch }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const createUser = useCallback(
    async (input: Omit<User, "id" | "createdAt">) => {
      const boot = await api<BootstrapResponse>("/api/users", {
        method: "POST",
        body: JSON.stringify(input),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const setUserRole = useCallback(
    async (userId: string, role: Role, comment: string) => {
      const boot = await api<BootstrapResponse>("/api/users", {
        method: "PATCH",
        body: JSON.stringify({ id: userId, role, comment }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const setUserSections = useCallback(
    async (userId: string, sections: SectionKey[]) => {
      const boot = await api<BootstrapResponse>("/api/users", {
        method: "PATCH",
        body: JSON.stringify({ id: userId, sections }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const issueSecretKey = useCallback(
    async (userId: string) => {
      const boot = await api<BootstrapResponse & { issuedSecretKey?: string }>(
        "/api/users",
        {
          method: "PATCH",
          body: JSON.stringify({ id: userId, action: "issueSecretKey" }),
        }
      );
      applyBoot(boot);
      if (!boot.issuedSecretKey) {
        throw new Error("Ключ не выдан");
      }
      return boot.issuedSecretKey;
    },
    [applyBoot]
  );

  const setProcurementReview = useCallback(
    async (id: string, status: ReviewStatus) => {
      const boot = await api<BootstrapResponse>("/api/zakupki", {
        method: "PATCH",
        body: JSON.stringify({ id, reviewStatus: status }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const updateCalculation = useCallback(
    async (id: string, patch: Partial<Calculation>) => {
      const boot = await api<BootstrapResponse>("/api/raschety", {
        method: "PATCH",
        body: JSON.stringify({ id, patch }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const recalcCalculation = useCallback(
    async (id: string, scenario: Calculation["scenario"]) => {
      const boot = await api<BootstrapResponse>("/api/raschety", {
        method: "PATCH",
        body: JSON.stringify({ id, recalcScenario: scenario }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const addCalcFromDirectory = useCallback(
    async (
      id: string,
      input: {
        type: "rascenki" | "ceny" | "park";
        code: string;
        quantity?: number;
        rateKey?: string;
      }
    ) => {
      const boot = await api<BootstrapResponse>("/api/raschety", {
        method: "PATCH",
        body: JSON.stringify({ id, addFromDirectory: input }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const updateDocument = useCallback(
    async (id: string, patch: Partial<DocumentItem>) => {
      const boot = await api<BootstrapResponse>("/api/dokumenty", {
        method: "PATCH",
        body: JSON.stringify({ id, patch }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const reanalyzeDocument = useCallback(
    async (id: string, opts?: { useLlm?: boolean }) => {
      const boot = await api<BootstrapResponse>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          type: "document_reanalyze",
          documentId: id,
          useLlm: Boolean(opts?.useLlm),
        }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const createDocumentUpload = useCallback(
    async (input: {
      procurementId: string;
      title?: string;
      file: File;
      category?: string;
    }) => {
      const form = new FormData();
      form.append("file", input.file);
      form.append("procurementId", input.procurementId);
      if (input.title) form.append("title", input.title);
      if (input.category) form.append("category", input.category);
      const boot = await api<BootstrapResponse>("/api/dokumenty", {
        method: "POST",
        body: form,
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const updateSchedule = useCallback(
    async (id: string, patch: Partial<GprSchedule>) => {
      const boot = await api<BootstrapResponse>("/api/gpr", {
        method: "PATCH",
        body: JSON.stringify({ id, patch }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const patchScheduleResource = useCallback(
    async (
      scheduleId: string,
      input: {
        resourceId: string;
        stageId?: string;
        quantity?: number;
        rate?: number | null;
      }
    ) => {
      const boot = await api<BootstrapResponse>("/api/gpr", {
        method: "PATCH",
        body: JSON.stringify({
          id: scheduleId,
          action: "patchResource",
          resourceId: input.resourceId,
          stageId: input.stageId,
          quantity: input.quantity,
          rate: input.rate,
        }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const updateMoney = useCallback(
    async (id: string, patch: Partial<MoneyPlan>) => {
      const boot = await api<BootstrapResponse>("/api/dengi", {
        method: "PATCH",
        body: JSON.stringify({ id, patch }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const updateRisk = useCallback(
    async (id: string, patch: Partial<RiskRegistry>) => {
      const boot = await api<BootstrapResponse>("/api/riski", {
        method: "PATCH",
        body: JSON.stringify({ id, patch }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const parseRiskContract = useCallback(
    async (id: string) => {
      const boot = await api<BootstrapResponse>("/api/riski", {
        method: "PATCH",
        body: JSON.stringify({ id, action: "parse" }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const updatePlanFact = useCallback(
    async (id: string, patch: Partial<PlanFact>) => {
      const boot = await api<BootstrapResponse>("/api/proizvodstvo", {
        method: "PATCH",
        body: JSON.stringify({ id, patch }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const setDirectoryCurrent = useCallback(
    async (id: string) => {
      const boot = await api<BootstrapResponse>("/api/spravochniki", {
        method: "POST",
        body: JSON.stringify({ action: "setCurrent", id }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const importDirectoryRows = useCallback(
    async (
      type: AppData["directories"][0]["type"],
      rows: Record<string, string | number>[]
    ) => {
      const boot = await api<BootstrapResponse>("/api/spravochniki", {
        method: "POST",
        body: JSON.stringify({ action: "import", type, rows }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const importDirectoryFile = useCallback(
    async (type: AppData["directories"][0]["type"], file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("type", type);
      const boot = await api<BootstrapResponse>("/api/spravochniki", {
        method: "POST",
        body: form,
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const confirmSmetaExchange = useCallback(
    async (id: string) => {
      const boot = await api<BootstrapResponse>("/api/smeta", {
        method: "POST",
        body: JSON.stringify({ action: "confirm", id }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const importSmetaFile = useCallback(
    async (file: File, calcId = "c-1") => {
      const form = new FormData();
      form.append("file", file);
      form.append("calcId", calcId);
      const boot = await api<BootstrapResponse>("/api/smeta", {
        method: "POST",
        body: form,
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const runSyncJob = useCallback(async () => {
    const boot = await api<BootstrapResponse>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ type: "procurement_sync" }),
    });
    applyBoot(boot);
  }, [applyBoot]);

  const ensureChain = useCallback(
    async (procurementId: string) => {
      const boot = await api<BootstrapResponse>("/api/zakupki", {
        method: "POST",
        body: JSON.stringify({ action: "ensureChain", id: procurementId }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const sendToCalculation = useCallback(
    async (procurementId: string) => {
      const boot = await api<BootstrapResponse>("/api/zakupki", {
        method: "POST",
        body: JSON.stringify({
          action: "sendToCalculation",
          id: procurementId,
        }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const refreshAnalytics = useCallback(
    async (procurementId: string) => {
      const boot = await api<BootstrapResponse>("/api/zakupki", {
        method: "POST",
        body: JSON.stringify({
          action: "refreshAnalytics",
          id: procurementId,
        }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const analyzeProjectWithAI = useCallback(
    async (procurementId: string) => {
      const boot = await api<BootstrapResponse>("/api/zakupki", {
        method: "POST",
        body: JSON.stringify({ action: "analyzeProject", id: procurementId }),
      });
      applyBoot(boot);
    },
    [applyBoot]
  );

  const addAudit = useCallback(() => {
    /* audit is server-side now */
  }, []);

  const orgProcurements = useMemo(
    () => data.procurements,
    [data.procurements]
  );
  const orgDocuments = useMemo(() => data.documents, [data.documents]);
  const unreadCount = useMemo(() => {
    if (!user) return 0;
    return data.notifications.filter((n) => !n.read).length;
  }, [data.notifications, user]);

  const value: StoreContextValue = {
    ready,
    data,
    user,
    login,
    loginWithSecret,
    issueSecretKey,
    logout,
    requestRecovery,
    resetPasswordWithCode,
    resetData,
    refresh,
    markNotificationRead,
    markAllNotificationsRead,
    setOrganizationActive,
    importClientXlsx,
    updateUser,
    createUser,
    setUserRole,
    setUserSections,
    setProcurementReview,
    updateCalculation,
    recalcCalculation,
    addCalcFromDirectory,
    updateDocument,
    reanalyzeDocument,
    createDocumentUpload,
    updateSchedule,
    patchScheduleResource,
    updateMoney,
    updateRisk,
    parseRiskContract,
    updatePlanFact,
    setDirectoryCurrent,
    importDirectoryRows,
    importDirectoryFile,
    confirmSmetaExchange,
    importSmetaFile,
    runSyncJob,
    ensureChain,
    sendToCalculation,
    refreshAnalytics,
    analyzeProjectWithAI,
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
