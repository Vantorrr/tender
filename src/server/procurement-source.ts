/**
 * Adapter boundary for the external procurement feed.
 * Real vendor credentials are NOT agreed (kickoff) — do not invent them.
 * Default runtime = empty stub with honest `not_configured` (never invents notices).
 * Explicit demo mode (`PROCUREMENT_DEMO=1`) may emit a stable synthetic notice for isolated demos.
 * Tests inject MockProcurementSource — never call a real vendor API from CI.
 */

export type ProcurementNoticeDraft = {
  number: string;
  title: string;
  customer: string;
  region: string;
  nmck: number;
  deadline: string;
  source: string;
  attachmentName?: string;
  tags?: string[];
};

export type ProcurementFetchResult = {
  ok: boolean;
  notices: ProcurementNoticeDraft[];
  detail: string;
  /** true when this adapter is a local stub/mock/demo, not a live vendor */
  stub: boolean;
  /** honest readiness: live only when a real source is configured */
  status: "ok" | "not_configured" | "error" | "demo";
};

export interface ProcurementSource {
  readonly id: string;
  fetchNotices(orgId: string): Promise<ProcurementFetchResult>;
}

/**
 * Default production adapter: never invents procurements.
 * Sync stays safe — empty feed + not_configured until a real vendor is wired.
 */
export class StubProcurementSource implements ProcurementSource {
  readonly id = "stub-not-configured";

  async fetchNotices(orgId: string): Promise<ProcurementFetchResult> {
    return {
      ok: true,
      stub: true,
      status: "not_configured",
      detail: `Источник закупок не подключён (org=${orgId}). Реальный API площадки не согласован — лента не пополняется автоматически.`,
      notices: [],
    };
  }
}

/**
 * Explicit demo only (`PROCUREMENT_DEMO=1`). Stable number so dedup collapses repeats.
 * Must never be the production default.
 */
export class DemoProcurementSource implements ProcurementSource {
  readonly id = "demo-synthetic";

  async fetchNotices(orgId: string): Promise<ProcurementFetchResult> {
    return {
      ok: true,
      stub: true,
      status: "demo",
      detail: `Демо-режим PROCUREMENT_DEMO для ${orgId}: синтетическая заявка (не вендор).`,
      notices: [
        {
          number: "DEMO-STABLE-001",
          title: "Демо: ремонт дорожного покрытия (синтетика)",
          customer: "ГБУ «Автодор» (демо)",
          region: "Москва",
          nmck: 27_600_000,
          deadline: new Date(Date.now() + 14 * 86_400_000).toISOString(),
          source: "Демо-режим (не боевой источник)",
          attachmentName: "izveshchenie-demo.pdf",
          tags: ["демо", "синтетика"],
        },
      ],
    };
  }
}

/**
 * Placeholder for a future real vendor adapter.
 * Without PROCUREMENT_API_URL (+ credentials) stays not_configured — never invents data.
 */
export class ConfiguredProcurementSource implements ProcurementSource {
  readonly id = "configured-vendor";

  async fetchNotices(orgId: string): Promise<ProcurementFetchResult> {
    const url = process.env.PROCUREMENT_API_URL?.trim();
    if (!url) {
      return {
        ok: false,
        stub: true,
        status: "not_configured",
        detail: `PROCUREMENT_API_URL не задан (org=${orgId}).`,
        notices: [],
      };
    }
    // Real HTTP vendor client is intentionally not implemented until kickoff credentials exist.
    return {
      ok: false,
      stub: true,
      status: "not_configured",
      detail: `URL источника задан, но адаптер вендора ещё не согласован/не реализован (org=${orgId}).`,
      notices: [],
    };
  }
}

/** Test-only mock: returns caller-supplied notices, never hits network. */
export class MockProcurementSource implements ProcurementSource {
  readonly id = "mock-test-source";
  constructor(
    private readonly notices: ProcurementNoticeDraft[] = [],
    private readonly detail = "mock ok"
  ) {}

  async fetchNotices(_orgId: string): Promise<ProcurementFetchResult> {
    return {
      ok: true,
      stub: true,
      status: "demo",
      detail: this.detail,
      notices: this.notices.map((n) => ({ ...n })),
    };
  }
}

function resolveDefaultSource(): ProcurementSource {
  const mode = (process.env.PROCUREMENT_SOURCE ?? "").toLowerCase();
  if (mode === "demo" || process.env.PROCUREMENT_DEMO === "1") {
    return new DemoProcurementSource();
  }
  if (mode === "configured" || process.env.PROCUREMENT_API_URL?.trim()) {
    return new ConfiguredProcurementSource();
  }
  return new StubProcurementSource();
}

let activeSource: ProcurementSource = resolveDefaultSource();

export function getProcurementSource(): ProcurementSource {
  return activeSource;
}

export function setProcurementSource(source: ProcurementSource): void {
  activeSource = source;
}

export function resetProcurementSource(): void {
  activeSource = resolveDefaultSource();
}

export function procurementSourceStatus(): {
  id: string;
  stub: boolean;
  demo: boolean;
  configured: boolean;
  status: "ok" | "not_configured" | "demo";
  detail: string;
} {
  const source = getProcurementSource();
  const demo =
    source instanceof DemoProcurementSource ||
    process.env.PROCUREMENT_DEMO === "1" ||
    (process.env.PROCUREMENT_SOURCE ?? "").toLowerCase() === "demo";
  const hasUrl = Boolean(process.env.PROCUREMENT_API_URL?.trim());
  const configured = hasUrl && source instanceof ConfiguredProcurementSource;
  return {
    id: source.id,
    stub: !configured,
    demo,
    configured: false, // never claim live until a real adapter exists
    status: demo ? "demo" : "not_configured",
    detail: configured
      ? "Адаптер вендора ожидает согласования"
      : demo
        ? "Включён явный демо-режим (синтетика)"
        : "Реальный источник закупок не подключён",
  };
}
