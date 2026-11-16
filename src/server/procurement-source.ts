/**
 * Adapter boundary for external procurement feeds.
 * Nornickel's public local tenders page is read-only and needs no credentials.
 * Closed SRM/ETP sources remain unconfigured until the customer provides access.
 * Explicit demo mode (`PROCUREMENT_DEMO=1`) may emit a stable synthetic notice for isolated demos.
 * Tests inject MockProcurementSource — never call a real vendor API from CI.
 */

export type ProcurementNoticeDraft = {
  number: string;
  title: string;
  customer: string;
  region: string;
  nmck: number | null;
  deadline: string;
  source: string;
  attachmentName?: string;
  attachmentType?: string;
  attachmentSize?: string;
  attachmentUrl?: string;
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

/** Kontur external API. The key is server-only and never included in diagnostics. */
export class KonturProcurementSource implements ProcurementSource {
  readonly id = "kontur-external-api";

  async fetchNotices(): Promise<ProcurementFetchResult> {
    const key = process.env.KONTUR_API_KEY?.trim();
    if (!key) return { ok: false, stub: false, status: "not_configured", notices: [], detail: "Не задан серверный ключ API Контура." };
    try {
      const now = new Date();
      const response = await fetch("https://api-zakupki.kontur.ru/external/v1/search", {
        method: "POST",
        headers: { "X-Kontur-Apikey": key, "Content-Type": "application/json" },
        body: JSON.stringify({ DateTimeFrom: new Date(now.getTime() - 86400000).toISOString(), DateTimeTo: now.toISOString(), PageNumber: 0 }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { Items?: Array<Record<string, unknown>>; TotalCount?: number };
      if (!Array.isArray(payload.Items)) throw new Error("неожиданный формат поиска");
      // Restricted subscriptions return apparently valid records with redacted
      // identifiers, customers and URLs. Do not persist them as real evidence.
      if (payload.Items.some((item) => /░/.test(JSON.stringify(item)))) {
        return { ok: false, stub: false, status: "error", notices: [], detail: "Ключ Контура принят, но API маскирует реквизиты и ссылки на документы символами ░. Проверьте доступ к полным данным по API-лицензии; скрытые записи не импортированы." };
      }
      const notices = payload.Items.flatMap((item): ProcurementNoticeDraft[] => {
        if (typeof item.Id !== "string" || typeof item.OrderName !== "string" || item.IsCancelled === true) return [];
        const customers = Array.isArray(item.Customers) ? item.Customers as Array<{ FullName?: string }> : [];
        const places = Array.isArray(item.DeliveryPlaces) ? item.DeliveryPlaces.filter((place): place is string => typeof place === "string") : [];
        return [{ number: item.Id, title: item.OrderName, customer: customers.map((customer) => customer.FullName).filter(Boolean).join("; ") || "Заказчик не указан", region: places.join("; ") || "Регион не указан", nmck: item.Currency === "RUB" && typeof item.MaxPrice === "number" ? item.MaxPrice : null, deadline: typeof item.ApplicationDeadline === "string" ? item.ApplicationDeadline : "", source: "Контур.Закупки API", tags: ["Контур API"] }];
      });
      return { ok: true, stub: false, status: "ok", notices, detail: `Контур API: получено ${notices.length} закупок первой страницы из ${payload.TotalCount ?? "неизвестного количества"}.` };
    } catch (error) {
      const detail = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : "сетевая ошибка или неверный формат ответа";
      return { ok: false, stub: false, status: "error", notices: [], detail: `Контур API: ${detail}.` };
    }
  }
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

const NORILSK_TENDERS_URL = "https://nornickel.ru/suppliers/tenders/local/";

function componentJson(html: string, componentName: string): unknown {
  const marker = new RegExp(`\\"${componentName}\\"\\s*:\\s*`).exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  return null;
}

function fieldValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "value" in value) {
    const nested = (value as { value?: unknown }).value;
    return typeof nested === "string" ? nested.trim() : "";
  }
  return "";
}

/** Public, read-only Norilsk Nickel local procurement feed. */
export class NornickelLocalProcurementSource implements ProcurementSource {
  readonly id = "nornickel-local-public";

  async fetchNotices(): Promise<ProcurementFetchResult> {
    try {
      const fetchPage = async (page: number) => {
        const url = new URL(NORILSK_TENDERS_URL);
        if (page > 1) url.searchParams.set("page", String(page));
        const response = await fetch(url, {
          headers: { "user-agent": "TMA361 procurement feed/1.0" },
          signal: AbortSignal.timeout(12_000),
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`страница ${page}: HTTP ${response.status}`);
        return componentJson(await response.text(), "local-tenders") as
          | { items?: unknown[]; nav?: { total?: number; current?: number } }
          | null;
      };
      const component = await fetchPage(1);
      if (!component || !Array.isArray(component.items)) {
        throw new Error("Не удалось распознать формат публичной страницы закупок");
      }
      const pageCount = Math.max(1, Math.min(50, Number(component.nav?.total) || 1));
      const allItems = [...component.items];
      const pageErrors: string[] = [];
      for (let firstPage = 2; firstPage <= pageCount; firstPage += 4) {
        const pages = Array.from(
          { length: Math.min(4, pageCount - firstPage + 1) },
          (_, index) => firstPage + index
        );
        const results = await Promise.all(
          pages.map(async (page) => {
            try {
              return { page, result: await fetchPage(page), error: "" };
            } catch (error) {
              return {
                page,
                result: null,
                error: error instanceof Error ? error.message : `страница ${page}: ошибка источника`,
              };
            }
          })
        );
        for (const result of results) {
          if (result.result && Array.isArray(result.result.items)) {
            allItems.push(...result.result.items);
          } else {
            pageErrors.push(result.error || `страница ${result.page}: неверный формат`);
          }
        }
      }
      const notices = allItems.flatMap((raw): ProcurementNoticeDraft[] => {
        if (!raw || typeof raw !== "object") return [];
        const item = raw as Record<string, unknown>;
        const name = fieldValue(item.name);
        // Depending on the procurement method, the public page labels an item
        // either "174734 Title" or "20061113/2: 174734 Title". Keep the
        // stable procedure number in number and retain a second lot id in title.
        const match = /^(\d[\d/.-]*):?\s+([\s\S]+)$/.exec(name);
        const number = match?.[1]?.replace(/[:.]$/, "").trim() ?? "";
        const titleSource = match?.[2]?.trim() ?? name;
        const nestedNumber = /^(\d{4,}):?\s+([\s\S]+)$/.exec(titleSource);
        const title = nestedNumber
          ? `${nestedNumber[1]} — ${nestedNumber[2].trim()}`
          : titleSource;
        const activeTo = Number(item.activeTo);
        const deadline = Number.isFinite(activeTo) && activeTo > 0
          ? new Date(activeTo * 1000).toISOString()
          : "";
        if (!number || !title || !deadline || new Date(deadline).getTime() < Date.now()) return [];
        const customer = fieldValue(item.customer) || "Заказчик не указан";
        const documentation = item.documentation && typeof item.documentation === "object"
          ? item.documentation as Record<string, unknown>
          : {};
        const path = typeof documentation.link === "string" ? documentation.link : "";
        const fileName = typeof documentation.origName === "string" ? documentation.origName : "";
        let attachmentUrl: string | undefined;
        try {
          const candidate = new URL(path, "https://nornickel.ru");
          if (
            (candidate.hostname === "nornickel.ru" && candidate.pathname.startsWith("/upload/")) ||
            (candidate.hostname === "nornik-upload.storage.yandexcloud.net" && candidate.pathname.startsWith("/iblock/"))
          ) attachmentUrl = candidate.toString();
        } catch {
          // Invalid or untrusted links are omitted from the card.
        }
        return [{
          number,
          title,
          customer,
          region: /\bНПР\b|Норильск/i.test(`${name} ${fieldValue(item.address)}`)
            ? "Норильский промышленный район (проверить по ТЗ)"
            : "Не указан в карточке — проверить по ТЗ",
          nmck: null,
          deadline,
          source: "Публичная страница закупок «Норникеля»",
          attachmentName: fileName || undefined,
          attachmentType: typeof documentation.type === "string" ? documentation.type : undefined,
          attachmentSize: typeof documentation.size === "string" ? documentation.size : undefined,
          attachmentUrl,
          tags: ["Норникель", "публичная закупка"],
        }];
      });
      return {
        ok: true,
        stub: false,
        status: "ok",
        detail: `Публичная лента «Норникеля»: обработано ${allItems.length} карточек на ${pageCount} страницах, найдено ${notices.length} актуальных. ${pageErrors.length ? `Не получены страницы: ${pageErrors.join("; ")}. ` : ""}НМЦК не опубликована в ленте и не подменяется оценкой.`,
        notices,
      };
    } catch (error) {
      return {
        ok: false,
        stub: false,
        status: "error",
        detail: `Не удалось получить публичную ленту «Норникеля»: ${error instanceof Error ? error.message : "ошибка источника"}`,
        notices: [],
      };
    }
  }
}

/** Test-only mock: returns caller-supplied notices, never hits network. */
export class MockProcurementSource implements ProcurementSource {
  readonly id = "mock-test-source";
  constructor(
    private readonly notices: ProcurementNoticeDraft[] = [],
    private readonly detail = "mock ok"
  ) {}

  async fetchNotices(): Promise<ProcurementFetchResult> {
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
  if (mode === "kontur") return new KonturProcurementSource();
  if (mode === "nornickel" || mode === "nornickel-local") {
    return new NornickelLocalProcurementSource();
  }
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
  const livePublic = source instanceof NornickelLocalProcurementSource;
  const liveKontur = source instanceof KonturProcurementSource && Boolean(process.env.KONTUR_API_KEY?.trim());
  return {
    id: source.id,
    stub: !configured && !livePublic && !liveKontur,
    demo,
    configured: livePublic || liveKontur,
    status: demo ? "demo" : livePublic || liveKontur ? "ok" : "not_configured",
    detail: liveKontur ? "Настроен API Контура; доступность полных данных проверяется при синхронизации" : livePublic
      ? "Подключена открытая публичная лента закупок «Норникеля»"
      : configured
      ? "Адаптер вендора ожидает согласования"
      : demo
        ? "Включён явный демо-режим (синтетика)"
        : "Реальный источник закупок не подключён",
  };
}
