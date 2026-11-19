import type { DailyFact, PlanFact, SupplyRequest } from "@/lib/types";
import type { PlanSliceMode } from "@/lib/plan-from-gpr";
import { numbersAreGrounded } from "@/server/ai-grounding";
import { PRODUCTION_VARIANCE_SYSTEM } from "@/server/ai-prompts";
import { completeJson } from "@/server/openrouter";

export type ProductionVarianceReport = {
  status: "behind" | "ahead" | "on_track" | "reason_unknown";
  summary: string;
  observations: Array<{
    sourceId: string;
    kind: "documented_reason" | "possible_factor";
    text: string;
    sourceQuote: string;
  }>;
  disclaimer: string;
};

type Source = { id: string; kind: "daily_comment" | "supplier_delay"; text: string };

const SYSTEM = PRODUCTION_VARIANCE_SYSTEM;

function parseJson(raw: string): unknown {
  return JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

function normalizeWords(value: string): string[] {
  return value.toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .match(/[а-яa-z]{4,}/gu) ?? [];
}

function enoughLexicalSupport(text: string, quote: string): boolean {
  const claimWords = normalizeWords(text);
  const sourceWords = new Set(normalizeWords(quote));
  if (!claimWords.length) return false;
  const overlap = claimWords.filter((word) => sourceWords.has(word)).length;
  return overlap / claimWords.length >= 0.3;
}

export function deviationPercent(plan: number, fact: number): number | null {
  if (!Number.isFinite(plan) || plan === 0) return null;
  return Math.round((Math.abs(fact - plan) / Math.abs(plan)) * 1000) / 10;
}

/** A documented reason has to sit in the daily comment itself, not in the date or work header. */
export function commentStatesReason(sourceText: string, quote: string): boolean {
  const marker = sourceText.toLocaleLowerCase("ru-RU").indexOf("комментарий:");
  const comment = (marker >= 0 ? sourceText.slice(marker + "комментарий:".length) : sourceText).trim();
  if (comment.length < 12 || !comment.includes(quote)) return false;
  return enoughLexicalSupport(quote, comment);
}

export function filterDailyFactsByPeriod(
  daily: DailyFact[],
  asOfDate: string,
  period: PlanSliceMode
): DailyFact[] {
  return daily.filter((fact) => {
    if (period === "day") return fact.date === asOfDate;
    if (period === "month") return fact.date.startsWith(asOfDate.slice(0, 7));
    if (period === "cum") return fact.date <= asOfDate;
    return true;
  });
}

export function filterDailyFactsByWork(daily: DailyFact[], workName: string): DailyFact[] {
  const key = workName.trim();
  return key ? daily.filter((fact) => fact.workName.trim() === key) : [];
}

export function validateProductionVarianceResult(raw: string, sources: Source[], numericContext = "") {
  const parsed = parseJson(raw) as { summary?: unknown; observations?: unknown };
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const byId = new Map(sources.map((source) => [source.id, source]));
  const observations: ProductionVarianceReport["observations"] = [];
  if (Array.isArray(parsed.observations)) {
    for (const candidate of parsed.observations.slice(0, 12)) {
      if (!candidate || typeof candidate !== "object") continue;
      const item = candidate as Record<string, unknown>;
      if (typeof item.sourceId !== "string" || typeof item.kind !== "string" ||
          typeof item.text !== "string" || typeof item.sourceQuote !== "string") continue;
      const source = byId.get(item.sourceId);
      if (!source) continue;
      if (item.kind !== "documented_reason" && item.kind !== "possible_factor") continue;
      if (item.kind === "documented_reason" && source.kind !== "daily_comment") continue;
      const text = item.text.trim();
      const sourceQuote = item.sourceQuote.trim();
      const corpus = `${source.text}\n${numericContext}`;
      if (text.length > 500 || !numbersAreGrounded(text, corpus) ||
          sourceQuote.length < 8 || !source.text.includes(sourceQuote) ||
          !enoughLexicalSupport(text, sourceQuote)) continue;
      const documented = item.kind === "documented_reason" && commentStatesReason(source.text, sourceQuote);
      observations.push({
        sourceId: source.id,
        kind: documented ? "documented_reason" : "possible_factor",
        text: documented || item.kind === "possible_factor" || /причина не указана в отчётах/u.test(text)
          ? text
          : `${text} Причина не указана в отчётах.`,
        sourceQuote,
      });
    }
  }
  const summaryCorpus = `${sources.map((source) => source.text).join("\n")}\n${numericContext}`;
  return {
    summary: summary && summary.length <= 800 && numbersAreGrounded(summary, summaryCorpus)
      ? summary
      : "Модель не сформировала краткий вывод, прошедший проверку источников.",
    observations,
  };
}

function collectSources(
  daily: DailyFact[],
  supplies: SupplyRequest[],
  asOfDate: string,
  period: PlanSliceMode,
  workName: string
): Source[] {
  const periodFacts = filterDailyFactsByWork(
    filterDailyFactsByPeriod(daily, asOfDate, period),
    workName
  );
  const comments: Source[] = periodFacts
    .filter((fact) => fact.comment?.trim())
    .slice(-30)
    .map((fact) => ({
      id: `fact-${fact.id}`,
      kind: "daily_comment",
      text: `Дата: ${fact.date}; работа: ${fact.workName.slice(0, 180)}; комментарий: ${fact.comment!.trim().slice(0, 1200)}`,
    }));
  const delayed: Source[] = supplies
    .filter((supply) => supply.needBy < asOfDate && !["delivered", "accepted", "cancelled"].includes(supply.status))
    .slice(0, 20)
    .map((supply) => ({
      id: `supply-${supply.id}`,
      kind: "supplier_delay",
      text: `Материал: ${supply.materialName.slice(0, 120)}; требуется к ${supply.needBy}; статус: ${supply.status}; работа: ${(supply.workName ?? "не связана").slice(0, 120)}`,
    }));
  return [...comments, ...delayed];
}

export function buildProductionVarianceUserContent(input: {
  title: string;
  period: string;
  workName: string;
  planQuantity: number;
  factQuantity: number;
  sources: Source[];
}): string {
  const gap = input.factQuantity - input.planQuantity;
  return JSON.stringify({
    project: input.title,
    period: input.period,
    workName: input.workName,
    plannedQuantity: input.planQuantity,
    factQuantity: input.factQuantity,
    gap,
    gapPercent: deviationPercent(input.planQuantity, input.factQuantity),
    sources: input.sources,
  });
}

export function withRequiredDeviation(input: {
  summary: string;
  observations: ProductionVarianceReport["observations"];
  plan: number;
  fact: number;
  sources: Source[];
}): Pick<ProductionVarianceReport, "summary" | "observations"> {
  const percent = deviationPercent(input.plan, input.fact);
  const gap = input.fact - input.plan;
  if (percent == null || gap === 0) return { summary: input.summary, observations: input.observations };
  const direction = gap < 0 ? "Отставание" : "Опережение";
  const summary = numbersAreGrounded(String(percent), input.summary)
    ? input.summary
    : `${direction} ${percent}% от плана. ${input.summary}`.trim();
  if (input.observations.length) {
    const named = input.observations.some((item) => numbersAreGrounded(String(percent), item.text));
    return {
      summary,
      observations: named ? input.observations : input.observations.map((item, index) => index === 0
        ? { ...item, text: `${direction} ${percent}% от плана. ${item.text}` }
        : item),
    };
  }
  const source = input.sources.find((item) => item.text.trim().length >= 12);
  if (!source) {
    return {
      summary: `${summary} Причина не указана в отчётах.`.trim(),
      observations: [],
    };
  }
  return {
    summary,
    observations: [{
      sourceId: source.id,
      kind: "possible_factor",
      text: `${direction} ${percent}% от плана. Причина не указана в отчётах.`,
      sourceQuote: source.text.slice(0, 180),
    }],
  };
}

export async function analyzeProductionVarianceWithAI(input: {
  plan: PlanFact;
  supplies: SupplyRequest[];
  asOfDate: string;
  periodLabel: PlanSliceMode;
  planQuantity: number;
  factQuantity: number;
  planSource: "stage_volumes" | "uniform_fallback" | "none";
  workName: string;
}): Promise<ProductionVarianceReport> {
  const gap = input.factQuantity - input.planQuantity;
  const status: ProductionVarianceReport["status"] = gap < 0
    ? "behind"
    : gap > 0
      ? "ahead"
      : "on_track";
  const sources = collectSources(
    input.plan.dailyFacts ?? [],
    input.supplies,
    input.asOfDate,
    input.periodLabel,
    input.workName
  );
  if (input.planSource === "none") {
    return {
      status: "reason_unknown",
      summary: "Для выбранного среза нет календарного плана из ГПР, поэтому отклонение и его причина не рассчитываются.",
      observations: [],
      disclaimer: "Сначала проверьте календарь и объёмы ГПР для проекта.",
    };
  }
  if (!sources.length) {
    const filled = withRequiredDeviation({
      summary: gap === 0
        ? "Отклонения по объёму нет. Дополнительных записей о причинах не требуется."
        : "В дневных отчётах нет записанной причины отклонения и нет просроченных поставок.",
      observations: [],
      plan: input.planQuantity,
      fact: input.factQuantity,
      sources: [],
    });
    return {
      status: gap === 0 ? "on_track" : "reason_unknown",
      ...filled,
      disclaimer: "Причина не установлена: в исходных данных нет подтверждающих записей.",
    };
  }
  const percent = deviationPercent(input.planQuantity, input.factQuantity);
  const numericContext = `${input.planQuantity} ${input.factQuantity} ${gap} ${percent ?? ""}`;
  const response = await completeJson(SYSTEM, buildProductionVarianceUserContent({
    title: input.plan.title,
    period: input.periodLabel,
    workName: input.workName,
    planQuantity: input.planQuantity,
    factQuantity: input.factQuantity,
    sources,
  }));
  const validated = validateProductionVarianceResult(response, sources, numericContext);
  const filled = withRequiredDeviation({
    ...validated,
    plan: input.planQuantity,
    fact: input.factQuantity,
    sources,
  });
  return {
    status,
    ...filled,
    disclaimer: "Причины показаны только по комментариям; просроченные материалы — возможные факторы. Если фактов недостаточно, причина остаётся неустановленной.",
  };
}
