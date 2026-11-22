import type { Citation, GprStage } from "@/lib/types";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS, type ResourceScheduleParams } from "@/lib/resource-schedule-model";

/** Genitive after «для» / «без»: 1 строки, 2 строк, 5 строк, 21 строки. */
export function rowCountGenitive(count: number): string {
  const n = Math.abs(Math.trunc(count));
  const word = n % 10 === 1 && n % 100 !== 11 ? "строки" : "строк";
  return `${n} ${word}`;
}

/** Counted «строка»: 1 строка, 24 строки, 25 строк, 11 строк, 21 строка. */
export function rowCountNominative(count: number): string {
  const n = Math.abs(Math.trunc(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11
    ? "строка"
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? "строки"
      : "строк";
  return `${n} ${word}`;
}

/** «распознана 1 строка» / «распознано 24 строки» / «распознано 25 строк». */
export function recognizedRowsPhrase(count: number): string {
  const n = Math.abs(Math.trunc(count));
  const singular = n % 10 === 1 && n % 100 !== 11;
  return `${singular ? "распознана" : "распознано"} ${rowCountNominative(n)}`;
}

export function moneyRu(value: number): string {
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value).replace(/\u00a0/g, " ");
  return `${formatted} ₽`;
}

/** A positive total with some rates still missing is a partial cost, not a blank. */
export function costIsPartial(cost: number | null, missingRates: number): boolean {
  return missingRates > 0 && cost != null && cost > 0;
}

/** No usable cost: every contributing rate is missing, or the total is 0 because rates are missing. */
export function costIsUncalculated(cost: number | null, missingRates: number): boolean {
  return missingRates > 0 && !costIsPartial(cost, missingRates);
}

/**
 * A missing rate is not a confirmed zero. A real zero with every rate found
 * stays a zero and asks for a check, so it never says «нет ставок для 0 строк».
 * A positive total with gaps keeps the known amount and names the gap.
 */
export function draftCostPhrase(cost: number | null, missingRates: number): string {
  const missing = Math.max(0, Math.trunc(missingRates) || 0);
  if (costIsPartial(cost, missing)) {
    return `Себестоимость по найденным ставкам: ${moneyRu(cost ?? 0)} (без ${rowCountGenitive(missing)} без ставок)`;
  }
  if (missing > 0) return `Себестоимость не рассчитана: нет ставок для ${rowCountGenitive(missing)}`;
  if (cost === 0) return "Себестоимость 0 ₽: проверьте объёмы и ставки";
  if (cost == null) return "нет подтверждённого итога";
  return `${cost} ₽`;
}

/** Current draft used only to phrase a stored memo. Numbers stay on the calculation. */
export type MemoCalcState = {
  cost: number | null;
  missingRates: number;
};

/**
 * Missing rates and the cost the memo should describe, from the procurement's
 * current draft. Work lines are not rates. An empty shell is not a calc.
 */
export function calcMemoState(calc: {
  positions?: Array<{ rateMissing?: boolean; isWorkItem?: boolean }>;
  costSummary?: {
    C0?: number | null;
    resourceSlices?: { costWithOh?: number | null } | null;
  } | null;
} | null | undefined): MemoCalcState | null {
  if (!calc) return null;
  const positions = calc.positions ?? [];
  if (!positions.length && calc.costSummary == null) return null;
  const missingRates = positions.filter((position) => position.rateMissing && !position.isWorkItem).length;
  const withOverhead = calc.costSummary?.resourceSlices?.costWithOh;
  const direct = calc.costSummary?.C0;
  const picked = withOverhead ?? direct ?? null;
  return {
    cost: picked == null || !Number.isFinite(picked) ? null : picked,
    missingRates,
  };
}

const LEGACY_COST_PHRASE =
  /(?:Черновая себестоимость по справочникам компании|Себестоимость с учтёнными накладными):\s*(?:нет подтверждённого итога|не рассчитана|\d[\d\s\u00a0.,]*?₽)/gu;

const LEGACY_SHORT_COST = /Черновая себестоимость не рассчитана/gu;

const LEGACY_PROFIT_PHRASE =
  /(?:Расчётная прибыль до налога|Прибыль):\s*(?:не рассчитана\s*%?|\d[\d\s\u00a0.,]*?₽);\s*рентабельность на себестоимость:\s*(?:не рассчитана\s*%?|\d[\d\s\u00a0.,]*?%);\s*маржа в цене:\s*(?:не рассчитана\s*%?|\d[\d\s\u00a0.,]*?%)\.?/gu;

const LEGACY_UNCONFIRMED_PROFIT =
  /Прибыль и рентабельность не рассчитаны: нужен полный расчёт без НДС\.?/gu;

const LEGACY_NMCK =
  /Предельная разница между НМЦК и расчётной ценой с НДС:[^.]*\.\s*Это запас до предельной цены, а не обещанная прибыль\.|Сравнение с НМЦК \d[\d\s\u00a0.,]*?₽:\s*расчётная цена (?:не )?выше НМЦК\./gu;

const GLUED_MISSING_PERCENT = /не рассчитана\s*%/gu;

function tidyDisplayedPunctuation(text: string): string {
  let next = text;
  let previous = "";
  while (next !== previous) {
    previous = next;
    next = next.replace(/\.\s+\./g, ".");
  }
  return next;
}

/** Rewrite only the old deterministic economics sentences. Findings and citations stay. */
function rewriteLegacyEconomics(text: string, state: MemoCalcState): string {
  for (const pattern of [
    LEGACY_COST_PHRASE, LEGACY_SHORT_COST, LEGACY_PROFIT_PHRASE,
    LEGACY_UNCONFIRMED_PROFIT, LEGACY_NMCK, GLUED_MISSING_PERCENT,
  ]) pattern.lastIndex = 0;
  const missing = Math.max(0, Math.trunc(state.missingRates) || 0);
  const cost = state.cost;
  const uncalculated = costIsUncalculated(cost, missing) || (cost == null && missing > 0);
  const partial = costIsPartial(cost, missing);
  const genuineZero = cost === 0 && missing === 0;
  if (!uncalculated && !partial && !genuineZero) {
    return text.replace(GLUED_MISSING_PERCENT, "не рассчитана");
  }
  const honestCost = draftCostPhrase(cost, missing);
  let next = text.replace(LEGACY_COST_PHRASE, honestCost);
  if (missing > 0 && uncalculated) next = next.replace(LEGACY_SHORT_COST, honestCost);
  if (uncalculated) {
    const hidden = "Прибыль и рентабельность не рассчитаны: себестоимость не подтверждена.";
    next = next.replace(LEGACY_PROFIT_PHRASE, hidden);
    next = next.replace(LEGACY_UNCONFIRMED_PROFIT, hidden);
    next = next.replace(LEGACY_NMCK, "Сравнение с НМЦК невозможно, пока себестоимость не рассчитана.");
  } else if (partial) {
    const prefix = `Предварительно, только по найденным ставкам, без ${rowCountGenitive(missing)} без ставок. `;
    next = next.replace(LEGACY_PROFIT_PHRASE, (sentence: string, offset: number) => {
      const before = next.slice(Math.max(0, offset - 120), offset);
      const cleaned = sentence.replace(/не рассчитана\s*%/gu, "не рассчитана");
      if (before.includes("Предварительно, только по найденным ставкам")) return cleaned;
      return `${prefix}${cleaned}`;
    });
  }
  GLUED_MISSING_PERCENT.lastIndex = 0;
  return next.replace(GLUED_MISSING_PERCENT, "не рассчитана");
}

export function rateIsMissing(rate: number | null | undefined): boolean {
  return rate == null || !Number.isFinite(rate) || rate <= 0;
}

export function citationHref(
  documentId: string,
  citation: Pick<Citation, "page" | "sheet" | "cell" | "paragraph">,
): string {
  const params = new URLSearchParams();
  if (citation.page) params.set("page", String(citation.page));
  if (citation.sheet) params.set("sheet", citation.sheet);
  if (citation.cell) params.set("cell", citation.cell.split(":")[0] ?? citation.cell);
  if (citation.paragraph) params.set("paragraph", String(citation.paragraph));
  const query = params.toString();
  return `/cabinet/dokumenty/${encodeURIComponent(documentId)}${query ? `?${query}` : ""}`;
}

export const NOTE_BLOCK_TITLES = [
  "Паспорт закупки и тайминг",
  "Условия участия и требования к заявке",
  "Сводная ведомость объёмов",
  "Расчёт себестоимости и экономика",
  "Риски и подводные камни",
] as const;

/** Rule gate 7 / 4 / 3. This is not a model score. */
export function readinessFromScore(verdict: number): "достаточно данных" | "данных недостаточно" | "не участвовать" {
  const score = Math.max(0, Math.min(10, Math.round(verdict)));
  if (score >= 7) return "достаточно данных";
  if (score <= 3) return "не участвовать";
  return "данных недостаточно";
}

export function composeAnalyticalNote(input: {
  verdict: number;
  verdictText: string;
  blocks: readonly [string, string, string, string, string];
}): string {
  const label = readinessFromScore(input.verdict);
  return [
    `Готовность к решению: ${label}. ${input.verdictText.trim()}`,
    ...NOTE_BLOCK_TITLES.map((title, index) => `${index + 1}. ${title}\n${input.blocks[index].trim() || "нет данных"}`),
  ].join("\n\n");
}

/**
 * Stored notes may still start with the old score line and the old economics
 * sentences. Show the gate label and the current draft's wording. The stored
 * text is not changed.
 */
export function honestReadinessText(text: string, economics?: MemoCalcState | null): string {
  const readiness = text.replace(/Вердикт(?:\s+ИИ)?:\s*(\d{1,2})\s*\/\s*10(?:\s*[—–-]\s*)?/gu, (_all, score: string) => {
    return `Готовность к решению: ${readinessFromScore(Number(score))}. `;
  });
  const withEconomics = economics
    ? rewriteLegacyEconomics(readiness, economics)
    : readiness.replace(/не рассчитана\s*%/gu, "не рассчитана");
  return tidyDisplayedPunctuation(withEconomics);
}

export const COMPANY_RATE_RULE =
  "Ставки людей берутся по должности, техники — по модели, материалов — по наименованию и единице. Для строк в чел.-ч без ставки в справочнике берётся ставка персонала из параметров расчёта. Если совпадения нет, у строки остаётся «нет ставки»";

const STALE_RATE_RULE = /ставки взяты только из точного совпадения кода и единицы в справочниках|ставка черновика берётся только из точного совпадения справочника/giu;

/** Saved drafts keep the old code-match sentence until the next import. Show the current rule. */
export function refreshRateAssumption(text: string): string {
  return text.replace(STALE_RATE_RULE, COMPANY_RATE_RULE);
}

export function analyticalNoteBlocks(text: string): Array<{ title: string; body: string }> {
  return NOTE_BLOCK_TITLES.map((title, index) => {
    const heading = `${index + 1}. ${title}`;
    const start = text.indexOf(heading);
    if (start < 0) return { title, body: "" };
    const from = start + heading.length;
    let end = text.length;
    for (let next = index + 1; next < NOTE_BLOCK_TITLES.length; next += 1) {
      const at = text.indexOf(`${next + 1}. ${NOTE_BLOCK_TITLES[next]}`, from);
      if (at >= 0) {
        end = at;
        break;
      }
    }
    return { title, body: text.slice(from, end).trim() };
  });
}

export function analyticalNoteStructure(text: string): { verdict: number | null; blocks: string[] } {
  let score: number | null = null;
  if (/Готовность к решению:\s*достаточно данных/u.test(text)) score = 7;
  else if (/Готовность к решению:\s*не участвовать/u.test(text)) score = 3;
  else if (/Готовность к решению:\s*данных недостаточно/u.test(text)) score = 4;
  else {
    const match = text.match(/Вердикт(?:\s+ИИ)?:\s*(\d{1,2})\s*\/\s*10/u);
    const legacy = match ? Number(match[1]) : null;
    score = legacy != null && legacy >= 0 && legacy <= 10 ? legacy : null;
  }
  return {
    verdict: score,
    blocks: NOTE_BLOCK_TITLES.filter((title) => text.includes(title)),
  };
}

export function analysisFailureText(reason: string): string {
  const clean = reason
    .replace(/OCR\s*\([^)]*\)\s*:?/giu, "")
    .replace(/tesseract failed:\s*/giu, "")
    .replace(/\s+/g, " ")
    .trim();
  return `Разбор не выполнен: ${clean || "модель не ответила"}`;
}

export function ocrFailureMessage(reason: string): string {
  const clean = reason
    .replace(/OCR\s*\([^)]*\)\s*:?/giu, "")
    .replace(/tesseract failed:\s*/giu, "")
    .replace(/pdftoppm failed:\s*/giu, "")
    .replace(/\s+/g, " ")
    .trim();
  return `Не удалось распознать скан: ${clean || "распознавание не выполнено"}`;
}

export function ocrPageLimitMessage(read: number, total: number): string {
  return `Прочитано ${read} из ${total} страниц`;
}

/** Drop a numeric claim that is not present in the uploaded text. */
export function groundedStatement(text: string, corpus: string, numbersAreGrounded: (value: string, source: string) => boolean): string {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => (/\d/u.test(sentence) && !numbersAreGrounded(sentence, corpus) ? "нет данных" : sentence))
    .join(" ")
    .replace(/(?:^|\s)нет данных(?:\sнет данных)+/gu, " нет данных")
    .trim();
}

/** A customer question stays only when its quote is in the uploaded documents. */
export function citedQuestion(question: string, corpus: string, numbersAreGrounded: (value: string, source: string) => boolean): string | null {
  const text = question.replace(/\s+/g, " ").trim();
  if (text.length < 12 || text.length > 400) return null;
  if (/\d/u.test(text) && !numbersAreGrounded(text, corpus)) return null;
  const quoted = [...text.matchAll(/«([^»]{8,})»/gu)].map((match) => match[1]);
  if (quoted.length) return quoted.every((part) => corpus.includes(part)) ? text : null;
  const compact = text.toLocaleLowerCase("ru-RU");
  const source = corpus.toLocaleLowerCase("ru-RU");
  for (let index = 0; index + 24 <= compact.length; index += 4) {
    if (source.includes(compact.slice(index, index + 24))) return text;
  }
  return null;
}

export function suppressFalseAbsence(text: string, corpus: string): string {
  const source = corpus.toLocaleLowerCase("ru-RU");
  let next = text;
  if (/срок/u.test(source)) next = next.replace(/срок[^.!\n]{0,80}не указан[а-яё]*/giu, "срок есть в документах");
  if (/материал/u.test(source)) next = next.replace(/материал[^.!\n]{0,80}не указан[а-яё]*/giu, "материалы есть в документах");
  if (/объ[её]м/u.test(source)) next = next.replace(/объ[её]м[^.!\n]{0,80}не указан[а-яё]*/giu, "объёмы есть в документах");
  return next;
}

export function combineEstimateTotals(rows: Array<{ label: string; total: number }>): {
  total: number;
  duplicates: string[];
  discrepancies: string[];
} {
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const label = row.label.trim();
    grouped.set(label, [...(grouped.get(label) ?? []), row.total]);
  }
  let total = 0;
  const duplicates: string[] = [];
  const discrepancies: string[] = [];
  for (const [label, values] of grouped) {
    total += values[0] ?? 0;
    if (values.length > 1) duplicates.push(label);
    const distinct = new Set(values.map((value) => Math.round(value * 100)));
    if (distinct.size > 1) discrepancies.push(`${label}: ${values.join(" и ")}`);
  }
  return { total: Math.round(total * 100) / 100, duplicates, discrepancies };
}

export type VolumeDraftRow = {
  work: string;
  unit: string;
  volume: number;
  quote: string;
  rate: number | null;
};

export function parseVolumeDraft(raw: string): VolumeDraftRow[] {
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text) as { rows?: unknown };
  if (!Array.isArray(parsed.rows)) return [];
  return parsed.rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { work?: unknown; unit?: unknown; volume?: unknown; quote?: unknown };
    const work = typeof row.work === "string" ? row.work.trim() : "";
    const unit = typeof row.unit === "string" ? row.unit.trim() : "";
    const volume = typeof row.volume === "number" ? row.volume : Number(row.volume);
    const quote = typeof row.quote === "string" ? row.quote.trim() : "";
    if (!work || !unit || !quote || !Number.isFinite(volume)) return [];
    return [{ work, unit, volume, quote, rate: null }];
  });
}

export function priceVolumeRows(
  rows: VolumeDraftRow[],
  rateOf: (work: string, unit: string) => number | null,
): VolumeDraftRow[] {
  return rows.map((row) => ({ ...row, rate: rateOf(row.work, row.unit) }));
}

export const NORTH_DEFAULTS = {
  districtCoefficient: 1.8,
  northernPayrollShare: 0.8,
  overheadRate: 0.43,
};

/** Fill the brief's northern defaults when a calculation is formed and a field is still empty. */
export function scheduleParamsWithNorthernDefaults(params?: ResourceScheduleParams): ResourceScheduleParams {
  const base = params ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
  return {
    ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
    ...base,
    districtCoefficient: base.districtCoefficient ?? NORTH_DEFAULTS.districtCoefficient,
    northernPayrollShare: base.northernPayrollShare ?? NORTH_DEFAULTS.northernPayrollShare,
    overheadRate: base.overheadRate ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS.overheadRate,
  };
}

export function foldNorthernEconomics(input: {
  labor: number;
  materials: number;
  equipment: number;
  other?: number;
  profitRate: number;
  params: { districtCoefficient: number; northernPayrollShare: number; overheadRate: number };
}): {
  district: number;
  allowance: number;
  overhead: number;
  direct: number;
  costWithOh: number;
  profit: number;
  total: number;
} {
  const lines = northernAdditionLines(input.labor, input.params);
  const district = lines[0]?.amount ?? 0;
  const allowance = lines[1]?.amount ?? 0;
  const direct = Math.round((input.labor + district + allowance + input.materials + input.equipment + (input.other ?? 0)) * 100) / 100;
  const overhead = Math.round(direct * input.params.overheadRate * 100) / 100;
  const costWithOh = Math.round((direct + overhead) * 100) / 100;
  const profit = Math.round(costWithOh * input.profitRate * 100) / 100;
  return {
    district,
    allowance,
    overhead,
    direct,
    costWithOh,
    profit,
    total: Math.round((costWithOh + profit) * 100) / 100,
  };
}

export function migratePlanEntries<T extends { workName: string; unit: string }>(entries: T[]): T[] {
  return migratePlanBundle({ entries }).entries;
}

/** Split a unit out of a plan row and keep daily facts on the same work. */
export function migratePlanBundle<
  E extends { workName: string; unit: string },
  F extends { workName: string; unit: string },
>(plan: { entries: E[]; dailyFacts?: F[] }): { entries: E[]; dailyFacts: F[] } {
  const renamed = new Map<string, { workName: string; unit: string }>();
  const entries = plan.entries.map((entry) => {
    const split = splitEmbeddedUnit(entry.workName, entry.unit);
    const next = { ...entry, workName: split.workName, unit: split.unit || entry.unit };
    if (next.workName !== entry.workName || next.unit !== entry.unit) {
      renamed.set(`${entry.workName}\u0000${entry.unit}`, { workName: next.workName, unit: next.unit });
    }
    return next;
  });
  const dailyFacts = (plan.dailyFacts ?? []).map((fact) => {
    const fromEntry = renamed.get(`${fact.workName}\u0000${fact.unit}`);
    const split = fromEntry ?? splitEmbeddedUnit(fact.workName, fact.unit);
    const unit = split.unit || fact.unit;
    if (split.workName === fact.workName && unit === fact.unit) return fact;
    return { ...fact, workName: split.workName, unit };
  });
  return { entries, dailyFacts };
}

export function matchDirectorySuppliers<T extends { name: string; materialKeywords: string[] }>(
  material: string,
  suppliers: T[],
): T[] {
  const name = material.toLocaleLowerCase("ru-RU");
  return suppliers.filter((supplier) => (supplier.materialKeywords ?? []).some((keyword) => {
    const needle = keyword.trim().toLocaleLowerCase("ru-RU");
    return needle.length > 1 && name.includes(needle);
  }));
}

/** Plain note for a labour row: northern coefficients and overhead sit in the total, not in the line sum. */
export function labourLineEconomicsNote(input: {
  bucket: "labor" | "materials" | "equipment" | "other";
  rate?: number | null;
  rateMissing?: boolean;
  overheadRate?: number | null;
  districtCoefficient?: number | null;
  northernApplicable?: boolean | null;
}): string | null {
  if (input.bucket !== "labor" || input.rateMissing || !(Number(input.rate) > 0)) return null;
  const overhead = input.overheadRate ?? 0;
  const northern = northernEconomicsApplied({
    applicable: input.northernApplicable,
    districtCoefficient: input.districtCoefficient,
  });
  if (!northern && !(overhead > 0)) return null;
  const overheadText = overhead > 0 ? `накладные ${Math.round(overhead * 100)}%` : "";
  if (northern && overheadText) return `В итог по этой строке входят районный коэффициент, северная надбавка и ${overheadText}`;
  if (northern) return "В итог по этой строке входят районный коэффициент и северная надбавка";
  return `В итог по этой строке входят ${overheadText}`;
}

/** True when the district coefficient is actually folded into the total. */
export function northernEconomicsApplied(input: {
  applicable?: boolean | null;
  districtCoefficient?: number | null;
}): boolean {
  return input.applicable !== false
    && input.districtCoefficient != null
    && Number.isFinite(input.districtCoefficient);
}

export function northernStatusText(input: {
  applicable?: boolean | null;
  districtCoefficient?: number | null;
  northernPayrollShare?: number | null;
}): string {
  if (!northernEconomicsApplied(input)) return "Северные затраты отключены";
  const coefficient = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(input.districtCoefficient as number);
  const share = Math.round((input.northernPayrollShare ?? NORTH_DEFAULTS.northernPayrollShare) * 100);
  return `Применены северные условия: районный коэффициент ${coefficient} и надбавка ${share}% фонда оплаты труда`;
}

export function northernAdditionLines(
  labor: number,
  params: { districtCoefficient: number; northernPayrollShare: number; overheadRate: number } = NORTH_DEFAULTS,
): Array<{ what: string; amount: number; why: string }> {
  const safeLabor = Number.isFinite(labor) && labor > 0 ? labor : 0;
  const district = Math.round(safeLabor * (params.districtCoefficient - 1) * 100) / 100;
  const allowance = Math.round(safeLabor * params.northernPayrollShare * 100) / 100;
  const overhead = Math.round((safeLabor + district + allowance) * params.overheadRate * 100) / 100;
  return [
    { what: "Районный коэффициент", amount: district, why: `коэффициент ${params.districtCoefficient} увеличивает оплату труда` },
    { what: "Северная надбавка", amount: allowance, why: `${Math.round(params.northernPayrollShare * 100)}% фонда оплаты труда` },
    { what: "Накладные", amount: overhead, why: `${Math.round(params.overheadRate * 100)}% к оплате труда с надбавками` },
  ];
}

export function dependencyWouldCycle(
  stages: Array<{ id: string; dependsOn?: string | null }>,
  stageId: string,
  dependsOn: string,
): boolean {
  if (stageId === dependsOn) return true;
  const next = new Map(stages.map((stage) => [stage.id, stage.dependsOn ?? undefined]));
  next.set(stageId, dependsOn);
  const seen = new Set<string>();
  let cursor: string | undefined = stageId;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = next.get(cursor);
  }
  return false;
}

function addIsoDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function inclusiveDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 1;
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

/** Finish-to-start: the next work begins the day after the previous one ends. */
export function scheduleAfterPredecessor(predecessorEnd: string, durationDays: number): { start: string; end: string } {
  const start = addIsoDays(predecessorEnd, 1);
  return { start, end: addIsoDays(start, Math.max(1, durationDays) - 1) };
}

export function planWorksOnDate<T extends { start: string; end: string }>(stages: T[], date: string): T[] {
  return stages.filter((stage) => stage.start <= date && date <= stage.end);
}

export function splitEmbeddedUnit(workName: string, unit: string): { workName: string; unit: string } {
  const cleanUnit = unit.trim();
  const cleanName = workName.trim();
  if (cleanUnit) return { workName: cleanName, unit: cleanUnit };
  const match = cleanName.match(/^(.*?)(?:\s*[,—(]\s*)(м2|м²|м3|м³|п\.м\.?|шт|компл|чел\.?-?ч|маш\.?-?ч|т|м)\s*\)?$/iu);
  if (!match) return { workName: cleanName, unit: "" };
  return { workName: match[1].trim().replace(/[,—\s]+$/u, ""), unit: match[2] };
}

export function completedWorkCost(factQty: number, rate: number | null | undefined): number | null {
  if (!Number.isFinite(factQty) || rateIsMissing(rate)) return null;
  return Math.round(factQty * (rate as number) * 100) / 100;
}

export function mergeQuantities<T extends { name: string; unit: string; quantity: number }>(rows: T[]): T[] {
  const order: string[] = [];
  const groups = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.name.trim().toLocaleLowerCase("ru-RU")}|${row.unit.trim().toLocaleLowerCase("ru-RU")}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row });
      order.push(key);
    } else {
      existing.quantity = Math.round((existing.quantity + row.quantity) * 1000) / 1000;
    }
  }
  return order.map((key) => groups.get(key)!);
}

export function quoteRequestOutcome(mailLive: boolean): { sent: boolean; status: string; message: string } {
  if (mailLive) return { sent: true, status: "отправлено", message: "Письмо отправлено" };
  return {
    sent: false,
    status: "не отправлено",
    message: "Письмо не отправлено: почта не подключена. Файл запроса сохранён/скачайте его",
  };
}

/** User-facing procurement text: no vendor name, no API, no internal ids. */
export function neutralizeProcurementJargon(detail: string): string {
  return detail
    .replace(/ID закупки Контура/giu, "номер закупки")
    .replace(/Документ API/giu, "файл")
    .replace(/Контур(?:\.Закупки)?\s*API/giu, "поиск закупок")
    .replace(/API-ключ\w*/giu, "ключ доступа")
    .replace(/Ключ Контура/giu, "Поиск закупок")
    .replace(/Контур(?:а|у|ом|е)?/giu, "источник закупок")
    .replace(/\bAPI\b[-\s]*/giu, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

export function sanitizeSyncDetail(detail: string): string {
  const clean = detail
    .replace(/(?:api[_-]?key|token|bearer|password|secret)\s*[:=]\s*\S+/giu, "ключ скрыт")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "…");
  if (/429|лимит запросов/iu.test(clean)) return "Достигнут лимит запросов (429). Повтор будет позже.";
  if (/401/u.test(clean)) return "Источник отклонил доступ (401).";
  if (/timeout|таймаут|ETIMEDOUT|AbortError/iu.test(clean)) return "Таймаут при обращении к источнику.";
  const http = clean.match(/HTTP\s*(\d{3})/iu);
  if (http && http[1].startsWith("5")) return `Источник временно недоступен (код ${http[1]}).`;
  if (http) return `Источник вернул код ${http[1]}.`;
  return neutralizeProcurementJargon(clean).slice(0, 240);
}

export function shouldRetrySync(detail: string, status?: number): boolean {
  if (status === 429 || (status != null && status >= 500 && status <= 599)) return true;
  return /429|таймаут|timeout|ETIMEDOUT|HTTP\s*5\d\d|\b5\d\d\b/iu.test(detail);
}

export const CONTRACT_CHECKLIST = [
  "Штрафы и неустойка",
  "Сроки",
  "Порядок оплаты и аванс",
  "Приёмка",
  "Гарантия",
  "Одностороннее расторжение",
  "Обеспечение",
  "Субподряд",
  "Изменение цены",
] as const;

export type ContractChecklistHit = {
  item: string;
  severity: "low" | "medium" | "high";
  quote: string;
};

export function parseContractChecklist(raw: string, corpus: string): { items: ContractChecklistHit[]; error?: string } {
  try {
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(text) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return { items: [], error: "Разбор договора не выполнен: ответ без чек-листа" };
    const items = parsed.items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as { item?: unknown; severity?: unknown; quote?: unknown };
      const title = typeof row.item === "string" ? row.item.trim() : "";
      const quote = typeof row.quote === "string" ? row.quote.trim() : "";
      const severity: ContractChecklistHit["severity"] = row.severity === "high" || row.severity === "medium" || row.severity === "low" ? row.severity : "medium";
      if (!title || quote.length < 8 || !corpus.includes(quote)) return [];
      return [{ item: title, severity, quote }];
    });
    return { items };
  } catch {
    return { items: [], error: "Разбор договора не выполнен: ответ не разобран" };
  }
}

export function worksForDay(stages: GprStage[], date: string): Array<{ name: string; unit: string; start: string; end: string }> {
  return planWorksOnDate(stages, date).map((stage) => ({
    name: stage.workName?.trim() || stage.name,
    unit: stage.planUnit?.trim() || "",
    start: stage.start,
    end: stage.end,
  }));
}
