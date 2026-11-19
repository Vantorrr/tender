import { NOT_IN_DOCUMENTS } from "@/server/ai-grounding";
import { SUPPLIER_DISCOVERY_SYSTEM } from "@/server/ai-prompts";
import { completeJsonDetailed } from "@/server/openrouter";

export type SupplierSearchCandidate = {
  name: string;
  website: string;
  email?: string;
  materials: string[];
  regionEvidence: string;
  evidence: string;
  sourceUrl: string;
};

export type UrlProbe = (url: string) => Promise<"ok" | "missing" | "down" | "unknown">;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SYSTEM = SUPPLIER_DISCOVERY_SYSTEM;
const unwrapCache = new Map<string, string>();
const probeCache = new Map<string, "ok" | "missing" | "down" | "unknown">();

export function buildSupplierQuery(input: { material: string; region: string; work?: string }): string {
  const material = input.material.trim().slice(0, 180);
  const region = input.region.trim().slice(0, 120);
  return `Найди поставщиков материала «${material}» с подтверждённой поставкой в регион «${region}» или с доставкой туда. Объект: ${input.work?.trim().slice(0, 180) || "строительный проект"}. Для Крайнего Севера ищи подтверждение пути: Дудинка, Енисей, зимник, вахта. У каждого кандидата нужен первоисточник, подтверждение ассортимента и региона. Адрес почты — только если он прямо опубликован.`;
}

function safeUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch { return ""; }
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function supplierDomain(value: string): string | null {
  const canon = canonicalUrl(value);
  if (!canon) return null;
  try {
    return new URL(canon).hostname;
  } catch {
    return null;
  }
}

/** Grounding-api and Google redirect wrappers are not the supplier's site. */
export function isRedirectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host === "vertexaisearch.cloud.google.com"
      || host.endsWith(".vertexaisearch.cloud.google.com")
      || (host === "google.com" && url.pathname === "/url");
  } catch {
    return false;
  }
}

/** A candidate passes only when its domain is one of the unwrapped search pages. */
export function urlFromSearch(candidate: string, sourceUrls: string[]): boolean {
  const domain = supplierDomain(candidate);
  if (!domain || isRedirectUrl(candidate)) return false;
  return sourceUrls.some((source) => !isRedirectUrl(source) && supplierDomain(source) === domain);
}

export async function unwrapRedirect(url: string, options?: {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  cache?: Map<string, string>;
}): Promise<string> {
  const cache = options?.cache ?? unwrapCache;
  const cached = cache.get(url);
  if (cached) return cached;
  if (!isRedirectUrl(url)) {
    cache.set(url, url);
    return url;
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 4000;
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    if (hop > 0 && !isRedirectUrl(current)) break;
    try {
      let response = await fetchImpl(current, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 405 || response.status === 501) {
        response = await fetchImpl(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      }
      const location = response.headers.get("location");
      if (location && response.status >= 300 && response.status < 400) {
        current = new URL(location, current).toString();
        continue;
      }
      break;
    } catch {
      break;
    }
  }
  cache.set(url, current);
  return current;
}

export async function resolveSearchSources(urls: string[], options?: {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  cache?: Map<string, string>;
}): Promise<string[]> {
  const resolved = await Promise.all(urls.map((url) => unwrapRedirect(url, options)));
  return [...new Set(resolved
    .map((url) => canonicalUrl(url) ?? "")
    .filter((url) => url && !isRedirectUrl(url)))];
}

export async function probeSupplierUrl(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 2500): Promise<"ok" | "missing" | "down" | "unknown"> {
  const key = canonicalUrl(url) ?? url;
  const cached = probeCache.get(key);
  if (cached) return cached;
  let status: "ok" | "missing" | "down" | "unknown" = "unknown";
  try {
    let response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (response.status >= 500) {
      response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    }
    if (response.status === 404 || response.status === 410) status = "missing";
    else if (response.status >= 500) status = "down";
    else if (response.status >= 200 && response.status < 400) status = "ok";
  } catch {
    status = "unknown";
  }
  probeCache.set(key, status);
  return status;
}

function confirmsDeliveryPlace(value: string): boolean {
  const text = value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  if (!text || text.includes(NOT_IN_DOCUMENTS)) return false;
  return /норильск|дудинк|таймыр|красноярск/.test(text);
}

function looksLikeHauler(name: string, evidence: string): boolean {
  const text = `${name}. ${evidence}`.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const hauler = /перевозчик|перевозк|грузоперевоз|экспедитор|логист|транспортная компания|транспортной компании/.test(text);
  const seller = /прода|поставля|поставщик|поставк|каталог|прайс|в наличии/.test(text);
  return hauler && !seller;
}

export function filterSupplierCandidates(raw: string, sourceUrls: string[]): SupplierSearchCandidate[] {
  if (!sourceUrls.length) return [];
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { candidates?: unknown[] };
  const seen = new Set<string>();
  return (Array.isArray(parsed.candidates) ? parsed.candidates : []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 180) : "";
    const website = safeUrl(row.website);
    const sourceUrl = safeUrl(row.sourceUrl);
    if (!urlFromSearch(sourceUrl, sourceUrls)) return [];
    const evidence = typeof row.evidence === "string" ? row.evidence.trim().slice(0, 600) : "";
    const regionEvidence = typeof row.regionEvidence === "string" ? row.regionEvidence.trim().slice(0, 240) : "";
    if (!confirmsDeliveryPlace(regionEvidence) || looksLikeHauler(name, evidence)) return [];
    const email = typeof row.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email.trim())
      ? row.email.trim().toLowerCase() : undefined;
    const materials = Array.isArray(row.materials)
      ? row.materials.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 120)).filter(Boolean).slice(0, 5)
      : [];
    const key = email || sourceUrl || name.toLocaleLowerCase("ru-RU");
    if (!name || !sourceUrl || !evidence || !materials.length || seen.has(key)) return [];
    seen.add(key);
    return [{ name, website: website || new URL(sourceUrl).origin, email, materials, regionEvidence, evidence, sourceUrl }];
  }).slice(0, 5);
}

/** A candidate page that answers 404 is replaced by the search page of the same domain. */
export async function applyLiveSupplierLinks(
  candidates: SupplierSearchCandidate[],
  sourceUrls: string[],
  probe: UrlProbe = probeSupplierUrl
): Promise<SupplierSearchCandidate[]> {
  const out: SupplierSearchCandidate[] = [];
  for (const candidate of candidates) {
    const domain = supplierDomain(candidate.sourceUrl);
    const source = sourceUrls.find((url) => supplierDomain(url) === domain && !isRedirectUrl(url));
    const status = await probe(candidate.sourceUrl);
    if (status === "down") continue;
    if (status === "missing") {
      if (!source) continue;
      const samePage = source.replace(/\/$/, "") === candidate.sourceUrl.replace(/\/$/, "");
      const sourceStatus = samePage ? status : await probe(source);
      if (samePage || sourceStatus === "missing" || sourceStatus === "down") continue;
      out.push({ ...candidate, sourceUrl: source, website: candidate.website || new URL(source).origin });
      continue;
    }
    out.push(candidate);
  }
  return out;
}

const REGION_ON_PAGE = /норильск|дудинк|таймыр|красноярский край/iu;
const PAGE_TEXT_LIMIT = 200_000;

function pagePlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function regionExcerpt(raw: string): string | null {
  const limited = raw.slice(0, PAGE_TEXT_LIMIT);
  const rawMatch = limited.match(REGION_ON_PAGE);
  if (rawMatch && rawMatch.index != null) {
    const start = Math.max(0, rawMatch.index - 60);
    const end = Math.min(limited.length, rawMatch.index + rawMatch[0].length + 80);
    const excerpt = limited.slice(start, end).trim().slice(0, 240);
    if (excerpt && !excerpt.includes("<") && limited.includes(excerpt)) return excerpt;
  }
  const plain = pagePlainText(limited);
  const match = plain.match(REGION_ON_PAGE);
  if (!match || match.index == null) return null;
  const start = Math.max(0, match.index - 60);
  const end = Math.min(plain.length, match.index + match[0].length + 80);
  const excerpt = plain.slice(start, end).trim().slice(0, 240);
  return excerpt && plain.includes(excerpt) ? excerpt : null;
}

async function readSupplierPage(url: string, fetchImpl: FetchLike, timeoutMs = 4000): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status >= 500) continue;
      if (response.status < 200 || response.status >= 400) return null;
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > PAGE_TEXT_LIMIT) return null;
      return await response.text();
    } catch {
      return null;
    }
  }
  return null;
}

/** Keep a supplier only when the source page itself names the delivery region, and quote that page. */
export async function groundSupplierRegions(
  candidates: SupplierSearchCandidate[],
  fetchImpl: FetchLike = fetch
): Promise<SupplierSearchCandidate[]> {
  const out: SupplierSearchCandidate[] = [];
  for (const candidate of candidates) {
    const page = await readSupplierPage(candidate.sourceUrl, fetchImpl);
    const excerpt = page ? regionExcerpt(page) : null;
    const plain = page ? pagePlainText(page) : "";
    if (!excerpt || (!page!.includes(excerpt) && !plain.includes(excerpt))) continue;
    out.push({ ...candidate, regionEvidence: excerpt });
  }
  return out;
}

export async function discoverMaterialSuppliers(input: { material: string; region: string; work?: string }): Promise<SupplierSearchCandidate[]> {
  const material = input.material.trim().slice(0, 180);
  const region = input.region.trim().slice(0, 120);
  if (!material || !region) throw new Error("Укажите материал и регион для поиска");
  const query = buildSupplierQuery(input);
  const completion = await completeJsonDetailed(SYSTEM, query, 0, { webSearch: true });
  const resolved = await resolveSearchSources(completion.sourceUrls);
  return groundSupplierRegions(await applyLiveSupplierLinks(filterSupplierCandidates(completion.content, resolved), resolved));
}
