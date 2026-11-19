import type { Citation, GprStage } from "@/lib/types";

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
  "Экономика",
  "Риски и подводные камни",
] as const;

export function composeAnalyticalNote(input: {
  verdict: number;
  verdictText: string;
  blocks: readonly [string, string, string, string, string];
}): string {
  const score = Math.max(0, Math.min(10, Math.round(input.verdict)));
  return [
    `Вердикт: ${score}/10. ${input.verdictText.trim()}`,
    ...NOTE_BLOCK_TITLES.map((title, index) => `${index + 1}. ${title}\n${input.blocks[index].trim() || "нет данных"}`),
  ].join("\n\n");
}

export function analyticalNoteStructure(text: string): { verdict: number | null; blocks: string[] } {
  const match = text.match(/Вердикт:\s*(\d{1,2})\s*\/\s*10/u);
  const score = match ? Number(match[1]) : null;
  return {
    verdict: score != null && score >= 0 && score <= 10 ? score : null,
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
  return clean.replace(/Контур(?:\.Закупки)?\s*API/giu, "поиск закупок").slice(0, 240);
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
