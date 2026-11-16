/**
 * Adapter boundary for external procurement feeds.
 * Nornickel's public local tenders page is read-only and needs no credentials.
 * Closed SRM/ETP sources remain unconfigured until the customer provides access.
 * Explicit demo mode (`PROCUREMENT_DEMO=1`) may emit a stable synthetic notice for isolated demos.
 * Tests inject MockProcurementSource — never call a real vendor API from CI.
 */

export type ProcurementNoticeDraft = {
  number: string;
  externalId?: string;
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
  sourceUrl?: string;
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

/** Filter fields accepted by Kontur external API `/external/v1/search`. */
export type KonturSearchFilters = {
  Text?: string[];
  Exclude?: string[];
  Categories?: number[];
  IncludeInns?: string[];
  ExcludeInns?: string[];
  DateTimeFrom: string;
  DateTimeTo: string;
  ParticipantsInns?: string[];
  ParticipantsState?: 1 | 2 | 3;
  EnableParticipantsFromDocuments?: boolean;
  RegionIds?: string[];
  PurchaseStatuses?: number[];
  Laws?: number[];
  Procedures?: number[];
  ElectronicPlaces?: number[];
  CategoryIds?: number[];
  StrictSearch?: boolean;
  Attachments?: boolean;
  MaxPriceFrom?: number;
  MaxPriceTo?: number;
  MaxPriceNone?: boolean;
  Advance44?: boolean;
  Advance223?: boolean;
  NonAdvance?: boolean;
  Smp?: 0 | 1 | 2;
  AllowForeignCurrency?: boolean;
  PageNumber?: number;
  ApplicationDeadlineFrom?: string;
  ApplicationDeadlineTo?: string;
};

export type KonturSearchItem = {
  id: string;
  number: string;
  title: string;
  customer: string;
  region: string;
  nmck: number | null;
  deadline: string;
  link?: string;
  currency?: string;
  cancelled: boolean;
};

export type KonturSearchResult = {
  ok: boolean;
  status: "ok" | "not_configured" | "error";
  detail: string;
  page: number;
  totalCount: number;
  items: KonturSearchItem[];
};

export type KonturPurchaseDetails = {
  externalId: string;
  number: string;
  title: string;
  customer: string;
  nmck: number | null;
  deadline: string;
  sourceUrl?: string;
  attachments: Array<{ name: string; url: string }>;
};

export type KonturPurchaseDetailsResult = {
  ok: boolean;
  status: "ok" | "not_configured" | "error";
  detail: string;
  purchase?: KonturPurchaseDetails;
};

const KONTUR_FILTER_KEYS = new Set([
  "Text", "Exclude", "Categories", "IncludeInns", "ExcludeInns", "DateTimeFrom", "DateTimeTo",
  "ParticipantsInns", "ParticipantsState", "EnableParticipantsFromDocuments", "RegionIds", "PurchaseStatuses",
  "Laws", "Procedures", "ElectronicPlaces", "CategoryIds", "StrictSearch", "Attachments", "MaxPriceFrom",
  "MaxPriceTo", "MaxPriceNone", "Advance44", "Advance223", "NonAdvance", "Smp", "AllowForeignCurrency",
  "PageNumber", "ApplicationDeadlineFrom", "ApplicationDeadlineTo",
]);

function verifiedHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function validateKonturSearchFilters(input: unknown): KonturSearchFilters {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Переданы некорректные фильтры поиска");
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !KONTUR_FILTER_KEYS.has(key));
  if (unknown.length) throw new Error(`Неизвестный фильтр: ${unknown[0]}`);
  const date = (key: "DateTimeFrom" | "DateTimeTo" | "ApplicationDeadlineFrom" | "ApplicationDeadlineTo") => {
    const value = raw[key];
    if (value == null || value === "") return undefined;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Некорректная дата фильтра ${key}`);
    return new Date(value).toISOString();
  };
  const DateTimeFrom = date("DateTimeFrom");
  const DateTimeTo = date("DateTimeTo");
  if (!DateTimeFrom || !DateTimeTo || Date.parse(DateTimeFrom) > Date.parse(DateTimeTo)) {
    throw new Error("Укажите корректный диапазон дат публикации");
  }
  const stringArray = (key: string) => {
    const value = raw[key];
    if (value == null) return undefined;
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || item.length > 200)) {
      throw new Error(`Некорректное значение фильтра ${key}`);
    }
    const values = value.map((item) => String(item).trim()).filter(Boolean);
    return values.length ? values : undefined;
  };
  const numberArray = (key: string, allowed?: number[]) => {
    const value = raw[key];
    if (value == null) return undefined;
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "number" || !Number.isInteger(item) || (allowed && !allowed.includes(item)))) {
      throw new Error(`Некорректное значение фильтра ${key}`);
    }
    return value as number[];
  };
  const boolean = (key: string) => {
    const value = raw[key];
    if (value == null) return undefined;
    if (typeof value !== "boolean") throw new Error(`Фильтр ${key} должен быть логическим`);
    return value;
  };
  const numeric = (key: string, min: number, max: number) => {
    const value = raw[key];
    if (value == null || value === "") return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Некорректное значение фильтра ${key}`);
    return value;
  };
  const maxPriceFrom = numeric("MaxPriceFrom", 0, Number.MAX_SAFE_INTEGER);
  const maxPriceTo = numeric("MaxPriceTo", 0, Number.MAX_SAFE_INTEGER);
  if (maxPriceFrom != null && maxPriceTo != null && maxPriceFrom > maxPriceTo) {
    throw new Error("Цена «от» не может быть больше цены «до»");
  }
  const enumNumber = (key: string, allowed: number[]) => {
    const value = raw[key];
    if (value == null) return undefined;
    if (typeof value !== "number" || !allowed.includes(value)) throw new Error(`Некорректное значение фильтра ${key}`);
    return value;
  };
  return {
    DateTimeFrom,
    DateTimeTo,
    ...(stringArray("Text") ? { Text: stringArray("Text") } : {}),
    ...(stringArray("Exclude") ? { Exclude: stringArray("Exclude") } : {}),
    ...(numberArray("Categories") ? { Categories: numberArray("Categories") } : {}),
    ...(stringArray("IncludeInns") ? { IncludeInns: stringArray("IncludeInns") } : {}),
    ...(stringArray("ExcludeInns") ? { ExcludeInns: stringArray("ExcludeInns") } : {}),
    ...(stringArray("ParticipantsInns") ? { ParticipantsInns: stringArray("ParticipantsInns") } : {}),
    ...(enumNumber("ParticipantsState", [1, 2, 3]) != null ? { ParticipantsState: enumNumber("ParticipantsState", [1, 2, 3]) as 1 | 2 | 3 } : {}),
    ...(boolean("EnableParticipantsFromDocuments") != null ? { EnableParticipantsFromDocuments: boolean("EnableParticipantsFromDocuments") } : {}),
    ...(stringArray("RegionIds") ? { RegionIds: stringArray("RegionIds") } : {}),
    ...(numberArray("PurchaseStatuses", [1, 2, 3, 4, 5, 6]) ? { PurchaseStatuses: numberArray("PurchaseStatuses", [1, 2, 3, 4, 5, 6]) } : {}),
    ...(numberArray("Laws", [1, 2, 3, 5, 8, 9]) ? { Laws: numberArray("Laws", [1, 2, 3, 5, 8, 9]) } : {}),
    ...(numberArray("Procedures", [0, 1, 2, 3, 5, 99]) ? { Procedures: numberArray("Procedures", [0, 1, 2, 3, 5, 99]) } : {}),
    ...(numberArray("ElectronicPlaces") ? { ElectronicPlaces: numberArray("ElectronicPlaces") } : {}),
    ...(numberArray("CategoryIds") ? { CategoryIds: numberArray("CategoryIds") } : {}),
    ...(boolean("StrictSearch") != null ? { StrictSearch: boolean("StrictSearch") } : {}),
    ...(boolean("Attachments") != null ? { Attachments: boolean("Attachments") } : {}),
    ...(numeric("MaxPriceFrom", 0, Number.MAX_SAFE_INTEGER) != null ? { MaxPriceFrom: numeric("MaxPriceFrom", 0, Number.MAX_SAFE_INTEGER) } : {}),
    ...(numeric("MaxPriceTo", 0, Number.MAX_SAFE_INTEGER) != null ? { MaxPriceTo: numeric("MaxPriceTo", 0, Number.MAX_SAFE_INTEGER) } : {}),
    ...(boolean("MaxPriceNone") != null ? { MaxPriceNone: boolean("MaxPriceNone") } : {}),
    ...(boolean("Advance44") != null ? { Advance44: boolean("Advance44") } : {}),
    ...(boolean("Advance223") != null ? { Advance223: boolean("Advance223") } : {}),
    ...(boolean("NonAdvance") != null ? { NonAdvance: boolean("NonAdvance") } : {}),
    ...(enumNumber("Smp", [0, 1, 2]) != null ? { Smp: enumNumber("Smp", [0, 1, 2]) as 0 | 1 | 2 } : {}),
    ...(boolean("AllowForeignCurrency") != null ? { AllowForeignCurrency: boolean("AllowForeignCurrency") } : {}),
    ...(numeric("PageNumber", 0, 199) != null ? { PageNumber: numeric("PageNumber", 0, 199) } : {}),
    ...(date("ApplicationDeadlineFrom") ? { ApplicationDeadlineFrom: date("ApplicationDeadlineFrom") } : {}),
    ...(date("ApplicationDeadlineTo") ? { ApplicationDeadlineTo: date("ApplicationDeadlineTo") } : {}),
  };
}

export interface ProcurementSource {
  readonly id: string;
  fetchNotices(orgId: string, filters?: KonturSearchFilters): Promise<ProcurementFetchResult>;
}

/** Kontur external API. The key is server-only and never included in diagnostics. */
export class KonturProcurementSource implements ProcurementSource {
  readonly id = "kontur-external-api";
  lastResult: ProcurementFetchResult | null = null;

  async fetchNotices(_orgId?: string, filters?: KonturSearchFilters): Promise<ProcurementFetchResult> {
    const result = await this.fetchPages(filters);
    this.lastResult = result;
    return result;
  }

  /** One user-requested search page; each page is one billable search request. */
  async search(filters: KonturSearchFilters): Promise<KonturSearchResult> {
    const key = process.env.KONTUR_API_KEY?.trim();
    const page = filters.PageNumber ?? 0;
    if (!key) {
      return { ok: false, status: "not_configured", detail: "Не задан серверный ключ API Контура.", page, totalCount: 0, items: [] };
    }
    try {
      const response = await fetch("https://api-zakupki.kontur.ru/external/v1/search", {
        method: "POST",
        headers: { "X-Kontur-Apikey": key, "Content-Type": "application/json-patch+json" },
        body: JSON.stringify(filters),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { Items?: Array<Record<string, unknown>>; TotalCount?: number };
      if (!Array.isArray(payload.Items)) throw new Error("неожиданный формат поиска");
      if (payload.Items.some((item) => /░/.test(JSON.stringify(item)))) {
        return {
          ok: false, status: "error", page,
          totalCount: typeof payload.TotalCount === "number" ? payload.TotalCount : 0,
          items: [],
          detail: "Контур вернул замаскированные поля. По документации так работает тестовый API-ключ; для импорта реальных закупок нужен боевой ключ с правами по тарифу.",
        };
      }
      return {
        ok: true, status: "ok", page,
        totalCount: typeof payload.TotalCount === "number" ? payload.TotalCount : payload.Items.length,
        items: payload.Items.flatMap((item): KonturSearchItem[] => {
          if (typeof item.Id !== "string") return [];
          const customers = Array.isArray(item.Customers) ? item.Customers as Array<{ FullName?: string }> : [];
          const places = Array.isArray(item.DeliveryPlaces) ? item.DeliveryPlaces.filter((place): place is string => typeof place === "string") : [];
          return [{
            id: item.Id,
            number: typeof item.NotificationNumber === "string" && item.NotificationNumber ? item.NotificationNumber : item.Id,
            title: typeof item.OrderName === "string" ? item.OrderName : "Название закупки не указано",
            customer: customers.map((customer) => customer.FullName).filter(Boolean).join("; ") || "Заказчик не указан",
            region: places.join("; ") || "Регион не указан",
            nmck: item.Currency === "RUB" && typeof item.MaxPrice === "number" ? item.MaxPrice : null,
            deadline: typeof item.ApplicationDeadline === "string" ? item.ApplicationDeadline : "",
            link: verifiedHttpsUrl(item.Link),
            currency: typeof item.Currency === "string" ? item.Currency : undefined,
            cancelled: item.IsCancelled === true,
          }];
        }),
        detail: `Получено ${payload.Items.length} закупок на странице ${page + 1} из ${typeof payload.TotalCount === "number" ? payload.TotalCount : "неизвестного количества"}.`,
      };
    } catch (error) {
      const http = error instanceof Error ? /^HTTP (\d+)$/.exec(error.message)?.[1] : undefined;
      const detail = http === "401"
        ? "Контур отклонил API-ключ (401). Проверьте срок действия ключа."
        : http === "403"
          ? "API-ключ принят, но тариф не разрешает этот метод (403). Проверьте права search в Кабинете Интегратора."
          : http === "429"
            ? "Достигнут лимит запросов Контура (429). Повторите после обновления лимита."
            : http ? `HTTP ${http}` : "сетевая ошибка или неверный формат ответа";
      return { ok: false, status: "error", detail: `Контур API: ${detail}.`, page, totalCount: 0, items: [] };
    }
  }

  /** Fetch one selected purchase only; the API counts a base request per purchase. */
  async purchaseDetails(id: string): Promise<KonturPurchaseDetailsResult> {
    const key = process.env.KONTUR_API_KEY?.trim();
    if (!key) return { ok: false, status: "not_configured", detail: "Не задан серверный ключ API Контура." };
    if (!id.trim() || id.length > 200) return { ok: false, status: "error", detail: "Некорректный ID закупки Контура." };
    try {
      const response = await fetch(`https://api-zakupki.kontur.ru/external/v1/purchases/${encodeURIComponent(id)}`, {
        headers: { "X-Kontur-Apikey": key },
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) {
        const status = response.status;
        const detail = status === 401
          ? "Контур отклонил API-ключ (401). Проверьте его срок действия."
          : status === 403
            ? "API-ключ не имеет доступа к подробной карточке закупки. Для этого метода нужна группа purchase по тарифу."
            : status === 429
              ? "Достигнут лимит запросов Контура (429). Повторите после обновления лимита."
              : `Контур API вернул HTTP ${status}.`;
        return { ok: false, status: "error", detail };
      }
      const raw = await response.json() as Record<string, unknown>;
      if (/░/.test(JSON.stringify(raw))) {
        return { ok: false, status: "error", detail: "Контур вернул замаскированные подробности. По документации это тестовый API-ключ; нужен боевой ключ с группой purchase." };
      }
      const organizer = raw.Organizer && typeof raw.Organizer === "object" ? raw.Organizer as Record<string, unknown> : {};
      const sum = raw.InitialSum && typeof raw.InitialSum === "object" ? raw.InitialSum as Record<string, unknown> : {};
      const docs = Array.isArray(raw.Docs) ? raw.Docs as Array<Record<string, unknown>> : [];
      const attachments = docs.flatMap((doc) => {
        const url = verifiedHttpsUrl(doc.Url);
        const name = typeof doc.FileName === "string" ? doc.FileName.trim() : "";
        return url && name ? [{ name, url }] : [];
      });
      return {
        ok: true,
        status: "ok",
        detail: `Получены подробности закупки и ссылок на документы: ${attachments.length}.`,
        purchase: {
          externalId: typeof raw.Id === "string" ? raw.Id : id,
          number: typeof raw.NotificationNumber === "string" && raw.NotificationNumber ? raw.NotificationNumber : id,
          title: typeof raw.Title === "string" ? raw.Title : "Название закупки не указано",
          customer: typeof organizer.FullName === "string" ? organizer.FullName : "Заказчик не указан",
          nmck: sum.Currency === "RUB" && typeof sum.Price === "number" ? sum.Price : null,
          deadline: typeof raw.ApplicationDeadline === "string" ? raw.ApplicationDeadline : "",
          sourceUrl: verifiedHttpsUrl(raw.Link) ?? verifiedHttpsUrl(raw.EisLink) ?? verifiedHttpsUrl(raw.EtpLink),
          attachments,
        },
      };
    } catch (error) {
      const status = error instanceof Error ? /^HTTP (\d+)$/.exec(error.message)?.[1] : undefined;
      return { ok: false, status: "error", detail: status ? `Контур API вернул HTTP ${status}.` : "Контур API: сетевая ошибка или неверный формат ответа." };
    }
  }

  private async fetchPages(filters?: KonturSearchFilters): Promise<ProcurementFetchResult> {
    const key = process.env.KONTUR_API_KEY?.trim();
    if (!key) return { ok: false, stub: false, status: "not_configured", notices: [], detail: "Не задан серверный ключ API Контура." };
    try {
      const now = new Date();
      const items: KonturSearchItem[] = [];
      const seen = new Set<string>();
      let total = 0;
      let completed = false;
      const requestedPages = Number(process.env.KONTUR_MAX_PAGES ?? 5);
      const maxPages = Number.isFinite(requestedPages) ? Math.max(1, Math.min(20, Math.floor(requestedPages))) : 5;
      const lookback = Number(process.env.KONTUR_LOOKBACK_DAYS ?? 1);
      const defaultFilters: KonturSearchFilters = {
        DateTimeFrom: new Date(now.getTime() - Math.max(1, Math.min(365, Number.isFinite(lookback) ? lookback : 1)) * 86400000).toISOString(),
        DateTimeTo: now.toISOString(),
      };
      const baseFilters = filters ?? defaultFilters;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await this.search({ ...baseFilters, PageNumber: (baseFilters.PageNumber ?? 0) + page });
        if (!result.ok) return { ok: false, stub: false, status: result.status, notices: [], detail: result.detail };
        const searchItems = result.items;
        const totalCount = result.totalCount;
        // Masked test responses are rejected by search() before persistence.
        total = totalCount;
        if (!searchItems.length) { completed = true; break; }
        let added = 0;
        for (const item of searchItems) {
          if (!item.id || item.cancelled || seen.has(item.id)) continue;
          seen.add(item.id);
          items.push(item);
          added += 1;
        }
        if (items.length >= total && total > 0) { completed = true; break; }
        if (!added) throw new Error("повтор страницы источника");
      }
      const notices: ProcurementNoticeDraft[] = items.map((item) => ({
        number: item.number,
        externalId: item.id,
        title: item.title,
        customer: item.customer,
        region: item.region,
        nmck: item.nmck,
        deadline: item.deadline,
        source: "Контур.Закупки API",
        ...(item.link ? { sourceUrl: item.link } : {}),
        tags: ["Контур API"],
      }));
      return { ok: true, stub: false, status: "ok", notices, detail: `Контур API: получено ${notices.length} закупок из ${total || "неизвестного количества"}. ${completed ? "Все страницы получены." : `Выборка неполная: достигнут лимит ${maxPages} страниц за синхронизацию.`}` };
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
  status: "ok" | "not_configured" | "demo" | "error";
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
    status: demo ? "demo" : liveKontur && source instanceof KonturProcurementSource ? source.lastResult?.status ?? "not_configured" : livePublic ? "ok" : "not_configured",
    detail: liveKontur && source instanceof KonturProcurementSource ? source.lastResult?.detail ?? "Ключ Контура настроен; первая синхронизация ещё не выполнена" : livePublic
      ? "Подключена открытая публичная лента закупок «Норникеля»"
      : configured
      ? "Адаптер вендора ожидает согласования"
      : demo
        ? "Включён явный демо-режим (синтетика)"
        : "Реальный источник закупок не подключён",
  };
}
