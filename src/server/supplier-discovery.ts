import { lookup } from "node:dns/promises";
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

const DIRECTORY_HOST = /(?:^|\.)(?:2gis\.(?:ru|com)|zoon\.ru|yell\.ru|flamp\.ru|orgpage\.ru|rusprofile\.ru|list-org\.com|spark-interfax\.ru|checko\.ru|pulscen\.ru|tiu\.ru|blizko\.ru|jsprav\.ru|cataloxy\.ru)$/i;

/** Maps and company catalogs are not the supplier's own site. */
export function isDirectoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (DIRECTORY_HOST.test(host) || host.startsWith("maps.")) return true;
    const path = url.pathname.toLowerCase();
    const yandex = host === "yandex.ru" || host === "yandex.com" || host.endsWith(".yandex.ru") || host.endsWith(".yandex.com");
    if (yandex && path.includes("/maps")) return true;
    const google = host === "google.com" || host === "google.ru" || host === "maps.google.com";
    return google && path.includes("/maps");
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
    const websiteHost = website ? supplierDomain(website) : null;
    const sourceHost = supplierDomain(sourceUrl);
    if (isDirectoryUrl(sourceUrl) || (website && isDirectoryUrl(website)) || (websiteHost && sourceHost && websiteHost !== sourceHost)) return [];
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
    // A page that stays on 5xx after one retry is not a source.
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

function foldSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function pageSegments(raw: string): string[] {
  const parts = raw.split(/<[^>]*>/g).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [raw];
}

/** Quote the page's own characters. Whitespace is folded only to decide that the region is there. */
function regionExcerpt(raw: string): string | null {
  const limited = raw.slice(0, PAGE_TEXT_LIMIT);
  for (const segment of pageSegments(limited)) {
    const match = segment.match(REGION_ON_PAGE);
    if (!match || match.index == null) continue;
    const start = Math.max(0, match.index - 60);
    const end = Math.min(segment.length, match.index + match[0].length + 80);
    const excerpt = segment.slice(start, end).trim().slice(0, 240);
    if (excerpt && limited.includes(excerpt) && foldSpace(limited).includes(foldSpace(excerpt))) return excerpt;
  }
  return null;
}

function isPrivateIpv4(host: string): boolean {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 100 && b >= 64 && b <= 127;
}

function ipv4FromHextets(high: string, low: string): string | null {
  const left = Number.parseInt(high, 16);
  const right = Number.parseInt(low, 16);
  if (left > 0xffff || right > 0xffff) return null;
  return `${left >> 8}.${left & 255}.${right >> 8}.${right & 255}`;
}

function embeddedIpv4(host: string): string | null {
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    ?? host.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) return ipv4FromHextets(mapped[1], mapped[2]);
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return dotted ? dotted[1] : null;
}

function hostLabel(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/g, "");
}

function addressIsPrivate(address: string): boolean {
  const host = hostLabel(address);
  if (!host || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (isPrivateIpv4(host)) return true;
  const embedded = embeddedIpv4(host);
  if (embedded) return isPrivateIpv4(embedded);
  return host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"));
}

function isPublicSupplierUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = hostLabel(url.hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (addressIsPrivate(host)) return false;
  if (host.startsWith("::")) return false;
  return true;
}

type AddressLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string }>>;

/** A name that looks public still has to resolve to a public address. */
export async function hostResolvesToPublicAddress(hostname: string, lookupImpl: AddressLookup = lookup): Promise<boolean> {
  const host = hostLabel(hostname);
  if (!host || !isPublicSupplierUrl(`http://${host.includes(":") ? `[${host}]` : host}/`)) return false;
  if (isPrivateIpv4(host) || host.includes(":")) return !addressIsPrivate(host);
  try {
    const records = await lookupImpl(host, { all: true, verbatim: true });
    return records.length > 0 && records.every((record) => !addressIsPrivate(record.address));
  } catch {
    return true;
  }
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, limit);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = limit - total;
    chunks.push(value.byteLength > room ? value.slice(0, room) : value);
    total += Math.min(value.byteLength, room);
    if (value.byteLength > room) {
      await reader.cancel();
      break;
    }
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readSupplierPage(url: string, fetchImpl: FetchLike, timeoutMs = 4000, hops = 0): Promise<string | null> {
  if (hops > 2 || !isPublicSupplierUrl(url)) return null;
  if (fetchImpl === fetch && !(await hostResolvesToPublicAddress(new URL(url).hostname))) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;
        return readSupplierPage(new URL(location, url).toString(), fetchImpl, timeoutMs, hops + 1);
      }
      if (response.status >= 500) continue;
      if (response.status < 200 || response.status >= 400) return null;
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > PAGE_TEXT_LIMIT) return null;
      return readCapped(response, PAGE_TEXT_LIMIT);
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
    if (!excerpt || (!page!.includes(excerpt) && !foldSpace(page!).includes(foldSpace(excerpt)) && !foldSpace(plain).includes(foldSpace(excerpt)))) continue;
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
