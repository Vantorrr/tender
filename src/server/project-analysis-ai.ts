import type { Citation, DocumentItem, ProjectAnalytics, Procurement } from "@/lib/types";
import { regionFromCitations, submissionDeadlineFromCitations } from "@/lib/citation-display";
import { aiAnalysisFailureStatus } from "@/lib/ai-status";
import { ANALYSIS_IMPORTANCE_LABELS, ANALYSIS_TOPIC_LABELS } from "@/lib/ai-topics";
import { NOT_IN_DOCUMENTS, numbersAreGrounded } from "@/server/ai-grounding";
import { rollupWorkSections, alignVolumeToSections, isOverheadPosition, stripWorkTypesOutsideSources } from "@/server/estimate-rollup";
import {
  PROJECT_ANALYSIS_CITATION_CHARS,
  PROJECT_ANALYSIS_CITATION_LIMIT,
  PROJECT_ANALYSIS_CITATIONS_PER_DOCUMENT,
  PROJECT_ANALYSIS_HIGHLIGHTS,
  PROJECT_ANALYSIS_NOTE_CHARS,
  PROJECT_ANALYSIS_POSITIONS,
  PROJECT_ANALYSIS_SYSTEM,
  formatSourceLocation,
} from "@/server/ai-prompts";
import { completeJson } from "@/server/openrouter";

const SYSTEM = PROJECT_ANALYSIS_SYSTEM;
const TOPIC_LABELS = ANALYSIS_TOPIC_LABELS;
const IMPORTANCE_LABELS = ANALYSIS_IMPORTANCE_LABELS;

type ModelEvidence = {
  topic: keyof typeof TOPIC_LABELS;
  importance: keyof typeof IMPORTANCE_LABELS;
  text: string;
  quote: string;
  citationIds: string[];
  costImpact?: string;
  scheduleImpact?: string;
};

type ModelResult = {
  recommendation: ProjectAnalytics["recommendation"];
  missingInputs: string[];
  customerQuestions: string[];
  evidence: ModelEvidence[];
};

function describesConflict(item: string): boolean {
  return /противореч|конфликт/iu.test(item);
}

const REGION_SUBJECTS = [
  { re: /красноярск/iu, label: "Красноярский край" },
  { re: /янао|ямало-ненецк/iu, label: "ЯНАО" },
  { re: /хмао|ханты-мансийск/iu, label: "ХМАО" },
  { re: /мурманск/iu, label: "Мурманская область" },
];

/** Two federal subjects in one sentence are a conflict, not one place name. */
export function splitMergedRegions(text: string): { text: string; conflict: string | null } {
  const found = REGION_SUBJECTS.filter((subject) => subject.re.test(text));
  if (found.length < 2) return { text, conflict: null };
  let next = text;
  for (const subject of found.slice(1)) {
    next = next.replace(new RegExp(`\\s*\\([^)]*(?:${subject.re.source})[^)]*\\)`, "giu"), "");
    if (REGION_SUBJECTS.filter((item) => item.re.test(next)).length >= 2) next = next.replace(subject.re, "");
  }
  return {
    text: next.replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").replace(/\(\s*\)/g, "").trim(),
    conflict: `В документах названы разные регионы: ${found.map((subject) => subject.label).join(" и ")}. Это не одна территория.`,
  };
}

type AnalysisEconomics = {
  cost: number | null;
  priceWithVat: number | null;
  priceExVat?: number | null;
  profit?: number | null;
  profitabilityPercent?: number | null;
  revenueMarginPercent?: number | null;
  incomplete: boolean;
  missingRates: number;
  missingRateNames?: string[];
  incompleteReasons?: string[];
};

export type AnalysisCompanyContext = {
  profileRows: Array<{ region?: string; okpd?: string; services?: string; maxNmck?: number }>;
  laborRates: Array<{ work: string; rate?: number; unit?: string }>;
  fleet: Array<{ category?: string; name: string; quantity?: number; unit?: string }>;
  serviceCatalogPresent: boolean;
  resourceAvailabilityTracked: boolean;
  riskRemarks: Array<{ severity: string; status: string; text: string; sourceExcerpt?: string }>;
};

function formatDeadlineForBrief(value: string): string {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}/u.test(value) || Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(date);
}

/** Cover important subjects across the document instead of only its first rows. */
export function selectAnalysisCitations(citations: Citation[], limit = 40): Citation[] {
  const selected = new Set<Citation>();
  const topics = [/объ[её]м|количеств|перечень работ|ведомость/iu, /срок|календар|начал|окончан/iu,
    /оплат|аванс|отсроч/iu, /штраф|пен[яи]|неустойк|ответственност/iu,
    /север|вахт|доставк|проживан|транспорт/iu, /требован|допуск|лицензи|обеспечен/iu];
  for (const topic of topics) {
    const matches = citations.filter((item) => topic.test(item.text));
    const spread = Array.from({ length: Math.min(4, matches.length) }, (_, index) =>
      matches[Math.floor(index * (matches.length - 1) / Math.max(1, Math.min(4, matches.length) - 1))]
    );
    for (const citation of spread) {
      if (selected.size < limit) selected.add(citation);
    }
  }
  for (const citation of citations) {
    if (selected.size >= limit) break;
    selected.add(citation);
  }
  return [...selected];
}

export function economicMissingInputs(economics?: AnalysisEconomics): string[] {
  if (!economics) return ["Создать черновой ресурсный расчёт по документам проекта."];
  const missing: string[] = [];
  if (economics.missingRates) missing.push(`Заполнить собственные ставки для ${economics.missingRates} строк${economics.missingRateNames?.length ? `: ${economics.missingRateNames.slice(0, 8).join("; ")}` : ""}.`);
  if (economics.cost == null) missing.push("Рассчитать себестоимость: подтверждённый итог черновика отсутствует.");
  if (economics.priceWithVat == null) missing.push("Подтвердить ставку НДС и получить сопоставимую итоговую цену проекта.");
  if (economics.priceExVat == null) missing.push("Нет цены чернового расчёта без НДС для проверки прибыли и рентабельности.");
  const labels: Record<string, string> = {
    vat_percent: "Указать применимую ставку НДС в расчёте.",
    "margin_rate_must_be_in_[0,1)": "Исправить ставку маржи: она должна быть от 0 до 100% исключительно.",
  };
  for (const reason of economics.incompleteReasons ?? []) {
    if (labels[reason]) missing.push(labels[reason]);
    else if (reason.startsWith("north:")) missing.push(`Подтвердить северные расходы: ${reason.split(":").slice(2).join(":") || "не заполнены исходные данные"}.`);
  }
  if (economics.incomplete && !missing.length) missing.push("Заполнить неполные входные данные черновика в разделе «Что учтено и что проверить».");
  return [...new Set(missing)];
}

export function companyAnalysisMissingInputs(company?: AnalysisCompanyContext): string[] {
  if (!company) return ["Передать в аналитику профиль услуг, парк техники и реестр рисков компании."];
  const missing: string[] = [];
  if (!company.serviceCatalogPresent) missing.push("В справочнике компании нет перечня услуг/видов работ — соответствие специализации подтвердить нельзя.");
  if (!company.resourceAvailabilityTracked) missing.push("Парк техники содержит учётные количества, но календарь занятости бригад и техники не ведётся — свободную доступность подтвердить нельзя.");
  for (const risk of company.riskRemarks.filter((item) =>
    item.severity === "high" && item.status !== "zakryto" && item.status !== "prinyato"
  ).slice(0, 8)) {
    missing.push(`Подтвердить решение по высокому открытому риску: ${risk.text}`);
  }
  return missing;
}

export function parseProjectAnalysisResult(raw: string): ModelResult {
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text) as Partial<ModelResult>;
  if (
    parsed.recommendation !== "participate" &&
    parsed.recommendation !== "do_not_participate" &&
    parsed.recommendation !== "insufficient_data"
  ) throw new Error("ИИ вернул неизвестную рекомендацию");
  return {
    recommendation: parsed.recommendation,
    missingInputs: Array.isArray(parsed.missingInputs)
      ? parsed.missingInputs.filter((item): item is string => typeof item === "string").slice(0, 30)
      : [],
    customerQuestions: Array.isArray(parsed.customerQuestions)
      ? parsed.customerQuestions.filter((item): item is string => typeof item === "string").slice(0, 20)
      : [],
    evidence: Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((item): item is ModelResult["evidence"][number] =>
          Boolean(item && typeof item.text === "string" && typeof item.quote === "string" && Array.isArray(item.citationIds))
        ).map((item) => ({
          topic: typeof item.topic === "string" && item.topic in TOPIC_LABELS ? item.topic : "other",
          importance: typeof item.importance === "string" && item.importance in IMPORTANCE_LABELS ? item.importance : "info",
          text: item.text,
          quote: item.quote,
          citationIds: item.citationIds.filter((id): id is string => typeof id === "string"),
          costImpact: typeof item.costImpact === "string" ? item.costImpact : undefined,
          scheduleImpact: typeof item.scheduleImpact === "string" ? item.scheduleImpact : undefined,
        })).slice(0, 24)
      : [],
  };
}

export function sanitizeCustomerQuestions(questions: string[], corpus: string): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const question of questions) {
    const text = question.replace(/\s+/g, " ").trim();
    const key = text.toLocaleLowerCase("ru-RU");
    if (text.length < 12 || text.length > 400 || seen.has(key) || !numbersAreGrounded(text, corpus)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length >= 12) break;
  }
  return kept;
}

function cleanImpact(value: string | undefined, quote: string): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!text || !numbersAreGrounded(text, quote)) return NOT_IN_DOCUMENTS;
  return text.slice(0, 300);
}

/** Same excerpt, even when two parsers reused an id such as `c-est` or `c-xlsx-1`. */
export function citationIdentity(citation: Pick<Citation, "sourceFile" | "page" | "text" | "paragraph" | "sheet" | "cell">): string {
  return [citation.sourceFile, citation.page, citation.paragraph ?? "", citation.sheet ?? "", citation.cell ?? "", citation.text].join("\u0001");
}

/**
 * Citations for one file come from that file's own objects.
 * Matching by id copies a second estimate into the first file, because parsers
 * restart ids on every document. The prompt id stays unique so the model and
 * the quote check can tell the two files apart.
 */
export function packDocumentCitations<T extends { id: string; citations: Citation[] }>(
  documents: T[],
  selected: Citation[],
  perDocument: number
): {
  byDocument: Map<string, Array<Citation & { promptId: string }>>;
  byPromptId: Map<string, Citation>;
} {
  const selectedObjects = new Set(selected);
  const selectedOrder = new Map<string, number>();
  selected.forEach((citation, index) => {
    const key = citationIdentity(citation);
    if (!selectedOrder.has(key)) selectedOrder.set(key, index);
  });
  const byDocument = new Map<string, Array<Citation & { promptId: string }>>();
  const byPromptId = new Map<string, Citation>();
  for (const document of documents) {
    const packed = document.citations
      .map((citation, index) => ({ citation, index }))
      .filter(({ citation }) => selectedObjects.has(citation) || selectedOrder.has(citationIdentity(citation)))
      .sort((left, right) => {
        const leftAt = selectedObjects.has(left.citation) ? selected.indexOf(left.citation) : selectedOrder.get(citationIdentity(left.citation)) ?? Number.MAX_SAFE_INTEGER;
        const rightAt = selectedObjects.has(right.citation) ? selected.indexOf(right.citation) : selectedOrder.get(citationIdentity(right.citation)) ?? Number.MAX_SAFE_INTEGER;
        return leftAt - rightAt;
      })
      .slice(0, perDocument)
      .map(({ citation, index }) => {
        const promptId = `${document.id}:${index}:${citation.id}`;
        byPromptId.set(promptId, citation);
        return { ...citation, promptId };
      });
    byDocument.set(document.id, packed);
  }
  return { byDocument, byPromptId };
}

const INJECTION_PATTERN = /ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+(?:all\s+)?(?:previous|above)|you\s+are\s+now|игнорир(?:уй|овать)\s+(?:все\s+)?предыдущ|забудь\s+(?:все\s+)?инструкц|новые\s+инструкции/iu;

export function promptInjectionExcerpts(items: Array<{ file: string; text: string }>): Array<{ file: string; excerpt: string }> {
  const found: Array<{ file: string; excerpt: string }> = [];
  for (const item of items) {
    const match = item.text.match(INJECTION_PATTERN);
    if (!match || match.index == null) continue;
    const start = Math.max(0, match.index - 40);
    found.push({
      file: item.file,
      excerpt: item.text.slice(start, match.index + match[0].length + 60).replace(/\s+/g, " ").trim(),
    });
    if (found.length >= 5) break;
  }
  return found;
}

export function rewritesSourceMeasure(text: string, quote: string): boolean {
  const read = (source: string, unit: RegExp) => [...source.matchAll(new RegExp(unit.source, unit.flags))]
    .map((match) => Number(match[1]?.replace(",", ".")))
    .filter((value) => Number.isFinite(value));
  const yearUnit = /(\d+(?:[.,]\d+)?)\s*(?:лет|года|год)(?![а-яё])/giu;
  const monthUnit = /(\d+(?:[.,]\d+)?)\s*месяц/giu;
  const yearsInText = read(text, yearUnit);
  const monthsInQuote = read(quote, monthUnit);
  if (yearsInText.some((year) => monthsInQuote.some((month) => Math.abs(year * 12 - month) < 0.05))) return true;
  const monthsInText = read(text, monthUnit);
  const yearsInQuote = read(quote, yearUnit);
  return monthsInText.some((month) => yearsInQuote.some((year) => Math.abs(year * 12 - month) < 0.05));
}

export function citationForModel(citation: Pick<Citation, "id" | "text" | "page" | "sourceFile" | "paragraph" | "sheet" | "cell" | "confidence">) {
  return {
    id: citation.id,
    sourceFile: citation.sourceFile,
    ...(citation.sheet ? { sheet: citation.sheet } : { page: citation.page }),
    ...(citation.paragraph != null ? { paragraph: citation.paragraph } : {}),
    ...(citation.cell ? { cell: citation.cell } : {}),
    location: formatSourceLocation({
      sourceFile: citation.sourceFile,
      sheet: citation.sheet,
      cell: citation.cell,
      paragraph: citation.paragraph,
      page: citation.sheet ? undefined : citation.page,
    }),
    ...(citation.confidence ? { confidence: citation.confidence } : {}),
    text: citation.text.slice(0, PROJECT_ANALYSIS_CITATION_CHARS),
  };
}

const LOGISTICS_PATTERN = /зимник|завоз|навигац|вахт/iu;

export function logisticsCustomerQuestion(texts: string[]): string | null {
  if (texts.some((text) => LOGISTICS_PATTERN.test(text))) return null;
  return "Уточните у заказчика логистику: завоз, зимник и вахту. В переданных документах это не описано.";
}

export function recommendationAfterConflict(
  recommendation: ProjectAnalytics["recommendation"],
  hasConflict: boolean,
  hardStop: boolean
): ProjectAnalytics["recommendation"] {
  if (hasConflict && !hardStop) return "insufficient_data";
  return recommendation;
}

function moneyAmounts(text: string): Array<{ raw: string; rubles: number; thousands: boolean }> {
  const found: Array<{ raw: string; rubles: number; thousands: boolean }> = [];
  const pattern = /(\d{1,3}(?:[ \u00a0]\d{3})+(?:[,.]\d+)?|\d+(?:[,.]\d+)?)(\s*тыс\.?)?/gu;
  for (const match of text.matchAll(pattern)) {
    const numeric = Number(match[1]!.replace(/[ \u00a0]/g, "").replace(",", "."));
    if (!Number.isFinite(numeric)) continue;
    const thousands = Boolean(match[2]);
    found.push({
      raw: `${match[1]}${match[2] ?? ""}`.replace(/\s+/g, " ").trim(),
      rubles: thousands ? numeric * 1000 : numeric,
      thousands,
    });
  }
  return found;
}

function moneyLabel(rubles: number, thousands: boolean, texts: string[]): string {
  for (const text of texts) {
    for (const amount of moneyAmounts(text)) {
      if (Math.abs(amount.rubles - rubles) <= 1) {
        const number = amount.raw.replace(/\s*тыс\.?/iu, "").trim();
        return amount.thousands ? `${number} тыс. руб.` : `${number} руб.`;
      }
    }
  }
  const value = thousands ? rubles / 1000 : rubles;
  const [whole, frac] = Math.abs(value).toFixed(2).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped},${frac} ${thousands ? "тыс. руб." : "руб."}`;
}

export type CostConflictFinding = {
  topic: "Противоречие в стоимости";
  importance: "high";
  text: string;
  quote: string;
  citationIds: string[];
  sourceFiles: string[];
  costImpact: string;
  scheduleImpact: string;
};

/** Contract price and the estimate total are different sums, so the package says so on its own. */
export function costConflictBetween(documents: Array<{
  fileName: string;
  title?: string;
  category?: string;
  analysis?: { costThousand?: number | null; positionCount?: number } | null;
  citations?: Array<{ id: string; text: string }>;
}>): CostConflictFinding | null {
  const priced = documents.flatMap((document) => {
    const name = `${document.fileName} ${document.title ?? ""}`.toLocaleLowerCase("ru-RU");
    const kind = document.category === "contract" || /договор|контракт/iu.test(name)
      ? "contract"
      : document.category === "estimate" || /смет/iu.test(name) || (document.analysis?.positionCount ?? 0) > 0
        ? "estimate"
        : null;
    if (!kind || document.analysis?.costThousand == null) return [];
    const rubles = Math.round(document.analysis.costThousand * 1000 * 100) / 100;
    const texts = (document.citations ?? []).map((citation) => citation.text);
    const quote = texts.find((text) => moneyAmounts(text).some((amount) => Math.abs(amount.rubles - rubles) <= 1))
      ?? texts[0]
      ?? "";
    const citation = (document.citations ?? []).find((item) => item.text === quote);
    return [{
      kind,
      rubles,
      label: moneyLabel(rubles, kind === "estimate", texts),
      quote,
      citationId: citation?.id,
      fileName: document.fileName,
    }];
  });
  const contract = priced.find((item) => item.kind === "contract");
  const estimate = priced.find((item) => item.kind === "estimate");
  if (!contract || !estimate || Math.abs(contract.rubles - estimate.rubles) <= 1) return null;
  return {
    topic: "Противоречие в стоимости",
    importance: "high",
    text: `В договоре указано ${contract.label}, в смете — ${estimate.label}. Это разные суммы.`,
    quote: contract.quote || estimate.quote,
    citationIds: [contract.citationId, estimate.citationId].filter((id): id is string => Boolean(id)),
    sourceFiles: [contract.fileName, estimate.fileName],
    costImpact: NOT_IN_DOCUMENTS,
    scheduleImpact: NOT_IN_DOCUMENTS,
  };
}

/** A sourced conflict, a conflict named by the model, or two regions in one sentence block participation. */
export function hasBlockingConflict(input: {
  topics: string[];
  missingInputs: string[];
  texts: string[];
}): boolean {
  return input.topics.includes("conflict")
    || input.missingInputs.some(describesConflict)
    || input.texts.some((text) => Boolean(splitMergedRegions(text).conflict));
}

/** Prefer the shortest citation that actually contains the quote, so the link is the paragraph of the fact. */
export function citationIdsForFact(quote: string, citations: Array<{ id: string; text: string; paragraph?: number | null }>): string[] {
  const needle = quote.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  if (needle.length < 8) return [];
  return [...citations]
    .filter((citation) => citation.text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").includes(needle))
    .sort((left, right) => left.text.length - right.text.length || (left.paragraph ?? 999) - (right.paragraph ?? 999))
    .map((citation) => citation.id);
}

function normalizeSourceText(value: string): string {
  return value.toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/процент(?:а|ов)?/gu, "%")
    .replace(/\s*%/g, "%")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(["это", "что", "при", "для", "или", "как", "его", "ее", "они", "есть", "быть", "данные", "сумма", "срок"]);

function lexicalStem(word: string): string {
  if (/^оплачива/u.test(word)) return "оплат";
  return word.replace(/(?:иями|ями|ами|ого|ему|ому|ыми|ими|ивает|ывают|овать|евать|ать|ять|ить|ает|яет|ует|уют|ают|яют|ала|яла|али|яли|ах|ях|ов|ев|ей|ой|ый|ая|яя|ое|ее|ия|ие|ы|и|а|я|е|у|ю)$/u, "");
}

export function validateProjectEvidence(
  result: ModelResult,
  citations: ProjectAnalytics["citations"],
  allowedCitationIds?: Set<string>
) {
  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  const accepted: Array<ModelResult["evidence"][number] & { sourceFiles: string[] }> = [];
  let rejected = 0;

  for (const item of result.evidence) {
    const validCitations = item.citationIds
      .filter((id) => !allowedCitationIds || allowedCitationIds.has(id))
      .map((id) => byId.get(id))
      .filter((citation) => Boolean(citation));
    const quote = normalizeSourceText(item.quote);
    const quoteExists = validCitations.some((citation) => normalizeSourceText(citation!.text).includes(quote));
    const claimNumbers = item.text.match(/\d+(?:[.,]\d+)?\s*%?/g) ?? [];
    const numbersGrounded = claimNumbers.every((number) => quote.includes(normalizeSourceText(number)));
    const claimWords = (normalizeSourceText(item.text).match(/[а-яa-z]{4,}/g) ?? []).filter((word) => !STOP_WORDS.has(word));
    const quoteWords = new Set((normalizeSourceText(item.quote).match(/[а-яa-z]{4,}/g) ?? []).map(lexicalStem));
    const overlap = claimWords.filter((word) => quoteWords.has(lexicalStem(word))).length;
    const wordingGrounded = claimWords.length > 0 && overlap / claimWords.length >= 0.35;

    if (!item.text.trim() || quote.length < 8 || !quoteExists || !numbersGrounded || !wordingGrounded || rewritesSourceMeasure(item.text, item.quote)) {
      rejected += 1;
      continue;
    }
    accepted.push({
      ...item,
      costImpact: cleanImpact(item.costImpact, item.quote),
      scheduleImpact: cleanImpact(item.scheduleImpact, item.quote),
      citationIds: validCitations.map((citation) => citation!.id),
      sourceFiles: [...new Set(validCitations.map((citation) => citation!.sourceFile))],
    });
  }
  return { accepted, rejected };
}

export function gateModelRecommendation(
  local: ProjectAnalytics["recommendation"],
  model: ProjectAnalytics["recommendation"],
  hasCriticalEvidence: boolean,
  modelNamedGaps = true
): ProjectAnalytics["recommendation"] {
  if (local !== "participate") return local;
  if (model === "insufficient_data" && modelNamedGaps) return "insufficient_data";
  if (model === "do_not_participate" && hasCriticalEvidence) return "do_not_participate";
  return "participate";
}

export async function analyzeProjectPackageWithModel(
  procurement: Procurement,
  documents: DocumentItem[],
  deterministic: ProjectAnalytics,
  economics?: AnalysisEconomics,
  company?: AnalysisCompanyContext
): Promise<ProjectAnalytics> {
  const packageDocuments = documents.filter((document) => document.procurementId === procurement.id);
  const packageRegion = procurement.region.trim() || packageDocuments.map((document) => document.analysis?.region.trim()).find(Boolean) || regionFromCitations(deterministic.citations) || "не указан";
  const packageDeadline = formatDeadlineForBrief(procurement.deadline.trim() || submissionDeadlineFromCitations(deterministic.citations) || "не найден в загруженных документах");
  const selectedPackageCitations = selectAnalysisCitations(deterministic.citations, PROJECT_ANALYSIS_CITATION_LIMIT);
  const { byDocument: documentCitations, byPromptId } = packDocumentCitations(
    packageDocuments,
    selectedPackageCitations,
    PROJECT_ANALYSIS_CITATIONS_PER_DOCUMENT
  );
  const visibleCitationIds = new Set(byPromptId.keys());
  const inputs = {
    procurement: {
      number: procurement.number,
      title: procurement.title,
      customer: procurement.customer,
      region: packageRegion,
      workType: procurement.workType,
      nmck: procurement.nmck,
      deadline: packageDeadline,
    },
    coverage: {
      missingInputs: deterministic.missingInputs,
      localRecommendation: deterministic.recommendation,
      decisionRule: "Отсутствие сметы заказчика не блокирует решение, если собственная ресурсная калькуляция полная. Учитывай договорные риски и профиль ресурсов компании.",
    },
    economics: economics ? {
      procurementMaximumPrice: procurement.nmck,
      contractorCost: economics.cost,
      priceBeforeVat: economics.priceExVat ?? null,
      priceWithVat: economics.priceWithVat,
      profit: economics.profit ?? null,
      profitabilityOnCostPercent: economics.profitabilityPercent ?? null,
      marginOnRevenuePercent: economics.revenueMarginPercent ?? null,
      incomplete: economics.incomplete,
      missingOwnRates: economics.missingRates,
      missingInputs: economicMissingInputs(economics),
      note: "Это детерминированный черновой расчёт по ставкам компании, не смета заказчика. Используй переданные стоимость, цену, прибыль и рентабельность; не пересчитывай и не называй запас до НМЦК прибылью. Если расчёт неполный или цена/НМЦК не сопоставимы по НДС, рекомендация должна быть insufficient_data.",
    } : {
      procurementMaximumPrice: procurement.nmck,
      note: "Черновой ресурсный расчёт отсутствует. Не выдавай рекомендацию участвовать без него; верни insufficient_data.",
    },
    company: {
      profileRows: company?.profileRows ?? [],
      serviceCatalogPresent: company?.serviceCatalogPresent ?? false,
      laborRates: company?.laborRates ?? [],
      registeredFleet: company?.fleet ?? [],
      resourceAvailabilityTracked: company?.resourceAvailabilityTracked ?? false,
      riskRegister: company?.riskRemarks ?? [],
      interpretation: "Профиль, тарифы, парк и реестр рисков — данные компании, не цитаты из тендера. Используй их для оценки соответствия и ресурсов. Учётное количество техники не означает, что она свободна на нужные даты. Не утверждай опыт или компетенцию, если перечень услуг не заполнен.",
    },
    documents: packageDocuments.map((document) => ({
      title: document.title,
      fileName: document.fileName,
      category: document.category,
      status: document.status,
      analysis: document.analysis,
      note: document.analyticalNote.slice(0, PROJECT_ANALYSIS_NOTE_CHARS),
      extractionErrors: document.extractionErrors ?? [],
      highlights: document.highlights.slice(0, PROJECT_ANALYSIS_HIGHLIGHTS).map(({ text, reason, severity, page }) => {
        const sheet = document.citations.find((citation) => citation.sheet)?.sheet;
        return sheet
          ? { text, reason, severity, location: formatSourceLocation({ sourceFile: document.fileName, sheet }) }
          : { text, reason, severity, page, location: formatSourceLocation({ sourceFile: document.fileName, page }) };
      }),
      estimatePositions: (document.estimatePositions ?? []).filter((position) => !isOverheadPosition(position)).slice(0, PROJECT_ANALYSIS_POSITIONS),
      sectionRollup: rollupWorkSections(document.estimatePositions ?? []),
      authoritativeSections: rollupWorkSections(document.estimatePositions ?? []).sections.map((section) => ({
        name: section.section,
        unit: section.unit,
        quantity: section.quantity,
        rows: section.rows,
      })),
      citations: (documentCitations.get(document.id) ?? []).map((citation) => citationForModel({ ...citation, id: citation.promptId })),
    })),
    citationBudget: { available: deterministic.citations.length, sentToModel: selectedPackageCitations.length },
  };

  const result = parseProjectAnalysisResult(await completeJson(SYSTEM, JSON.stringify(inputs)));
  const promptCitations = [...byPromptId.entries()].map(([promptId, citation]) => ({ ...citation, id: promptId }));
  const { accepted, rejected } = validateProjectEvidence(result, promptCitations, visibleCitationIds);
  const evidence = accepted.map((item) => {
    const holders = citationIdsForFact(item.quote, [...byPromptId.values()]);
    const sources = (holders.length ? holders : item.citationIds).flatMap((id) => {
      const citation = holders.length
        ? [...byPromptId.values()].find((item) => item.id === id)
        : byPromptId.get(id);
      if (!citation) return [];
      const location = citation.sheet
        ? `лист ${citation.sheet}${citation.cell ? `, ${citation.cell}` : ""}`
        : citation.paragraph != null
          ? `абз. ${citation.paragraph}`
          : `стр. ${citation.page}`;
      return [`${citation.sourceFile}, ${location}`];
    });
    const topic = TOPIC_LABELS[item.topic] ?? TOPIC_LABELS.other;
    const importance = IMPORTANCE_LABELS[item.importance] ?? IMPORTANCE_LABELS.info;
    return `• ${importance} · ${topic}: ${item.text.trim()} — «${item.quote.trim()}» [${sources.join("; ")}]`;
  });

  // The model can still omit a high-impact clause even when OCR found it. Keep
  // payment and liability coverage complete with a conservative, citation-only
  // fallback; never infer a rate, amount, or missing contractual term here.
  const requiredTopicFallbacks = [
    {
      topic: "Ответственность",
      pattern: /штраф|пен[яи]|неустойк|удержан|обеспечен|расторжен/iu,
      text: "В источнике найдено условие об ответственности; проверьте основание и порядок его применения.",
    },
    {
      topic: "Оплата",
      pattern: /оплат|аванс|отсроч|при[её]мк|удержан/iu,
      text: "В источнике найдено условие оплаты; проверьте срок, основание оплаты и авансирование.",
    },
  ];
  const fallbackEvidence = requiredTopicFallbacks.flatMap(({ topic, pattern, text }) => {
    if (accepted.some((item) => TOPIC_LABELS[item.topic] === topic)) return [];
    const citation = promptCitations.find(({ id, text: citationText }) =>
      visibleCitationIds.has(id) && pattern.test(citationText)
    );
    if (!citation) return [];
    const location = citation.sheet
      ? `лист ${citation.sheet}${citation.cell ? `, ${citation.cell}` : ""}`
      : citation.paragraph != null
        ? `абз. ${citation.paragraph}`
        : `стр. ${citation.page}`;
    return [`• Условие из источника · ${topic}: ${text} — «${citation.text.trim()}» [${citation.sourceFile}, ${location}]`];
  });

  // Missing inputs come from deterministic package coverage. Model-authored items
  // are not source-grounded and must not be presented as verified gaps.
  const companyGaps = companyAnalysisMissingInputs(company);
  const visibleCorpus = [...visibleCitationIds].map((id) => byPromptId.get(id)?.text ?? "").join("\n");
  const modelGaps = sanitizeCustomerQuestions(result.missingInputs, visibleCorpus).filter((item) => !describesConflict(item));
  const modelNamedGaps = result.recommendation !== "insufficient_data" || modelGaps.length > 0;
  const packageSectionCount = packageDocuments.reduce((count, document) => count + rollupWorkSections(document.estimatePositions ?? []).sections.length, 0);
  const missingInputs = [...new Set([
    ...deterministic.missingInputs,
    ...economicMissingInputs(economics),
    ...companyGaps,
    ...(result.recommendation === "insufficient_data" && modelGaps.length > 0 ? modelGaps : []),
  ])].slice(0, 40);
  const hasCriticalEvidence = accepted.some((item) => item.importance === "critical" || item.citationIds.some((id) => {
    const citation = byPromptId.get(id);
    return packageDocuments.some((document) => document.highlights.some((highlight) =>
      highlight.severity === "critical" && citation && normalizeSourceText(highlight.text) === normalizeSourceText(citation.text)
    ));
  }));

  const hardCoverageGaps = deterministic.missingInputs.filter((item) =>
    /нет доступных исходных файлов|не приложен или недоступен|не найден проект договора|не найдено ТЗ|ошибки извлечения|не дал проверяемых выдержек/iu.test(item)
  );
  const missingServices = !company?.serviceCatalogPresent;
  const economicsComplete = Boolean(economics && !economics.incomplete && economics.cost != null &&
    economics.priceExVat != null && economics.priceWithVat != null && economics.profit != null && procurement.nmck != null);
  const hasOpenHighRisk = Boolean(company?.riskRemarks.some((risk) =>
    risk.severity === "high" && risk.status !== "zakryto" && risk.status !== "prinyato"
  ));
  const positiveProfit = economics?.profit != null && economics.profit > 0;
  const priceWithinMaximum = economics?.priceWithVat != null && procurement.nmck != null && economics.priceWithVat <= procurement.nmck;
  const decisionReady = hardCoverageGaps.length === 0 && !missingServices && !hasOpenHighRisk && economicsComplete && positiveProfit && priceWithinMaximum;

  // Model can only choose once source coverage, company profile and full
  // resource economics are present. Missing the customer's estimate is not a
  // blocker if our own resource calculation is complete.
  const localDecision: ProjectAnalytics["recommendation"] = deterministic.recommendation === "do_not_participate"
    ? "do_not_participate"
    : decisionReady ? "participate" : "insufficient_data";
  let recommendation = gateModelRecommendation(
    localDecision,
    modelNamedGaps ? result.recommendation : "participate",
    hasCriticalEvidence,
    modelNamedGaps
  );
  const priceStop = economics?.priceWithVat != null && procurement.nmck != null && economics.priceWithVat > procurement.nmck;
  const profitStop = Boolean(economics?.profit != null && economics.profit <= 0 && economicsComplete);
  if (priceStop || profitStop) recommendation = "do_not_participate";
  const conflictNotes = sanitizeCustomerQuestions(result.missingInputs, visibleCorpus).filter(describesConflict);
  const priceConflict = costConflictBetween(packageDocuments);
  const hasDataConflict = hasBlockingConflict({
    topics: accepted.map((item) => item.topic),
    missingInputs: conflictNotes,
    texts: accepted.map((item) => item.text),
  }) || Boolean(priceConflict);
  recommendation = recommendationAfterConflict(recommendation, hasDataConflict, priceStop || profitStop);
  let reportedGaps = missingInputs;

  const economicSummary = !economics
    ? "Черновая себестоимость не рассчитана."
    : [
        `Черновая себестоимость по справочникам компании: ${economics.cost == null ? "нет подтверждённого итога" : `${economics.cost} ₽`}.`,
        economics.missingRates ? `Не найдены собственные ставки для ${economics.missingRates} строк.` : "Ставки по строкам черновика найдены.",
        economics.incomplete ? "Ресурсный расчёт неполный, поэтому решение об участии пока не подтверждено." : null,
        economics.profit == null || economics.priceExVat == null
          ? "Прибыль и рентабельность не рассчитаны: нужен полный расчёт без НДС."
          : `Расчётная прибыль до налога: ${economics.profit} ₽; рентабельность на себестоимость: ${economics.profitabilityPercent ?? "не рассчитана"}%; маржа в цене: ${economics.revenueMarginPercent ?? "не рассчитана"}%.`,
        economics.priceWithVat == null || procurement.nmck == null
          ? "Рентабельность относительно НМЦК не рассчитана: нет сопоставимого итога с подтверждённым НДС и/или НМЦК."
          : `Предельная разница между НМЦК и расчётной ценой с НДС: ${Math.round((procurement.nmck - economics.priceWithVat) * 100) / 100} ₽. Это запас до предельной цены, а не обещанная прибыль.`
      ].filter(Boolean).join(" ");
  const sourceStatus = deterministic.quality?.status === "evidence_backed"
    ? "Есть выводы, подтверждённые цитатами."
    : deterministic.quality?.status === "needs_review"
      ? "Часть источников требует ручной проверки."
      : "Источников недостаточно для окончательной рекомендации.";
  const packageBrief = [
    `Закупка: ${procurement.title}${procurement.number ? ` · ${procurement.number}` : ""}. Заказчик: ${procurement.customer || "не указан"}. Регион: ${packageRegion}. Срок подачи: ${packageDeadline}.`,
    `Пакет: ${packageDocuments.length} документов, ${selectedPackageCitations.length} из ${deterministic.citations.length} выдержек передано модели. ${sourceStatus}`,
    reportedGaps.length ? "Есть пункты для проверки; они перечислены ниже." : "Блокирующих пробелов по покрытию не отмечено.",
    decisionReady && !company?.resourceAvailabilityTracked ? "Решение по экономике и профилю предварительное: календарь фактической загрузки техники/бригад не подключён." : null,
  ].filter(Boolean).join("\n");
  const volumeRollups = packageDocuments.map((document) => rollupWorkSections(document.estimatePositions ?? []));
  const sectionNames = volumeRollups.flatMap((rollup) => rollup.sections.map((section) => section.section));
  const alignVolume = (text: string) => volumeRollups.reduce((current, rollup) => alignVolumeToSections(current, rollup), text);
  const regionConflicts: Array<{ text: string; quote: string; citationIds: string[]; sourceFiles: string[] }> = [];
  const presentFinding = (text: string, quote: string, citationIds: string[], sourceFiles: string[]) => {
    const stripped = stripWorkTypesOutsideSources(alignVolume(text), quote, sectionNames);
    const split = splitMergedRegions(stripped);
    if (split.conflict && !regionConflicts.some((item) => item.text === split.conflict)) {
      regionConflicts.push({ text: split.conflict, quote, citationIds, sourceFiles });
    }
    return split.text;
  };

  return {
    ...deterministic,
    recommendation,
    summary: [
      packageBrief,
      economicSummary,
      evidence.length
        ? `ИИ подготовил ${evidence.length} вывода с проверяемыми источниками.`
        : "Модель не вернула тезис, прошедший проверку цитаты; оставлена локальная сводка.",
    ].join("\n\n"),
    missingInputs: reportedGaps,
    findings: [
      ...accepted
        .filter((item) => packageSectionCount <= 1 || !/только\s+(?:по\s+)?одн(?:у|ой|а|о)\s+позиц/iu.test(item.text))
        .map(({ topic, importance, text, quote, citationIds, sourceFiles, costImpact, scheduleImpact }) => {
          const holders = citationIdsForFact(quote, [...byPromptId.values()]);
          const resolvedIds = holders.length ? [...new Set(holders)].slice(0, 4) : citationIds.map((id) => byPromptId.get(id)?.id ?? id);
          return {
            topic: TOPIC_LABELS[topic] ?? TOPIC_LABELS.other,
            importance: importance as NonNullable<ProjectAnalytics["findings"]>[number]["importance"],
            text: presentFinding(text, quote, resolvedIds, sourceFiles),
            quote,
            citationIds: resolvedIds,
            sourceFiles,
            costImpact,
            scheduleImpact,
          };
        }),
      ...(priceConflict && !accepted.some((item) => /противоречие в стоимости/iu.test(item.text)) ? [priceConflict] : []),
      ...regionConflicts
        .filter((item) => !accepted.some((entry) => entry.topic === "conflict" && entry.text.includes(item.text.slice(0, 40))))
        .map((item) => ({
          topic: TOPIC_LABELS.conflict,
          importance: "high" as const,
          text: item.text,
          quote: item.quote,
          citationIds: item.citationIds,
          sourceFiles: item.sourceFiles,
          costImpact: NOT_IN_DOCUMENTS,
          scheduleImpact: NOT_IN_DOCUMENTS,
        })),
      ...promptInjectionExcerpts(packageDocuments.flatMap((document) => [
        { file: document.fileName, text: document.analyticalNote ?? "" },
        ...document.citations.map((citation) => ({ file: document.fileName, text: citation.text })),
      ])).map((item) => ({
        topic: "Аномалия документа",
        importance: "critical" as const,
        text: "В файле есть указание для модели. Оно не выполнено и на решение не влияет.",
        quote: item.excerpt,
        citationIds: [] as string[],
        sourceFiles: [item.file],
        costImpact: NOT_IN_DOCUMENTS,
        scheduleImpact: NOT_IN_DOCUMENTS,
      })),
    ],
    customerQuestions: (() => {
      const corpus = [...visibleCitationIds].map((id) => byPromptId.get(id)?.text ?? "");
      const questions = sanitizeCustomerQuestions(result.customerQuestions, corpus.join("\n"));
      const logistics = logisticsCustomerQuestion([
        ...corpus,
        ...packageDocuments.map((document) => document.analyticalNote ?? ""),
      ]);
      if (!logistics || questions.some((question) => /логистик|зимник|завоз|вахт/iu.test(question))) return questions;
      return [...questions, logistics].slice(0, 12);
    })(),
    generatedAt: new Date().toISOString(),
      method: "разбор пакета по цитатам документов",
    disclaimer: "ИИ не вычисляет сметные итоги. Показаны только тезисы с цитатой из файла; риск и рекомендацию проверьте по оригиналу. Это не экспертное заключение и не обещание статистической точности.",
    economics: economics ? {
      cost: economics.cost,
      priceExVat: economics.priceExVat ?? null,
      priceWithVat: economics.priceWithVat,
      profit: economics.profit ?? null,
      profitabilityPercent: economics.profitabilityPercent ?? null,
      revenueMarginPercent: economics.revenueMarginPercent ?? null,
      complete: economicsComplete,
      missingInputs: economicMissingInputs(economics),
    } : undefined,
    quality: {
      status: deterministic.quality?.status === "insufficient_sources" || (evidence.length === 0 && fallbackEvidence.length === 0)
        ? "insufficient_sources"
        : deterministic.quality?.status === "needs_review" || rejected > 0
          ? "needs_review"
          : "evidence_backed",
      sourceDocuments: packageDocuments.length,
      requiredDocumentsFound: deterministic.quality?.requiredDocumentsFound ?? 0,
      citationCount: deterministic.citations.length,
      acceptedClaims: accepted.length + fallbackEvidence.length,
      rejectedClaims: rejected,
    },
  };
}

export function buildProjectAnalysisFallback(
  procurement: Procurement,
  deterministic: ProjectAnalytics,
  economics: AnalysisEconomics | undefined,
  company: AnalysisCompanyContext | undefined,
  failure: string
): ProjectAnalytics {
  const companyGaps = companyAnalysisMissingInputs(company);
  const missingInputs = [...new Set([
    ...deterministic.missingInputs,
    ...economicMissingInputs(economics),
    ...companyGaps,
    "Модель не ответила; ИИ-выводы по рискам и текстам не сформированы.",
  ])].slice(0, 40);
  const cost = economics?.cost ?? null;
  const priceExVat = economics?.priceExVat ?? null;
  const priceWithVat = economics?.priceWithVat ?? null;
  const profit = economics?.profit ?? null;
  const profitabilityPercent = economics?.profitabilityPercent ?? null;
  const revenueMarginPercent = economics?.revenueMarginPercent ?? null;
  const calculationsReady = Boolean(economics && !economics.incomplete && cost != null &&
    priceExVat != null && priceWithVat != null && profit != null && procurement.nmck != null);
  const priceTooHigh = priceWithVat != null && procurement.nmck != null && priceWithVat > procurement.nmck;
  const noProfit = profit != null && profit <= 0;
  let recommendation: ProjectAnalytics["recommendation"] = "insufficient_data";
  if (priceTooHigh || (calculationsReady && noProfit)) recommendation = "do_not_participate";
  else if (deterministic.recommendation === "do_not_participate") recommendation = "do_not_participate";
  // A fallback has not reviewed the tender clauses semantically. Without that
  // model pass it must not turn a complete spreadsheet into a bid approval.
  const economicText = economics ? [
    `Себестоимость с учтёнными накладными: ${cost == null ? "не рассчитана" : `${cost} ₽`}.`,
    `Цена без НДС: ${priceExVat == null ? "не рассчитана" : `${priceExVat} ₽`}; с НДС: ${priceWithVat == null ? "не рассчитана" : `${priceWithVat} ₽`}.`,
    `Прибыль: ${profit == null ? "не рассчитана" : `${profit} ₽`}; рентабельность на себестоимость: ${profitabilityPercent == null ? "не рассчитана" : `${profitabilityPercent}%`}; маржа в цене: ${revenueMarginPercent == null ? "не рассчитана" : `${revenueMarginPercent}%`}.`,
    procurement.nmck != null && priceWithVat != null ? `Сравнение с НМЦК ${procurement.nmck} ₽: ${priceTooHigh ? "расчётная цена выше НМЦК" : "расчётная цена не выше НМЦК"}.` : "Сравнить цену с НМЦК нельзя: нет сопоставимых значений.",
    ...economicMissingInputs(economics),
  ].filter(Boolean).join(" ") : "Собственная ресурсная калькуляция отсутствует.";
  const riskText = company?.riskRemarks.length
    ? company.riskRemarks.slice(0, 12).map((risk) => `${risk.severity} · ${risk.status}: ${risk.text}${risk.sourceExcerpt ? ` — «${risk.sourceExcerpt}»` : ""}`).join("\n")
    : "В реестре компании нет замечаний по рискам; отсутствие записи не подтверждает отсутствие риска в документах.";
  const profileText = [
    `Строк профиля/ОКПД: ${company?.profileRows.length ?? 0}.`,
    `Строк ставок труда: ${company?.laborRates.length ?? 0}.`,
    `Единиц в учётном парке: ${company?.fleet.reduce((sum, row) => sum + (row.quantity ?? 0), 0) ?? 0}.`,
    company?.resourceAvailabilityTracked ? "Календарь занятости ресурсов ведётся." : "Календарь занятости бригад и техники не ведётся; доступность нужно подтвердить отдельно.",
  ].join(" ");
  const result: ProjectAnalytics = {
    ...deterministic,
    recommendation,
    findings: [],
    customerQuestions: [],
    aiFailure: aiAnalysisFailureStatus(failure),
    summary: [
      deterministic.summary,
      "ИИ-анализ не завершился. Ниже сохранён детерминированный расчёт; модельные тезисы и заключение по рискам не сформированы.",
      `Экономика: ${economicText}`,
      `Данные компании: ${profileText}`,
      `Реестр рисков компании:\n${riskText}`,
      `Технический сбой модели: ${failure.slice(0, 180)}`,
      `Почему решение такое: ${recommendation === "do_not_participate" ? "цена выше НМЦК, прибыль неположительная либо есть сохранённое критичное препятствие" : "модель не проверила договорные риски и пригодность закупки; автоматическое одобрение участия небезопасно"}.`,
    ].join("\n\n"),
    missingInputs,
    generatedAt: new Date().toISOString(),
    method: "локальный расчёт, модель не ответила",
    disclaimer: "Модель не ответила. Показаны только детерминированные расчёты и сохранённые источники; ИИ-оценка рисков не выполнена.",
    economics: economics ? {
      cost, priceExVat, priceWithVat, profit, profitabilityPercent, revenueMarginPercent,
      complete: calculationsReady,
      missingInputs: economicMissingInputs(economics),
    } : undefined,
    quality: {
      status: deterministic.quality?.status === "insufficient_sources" ? "insufficient_sources" : "needs_review",
      sourceDocuments: deterministic.quality?.sourceDocuments ?? 0,
      requiredDocumentsFound: deterministic.quality?.requiredDocumentsFound ?? 0,
      citationCount: deterministic.citations.length,
      acceptedClaims: 0,
      rejectedClaims: 0,
    },
  };
  return result;
}
