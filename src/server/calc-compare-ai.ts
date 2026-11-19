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
export const COMPARE_FINDING_LIMIT = 12;
const COMPARE_MAX_TOKENS = 4000;

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
  const seen = new Set<string>();
  const unique = findings.filter((finding) => {
    if (seen.has(finding.rowId)) return false;
    seen.add(finding.rowId);
    return true;
  });
  const summaryCorpus = context?.summaryCorpus ?? rows.map((row) => row.factsText).join("\n");
  return {
    summary: summary && summary.length <= 900 && numbersAreGrounded(summary, summaryCorpus)
      ? summary
      : "Модель не сформировала краткое наблюдение, прошедшее проверку.",
    findings: unique.slice(0, COMPARE_FINDING_LIMIT),
  };
}

export function compareClusterKey(name: string, unit: string): string {
  const normalized = name.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const numbers = [...normalized.matchAll(/\d+(?:[.,]\d+)?/gu)].map((match) => match[0].replace(",", ".")).join(",");
  const words = normalized.replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/u).filter((word) => word.length >= 4 && !/^\d+$/u.test(word));
  return `${words.slice(0, 3).join(" ")}|${numbers}|${unit.toLocaleLowerCase("ru-RU").replace(/ё/g, "е")}`;
}

export type CompareGroupInput = {
  rowId: string;
  name: string;
  unit: string;
  section: string;
  status: string;
  factsText: string;
  originalSum: number | null;
  draftSum: number | null;
  deltaSum: number | null;
};

export function rowImpact(row: Pick<CompareGroupInput, "status" | "deltaSum" | "originalSum" | "draftSum">): number {
  if (row.deltaSum != null) return row.deltaSum;
  if (row.status === "only_original") return -(row.originalSum ?? 0);
  if (row.status === "only_draft") return row.draftSum ?? 0;
  return 0;
}

export function groupCompareRows(rows: CompareGroupInput[]) {
  const groups = new Map<string, CompareGroupInput[]>();
  for (const row of rows) {
    const key = `${row.section}\u0001${compareClusterKey(row.name, row.unit)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((members) => {
    const ranked = [...members].sort((left, right) => Math.abs(rowImpact(right)) - Math.abs(rowImpact(left)));
    const primary = ranked[0]!;
    const impact = Math.round(members.reduce((sum, row) => sum + rowImpact(row), 0) * 100) / 100;
    const factsText = members.length === 1
      ? primary.factsText
      : `${members.map((row) => row.factsText).join(" | ")}; Сведено строк: ${members.length}; Суммарная разница группы: ${impact}`;
    return {
      rowId: primary.rowId,
      rowIds: members.map((row) => row.rowId),
      name: primary.name,
      section: primary.section || "Без раздела",
      impact,
      factsText,
    };
  });
}

export function selectMaterialGroups<T extends { impact: number }>(groups: T[], limit = COMPARE_FINDING_LIMIT) {
  const ranked = [...groups].sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact));
  const largest = Math.abs(ranked[0]?.impact ?? 0);
  const threshold = largest > 0 ? Math.round(largest * 0.05 * 100) / 100 : 0;
  return {
    threshold,
    groups: ranked.filter((group) => group.impact !== 0 && Math.abs(group.impact) >= threshold).slice(0, limit),
  };
}

const EXCLUSIVE_DRAFT_LIMIT = 4;

/** Absolute money for the compare summary: «172 204 022,31 руб.», never a minus. */
export function formatCompareMoney(amount: number): string {
  const formatted = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Math.abs(amount))
    .replace(/[\u00a0\u202f\u2009]/g, " ");
  return `${formatted} руб.`;
}

function rewriteTotal(text: string, amount: number, label: string): string {
  const [whole, frac = ""] = String(Math.abs(amount)).split(".");
  const grouped = whole.replace(/(\d)(?=(\d{3})+$)/g, "$1[\\s\\u00a0\\u202f\\u2009]?");
  const decimal = frac ? `(?:[.,]${frac})?` : "";
  const pattern = new RegExp(`(?:[-−–]\\s*)?${grouped}${decimal}(?!\\d)(?:\\s*руб\\.?)?`, "gu");
  return text.replace(pattern, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits !== `${whole}${frac}` && digits !== whole) return match;
    return label;
  }).replace(/руб\.\./g, "руб.");
}

export function ensureCompareSummary(summary: string, deltaTotal: number | null, exclusiveDraft: string[] = [], exclusiveDraftMore = 0): string {
  let text = summary.trim();
  if (deltaTotal != null && Number.isFinite(deltaTotal)) {
    const label = formatCompareMoney(deltaTotal);
    const lead = deltaTotal < 0
      ? `Черновик дешевле сметы заказчика на ${label}, потому что расхождения разобраны ниже.`
      : deltaTotal > 0
        ? `Черновик дороже сметы заказчика на ${label}, потому что расхождения разобраны ниже.`
        : "Черновик совпадает со сметой заказчика по итогу.";
    text = rewriteTotal(text, deltaTotal, label);
    const hasLabel = text.replace(/[\s\u00a0\u202f\u2009]/g, "").includes(label.replace(/[\s\u00a0\u202f\u2009]/g, ""));
    const startsWithPhrase = /^[A-Za-zА-Яа-яЁё«"]/u.test(text);
    if (!hasLabel) text = startsWithPhrase ? `${lead} ${text}` : lead;
    else if (!startsWithPhrase) {
      const rest = text.replace(/^[\s\d.,]+руб\.?\s*/u, "").trim();
      text = rest ? `${lead} ${rest}` : lead;
    }
  }
  const missing = exclusiveDraft.filter((name) => {
    const probe = name.trim().toLocaleLowerCase("ru-RU").slice(0, 40);
    return probe.length >= 8 && !text.toLocaleLowerCase("ru-RU").includes(probe);
  }).slice(0, EXCLUSIVE_DRAFT_LIMIT);
  const hidden = exclusiveDraftMore + Math.max(0, exclusiveDraft.length - EXCLUSIVE_DRAFT_LIMIT);
  if (missing.length) {
    const tail = hidden > 0 ? ` и ещё ${hidden}` : "";
    text = `${text} Только в черновике: ${missing.join("; ")}${tail}.`.trim();
  }
  return text.trim();
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
  draft: Calculation | null
) {
  const comparison = compareCalculations(original, draft);
  const rows: CompareGroupInput[] = comparison.rows.map((row, index) => ({
    rowId: `row-${index + 1}`,
    name: row.name,
    unit: row.unit,
    section: row.sectionName?.trim() || row.workName?.trim() || "Без раздела",
    status: row.status,
    factsText: makeFactsText(row),
    originalSum: row.originalSum,
    draftSum: row.draftSum,
    deltaSum: row.deltaSum,
  }));
  const grouped = groupCompareRows(rows);
  const material = selectMaterialGroups(grouped);
  const sections = new Map<string, { rowCount: number; impact: number }>();
  for (const group of grouped) {
    const current = sections.get(group.section) ?? { rowCount: 0, impact: 0 };
    current.rowCount += group.rowIds.length;
    current.impact = Math.round((current.impact + group.impact) * 100) / 100;
    sections.set(group.section, current);
  }
  const pricingText = pricingTextForCompare(draft, original);
  const allExclusiveDraft = [...new Set(rows.filter((row) => row.status === "only_draft").map((row) => row.name))];
  const exclusiveDraft = allExclusiveDraft.slice(0, EXCLUSIVE_DRAFT_LIMIT);
  const exclusiveDraftMore = Math.max(0, allExclusiveDraft.length - exclusiveDraft.length);
  const user = JSON.stringify({
    totals: comparison.totals,
    pricingText,
    notes: comparison.notes,
    coverage: {
      rowsTotal: rows.length,
      groupsTotal: grouped.length,
      groupsInDetail: material.groups.length,
      threshold: material.threshold,
      rule: "В детализацию попали группы с модулем разницы не ниже порога, не больше 12. Одинаковая позиция сведена в одну группу.",
    },
    exclusiveDraft,
    exclusiveDraftMore,
    sections: [...sections.entries()].map(([name, value]) => ({ name, rowCount: value.rowCount, impact: value.impact })),
    materialGroups: material.groups.map((group) => ({
      rowId: group.rowId,
      rowIds: group.rowIds,
      name: group.name,
      section: group.section,
      impact: group.impact,
      factsText: group.factsText,
    })),
  });
  const detail = material.groups.map((group) => group.factsText).join("\n");
  const summaryCorpus = `${pricingText}\n${JSON.stringify(comparison.totals)}\n${detail}`;
  return {
    system: SYSTEM,
    user,
    batch: material.groups.map((group) => ({ rowId: group.rowId, factsText: group.factsText })),
    rowsTotal: rows.length,
    deltaTotal: comparison.totals.deltaTotal,
    exclusiveDraft,
    exclusiveDraftMore,
    context: { summaryCorpus, sharedFacts: pricingText },
  };
}

export async function analyzeCalculationComparisonWithAI(
  original: Calculation | null,
  draft: Calculation | null
): Promise<CalcCompareAiReport> {
  const comparison = compareCalculations(original, draft);
  const prepared = buildCalcCompareBatch(original, draft);
  const rowsTotal = prepared.rowsTotal;
  const validated = rowsTotal === 0
    ? { summary: "Нет строк для анализа.", findings: [] }
    : validateCalcCompareAiResult(
      await completeJson(prepared.system, prepared.user, 0, { maxTokens: COMPARE_MAX_TOKENS }),
      prepared.batch,
      prepared.context
    );
  const summary = ensureCompareSummary(validated.summary, prepared.deltaTotal, prepared.exclusiveDraft, prepared.exclusiveDraftMore);
  const findings = validated.findings;
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
    batches: rowsTotal === 0 ? 0 : 1,
    overall,
    summary,
    findings: findings.map((finding) => ({
      ...finding,
      sourceExcerpt: finding.sourceExcerpt,
    })),
    disclaimer: "Комментарий объясняет уже посчитанные расхождения. Числа взяты из строк сравнения и правил расчёта. Нормативную базу этот разбор не проверяет.",
  };
}
