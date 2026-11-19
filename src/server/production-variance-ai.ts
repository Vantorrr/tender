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
      const expectedKind = source.kind === "daily_comment" ? "documented_reason" : "possible_factor";
      const text = item.text.trim();
      const sourceQuote = item.sourceQuote.trim();
      const corpus = `${source.text}\n${numericContext}`;
      if (item.kind !== expectedKind || text.length > 500 || !numbersAreGrounded(text, corpus) ||
          sourceQuote.length < 8 || !source.text.includes(sourceQuote) ||
          !enoughLexicalSupport(text, sourceQuote)) continue;
      observations.push({ sourceId: source.id, kind: expectedKind, text, sourceQuote });
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
  return JSON.stringify({
    project: input.title,
    period: input.period,
    workName: input.workName,
    plannedQuantity: input.planQuantity,
    factQuantity: input.factQuantity,
    gap: input.factQuantity - input.planQuantity,
    sources: input.sources,
  });
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
    return {
      status: gap === 0 ? "on_track" : "reason_unknown",
      summary: gap === 0
        ? "Отклонения по объёму нет. Дополнительных записей о причинах не требуется."
        : "В дневных отчётах нет записанной причины отклонения и нет просроченных поставок. Добавьте комментарий к факту работ, чтобы разбор опирался на данные объекта.",
      observations: [],
      disclaimer: "Причина не установлена: в исходных данных нет подтверждающих записей.",
    };
  }
  const numericContext = `${input.planQuantity} ${input.factQuantity} ${input.factQuantity - input.planQuantity}`;
  const response = await completeJson(SYSTEM, buildProductionVarianceUserContent({
    title: input.plan.title,
    period: input.periodLabel,
    workName: input.workName,
    planQuantity: input.planQuantity,
    factQuantity: input.factQuantity,
    sources,
  }));
  const validated = validateProductionVarianceResult(response, sources, numericContext);
  return {
    status,
    ...validated,
    disclaimer: "Причины показаны только по комментариям; просроченные материалы — возможные факторы. Если фактов недостаточно, причина остаётся неустановленной.",
  };
}
