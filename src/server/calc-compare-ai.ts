import type { CalcCompareRow, Calculation } from "@/lib/types";
import { compareCalculations } from "@/lib/calc-compare";
import { NOT_IN_DOCUMENTS, numbersAreGrounded } from "@/server/ai-grounding";
import { CALC_COMPARE_SYSTEM } from "@/server/ai-prompts";
import { completeJson } from "@/server/openrouter";

export type CalcCompareAiReport = {
  rowsAnalyzed: number;
  rowsTotal: number;
  batches: number;
  overall: "review_required" | "no_material_differences" | "insufficient_data";
  summary: string;
  findings: Array<{
    rowId: string;
    text: string;
    sourceExcerpt: string;
  }>;
  disclaimer: string;
};

type ModelFinding = { rowId: string; text: string; sourceExcerpt: string };

const SYSTEM = CALC_COMPARE_SYSTEM;
const BATCH_SIZE = 80;

function parseJson(raw: string): unknown {
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(text);
}

export function validateCalcCompareAiResult(
  raw: string,
  rows: Array<{ rowId: string; factsText: string }>,
  context?: { summaryCorpus?: string; sharedFacts?: string }
): Pick<CalcCompareAiReport, "summary" | "findings"> {
  const parsed = parseJson(raw) as {
    summary?: unknown;
    findings?: unknown;
  };
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const rowMap = new Map(rows.map((row) => [row.rowId, row.factsText]));
  const findings: ModelFinding[] = [];
  if (Array.isArray(parsed.findings)) {
    for (const candidate of parsed.findings.slice(0, 12)) {
      if (!candidate || typeof candidate !== "object") continue;
      const item = candidate as Partial<ModelFinding>;
      const factsText = typeof item.rowId === "string" ? rowMap.get(item.rowId) : undefined;
      if (!factsText || typeof item.text !== "string" || typeof item.sourceExcerpt !== "string") continue;
      const text = item.text.trim();
      const sourceExcerpt = item.sourceExcerpt.trim();
      const rowCorpus = `${factsText}\n${context?.sharedFacts ?? ""}`;
      if (
        !text || text.length > 700 || !numbersAreGrounded(text, rowCorpus) ||
        sourceExcerpt.length < 8 || !factsText.includes(sourceExcerpt)
      ) continue;
      findings.push({ rowId: item.rowId!, text, sourceExcerpt });
    }
  }
  const summaryCorpus = context?.summaryCorpus ?? rows.map((row) => row.factsText).join("\n");
  return {
    summary: summary && summary.length <= 900 && numbersAreGrounded(summary, summaryCorpus)
      ? summary
      : "Модель не сформировала краткое наблюдение, прошедшее проверку.",
    findings,
  };
}

export function pricingTextForCompare(draft: Calculation | null, original: Calculation | null): string {
  const params = draft?.resourceScheduleParams ?? original?.resourceScheduleParams;
  const lines: string[] = [];
  if (params) {
    const overheadPercent = Math.round(params.overheadRate * 10000) / 100;
    const profitPercent = Math.round(params.profitMarkupOnCostWithOh * 10000) / 100;
    lines.push(`Накладные: ${overheadPercent}% от прямых затрат.`);
    lines.push(`Прибыль: ${profitPercent}% от себестоимости с накладными. X — это прямые затраты плюс накладные.`);
  } else {
    lines.push(`Процент накладных: ${NOT_IN_DOCUMENTS}.`);
    lines.push(`Процент прибыли: ${NOT_IN_DOCUMENTS}.`);
  }
  const slices = draft?.costSummary?.resourceSlices;
  if (slices) {
    lines.push(`Прямые затраты черновика: ${slices.direct} ₽.`);
    lines.push(`Накладные черновика: ${slices.overhead} ₽.`);
    lines.push(`Себестоимость с накладными X: ${slices.costWithOh} ₽.`);
    lines.push(`Прибыль от X: ${slices.profit} ₽.`);
  }
  if (draft?.costSummary) {
    lines.push(`Резерв черновика: ${draft.costSummary.reserve} ₽.`);
    lines.push(`Прибыль черновика по итогу: ${draft.costSummary.profit} ₽.`);
  } else {
    lines.push(`Резерв: ${NOT_IN_DOCUMENTS}.`);
  }
  return lines.join(" ");
}

function makeFactsText(row: CalcCompareRow): string {
  return [
    `Код: ${row.code}`,
    `Позиция: ${row.name}`,
    `Единица: ${row.unit || "не указана"}`,
    `Состояние: ${row.status}`,
    `Причина сравнения: ${row.reason}`,
    `Объём заказчика: ${row.originalQty ?? "нет данных"}`,
    `Объём черновика: ${row.draftQty ?? "нет данных"}`,
    `Ставка заказчика: ${row.originalRate ?? "нет данных"}`,
    `Ставка черновика: ${row.draftRate ?? "нет данных"}`,
    `Сумма заказчика: ${row.originalSum ?? "нет данных"}`,
    `Сумма черновика: ${row.draftSum ?? "нет данных"}`,
    `Разница: ${row.deltaSum ?? "нет данных"}`,
  ].join("; ");
}

export function buildCalcCompareBatch(
  original: Calculation | null,
  draft: Calculation | null,
  offset = 0
) {
  const comparison = compareCalculations(original, draft);
  const rows = comparison.rows.map((row, index) => ({
    rowId: `row-${index + 1}`,
    factsText: makeFactsText(row),
  }));
  const batch = rows.slice(offset, offset + BATCH_SIZE);
  const pricingText = pricingTextForCompare(draft, original);
  const user = JSON.stringify({
    totals: comparison.totals,
    pricingText,
    notes: comparison.notes,
    rowRange: { from: offset + 1, to: offset + batch.length, total: rows.length },
    rows: batch,
  });
  const summaryCorpus = `${pricingText}\n${JSON.stringify(comparison.totals)}\n${batch.map((row) => row.factsText).join("\n")}`;
  return {
    system: SYSTEM,
    user,
    batch,
    rowsTotal: rows.length,
    context: { summaryCorpus, sharedFacts: pricingText },
  };
}

export async function analyzeCalculationComparisonWithAI(
  original: Calculation | null,
  draft: Calculation | null
): Promise<CalcCompareAiReport> {
  const comparison = compareCalculations(original, draft);
  const first = buildCalcCompareBatch(original, draft, 0);
  const rowsTotal = first.rowsTotal;
  const batchCount = Math.ceil(rowsTotal / BATCH_SIZE);
  const validatedBatches: Array<Pick<CalcCompareAiReport, "summary" | "findings">> = [];
  for (let offset = 0; offset < rowsTotal; offset += BATCH_SIZE) {
    const batchInput = offset === 0 ? first : buildCalcCompareBatch(original, draft, offset);
    validatedBatches.push(validateCalcCompareAiResult(
      await completeJson(batchInput.system, batchInput.user),
      batchInput.batch,
      batchInput.context
    ));
  }
  const summaries = [...new Set(validatedBatches.map((batch) => batch.summary).filter(Boolean))];
  const summary = summaries.length === 0
    ? "Нет строк для анализа."
    : summaries.length === 1
      ? summaries[0]
      : "Пакетный анализ завершён; выводы по отдельным строкам приведены ниже.";
  const findings = validatedBatches.flatMap((batch) => batch.findings);
  const hasBoth = Boolean(original && draft);
  const hasIncompleteRates = comparison.rows.some((row) => row.status === "incomplete") ||
    comparison.notes.some((note) => note.includes("неподтверждённые ставки"));
  const overall: CalcCompareAiReport["overall"] =
    !hasBoth || !comparison.rows.length || !original?.positions.length || !draft?.positions.length || hasIncompleteRates
    ? "insufficient_data"
    : comparison.rows.every((row) => row.status === "matched") && comparison.totals.deltaTotal === 0
      ? "no_material_differences"
      : "review_required";
  return {
    rowsAnalyzed: rowsTotal,
    rowsTotal,
    batches: batchCount,
    overall,
    summary,
    findings: findings.map((finding) => ({
      ...finding,
      sourceExcerpt: finding.sourceExcerpt,
    })),
    disclaimer: "Комментарий объясняет уже посчитанные расхождения. Числа взяты из строк сравнения и правил расчёта. Нормативную базу этот разбор не проверяет.",
  };
}
