/**
 * Deterministic project-level analytical note.
 * No invented LLM reasons, no accuracy promises.
 */

import { clipAtSentence, normalizeOcrText } from "@/lib/analytical-note";
import { visibleProcurementNumber } from "@/lib/pipeline";
import type {
  Citation,
  DocumentItem,
  ParticipateRecommendation,
  Procurement,
  ProjectAnalytics,
} from "@/lib/types";

function uniqueCitations(docs: DocumentItem[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const d of docs) {
    for (const c of d.citations ?? []) {
      const key = `${c.sourceFile}|${c.page}|${c.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export function buildProjectAnalytics(
  procurement: Procurement,
  documents: DocumentItem[]
): ProjectAnalytics {
  const docs = documents.filter((d) => d.procurementId === procurement.id);
  // Metadata-only legacy/demo rows are not evidence: their uploaded file is
  // unavailable, so neither citations nor conclusions may be attributed to it.
  const sourceDocs = docs.filter((d) => Boolean(d.storedPath));
  const unavailableDocs = docs.filter((d) => !d.storedPath);
  const citations = uniqueCitations(sourceDocs);
  const highlights = sourceDocs.flatMap((d) => d.highlights ?? []);
  const extractionErrors = sourceDocs.flatMap((d) => d.extractionErrors ?? []);
  const searchable = (d: DocumentItem) => [
    d.fileName,
    d.title,
    d.analyticalNote,
    ...d.citations.map((citation) => citation.text),
  ].join(" ").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const hasEstimate = sourceDocs.some(
    (d) => d.category === "estimate" || /\bsmeta\b|смет/i.test(d.fileName) ||
      (d.estimatePositions?.length ?? 0) > 0 || (d.analysis?.positionCount ?? 0) > 0
  );
  const hasContract = sourceDocs.some(
    (d) => d.category === "contract" || /dogovor|договор|контракт/i.test(searchable(d))
  );
  const hasTz = sourceDocs.some((d) =>
    d.category === "tz" || /(?:^|[^а-яёa-z0-9])(?:tz|тз)(?=$|[^а-яёa-z0-9])|извещ|техническ.{0,12}задан|ведомост.{0,12}об[ъь]?ем/iu.test(searchable(d))
  );
  // Some owners publish the full scope directly in an invitation or appendix
  // and do not provide a separately named "ТЗ" file. Treat an explicit work
  // description with a measured quantity as scope evidence, not as a missing TZ.
  const hasMeasuredScope = sourceDocs.some((document) => document.citations.some((citation) =>
    /(?:объ[её]м работ|предмет закупки|перечень работ)\s*[:—-]?\s*[^.]{1,160}\d[\d\s,.]*\s*(?:кв\.?\s*м|квадратн[а-яё]*\s+метр[а-яё]*|м²|м2|пог\.?\s*м|шт\.?|штук|тонн|т\b|м3|м³)/iu.test(citation.text)
  ));
  const analyzed = sourceDocs.filter(
    (d) => (d.analyticalNote && d.analyticalNote.length > 40) || d.analysis
  );

  const missing: string[] = [];
  const blockers: string[] = [];
  if (!sourceDocs.length) blockers.push("нет доступных исходных файлов пакета");
  for (const d of unavailableDocs) {
    blockers.push(`файл «${d.fileName}» не приложен или недоступен — загрузите оригинал повторно`);
  }
  if (!hasEstimate) missing.push("смета заказчика не приложена — сравнение с её расценками невозможно; нужна собственная ресурсная калькуляция");
  if (!hasContract) blockers.push("не найден проект договора — условия оплаты, ответственности и расторжения не проверены");
  if (!hasTz && !hasMeasuredScope) blockers.push("не найдено ТЗ / извещение — объём и границы работ не подтверждены");
  if (extractionErrors.length) {
    blockers.push(
      `ошибки извлечения: ${extractionErrors.slice(0, 3).join("; ")}`
    );
  }
  for (const d of sourceDocs) {
    if (d.status === "oshibka" || (d.status === "trebuet_proverki" && d.citations.length === 0)) {
      blockers.push(`документ «${d.fileName}» не дал проверяемых выдержек — проверьте извлечение и оригинал`);
    }
  }
  const reviewNotes = sourceDocs.flatMap((d) =>
    (d.highlights ?? [])
      .filter((highlight) => highlight.severity === "critical" || highlight.severity === "warning")
      .slice(0, 3)
      .map((highlight) => `${d.fileName}: ${highlight.reason || highlight.text}`)
  );
  missing.push(...blockers, ...reviewNotes.slice(0, 8));

  const stopHits = highlights.filter((h) => h.severity === "critical");
  let recommendation: ParticipateRecommendation = "insufficient_data";
  let rationale: string;

  if (blockers.length > 0) {
    recommendation = "insufficient_data";
    rationale =
      "Рекомендацию пока нельзя обосновать: см. конкретные отсутствующие документы и ошибки извлечения ниже.";
  } else if (stopHits.length >= 1) {
    recommendation = "do_not_participate";
    rationale =
      "В пакете найдено критичное замечание. Рекомендация условная — проверьте источник и примите решение вручную.";
  } else if (
    hasContract &&
    hasTz &&
    analyzed.length === sourceDocs.length &&
    blockers.length === 0
  ) {
    recommendation = "participate";
    rationale =
      "Договор и описание работ найдены, извлечение дало проверяемые выдержки, критичных замечаний не найдено. Для решения нужна полная ресурсная калькуляция; это предварительная рекомендация.";
  } else {
    recommendation = "insufficient_data";
    rationale =
      "Данных недостаточно или есть непроверенные места. Не обещаем процент точности — только статус покрытия исходников.";
  }

  const summaryParts: string[] = [
    `Проект «${procurement.title}» (${visibleProcurementNumber(procurement)}). Регион: ${procurement.region}.`,
    `Доступных исходных файлов: ${sourceDocs.length} из ${docs.length}; цитат: ${citations.length}; критичных подсветок: ${stopHits.length}.`,
    rationale,
  ];
  if (blockers.length) {
    summaryParts.push(`Блокирует рекомендацию: ${blockers.join("; ")}.`);
  }
  if (!hasEstimate) {
    summaryParts.push("Сметы заказчика нет: это не блокирует собственный расчёт себестоимости, но сравнить расценки заказчика не получится.");
  }
  if (reviewNotes.length) {
    summaryParts.push(`Конкретные замечания парсера/документов: ${reviewNotes.slice(0, 8).join("; ")}.`);
  }
  for (const d of analyzed.slice(0, 3)) {
    const excerpt = clipAtSentence(normalizeOcrText(d.analyticalNote), 220).text;
    if (excerpt) summaryParts.push(`«${d.title}»: ${excerpt}`);
  }

  return {
    recommendation,
    summary: summaryParts.join("\n\n"),
    missingInputs: visibleCheckItems(missing, sourceDocs),
    citationIds: citations.map((c) => c.id),
    citations,
    generatedAt: new Date().toISOString(),
    method: "deterministic_aggregate_v1",
    disclaimer:
      "Записка собрана из загруженных документов по правилам сервиса. Это не ИИ-экспертное заключение и не обещание точности.",
    quality: {
      status: blockers.length > 0
        ? "insufficient_sources"
        : reviewNotes.length || stopHits.length
          ? "needs_review"
          : "evidence_backed",
      sourceDocuments: sourceDocs.length,
      requiredDocumentsFound: [hasEstimate, hasContract, hasTz || hasMeasuredScope].filter(Boolean).length,
      citationCount: citations.length,
    },
  };
}

type CheckDocument = {
  category?: string;
  fileName: string;
  title?: string;
  analyticalNote?: string;
  citations?: Array<{ text: string }>;
};

/** Drop a check that the current files contradict, and keep one cost line. */
export function visibleCheckItems(items: string[], documents: CheckDocument[]): string[] {
  const corpus = documents.map((document) => [
    document.fileName,
    document.title ?? "",
    document.analyticalNote ?? "",
    ...(document.citations ?? []).map((citation) => citation.text),
  ].join("\n")).join("\n");
  const hasTz = documents.some((document) =>
    document.category === "tz"
    || /(?:^|[^а-яёa-z0-9])(?:tz|тз)(?=$|[^а-яёa-z0-9])|извещ|техническ.{0,12}задан/iu.test(`${document.fileName} ${document.title ?? ""} ${document.analyticalNote ?? ""}`)
  );
  let next = items.filter((item) => {
    if (hasTz && /не найдено ТЗ|нет ТЗ/iu.test(item)) return false;
    if (/минстро/iu.test(item)) {
      if (!/минстро/iu.test(corpus)) return false;
      if (/реквизит\p{L}*\s+письма\s+минстроя[^\n]{0,120}\d/iu.test(corpus)) return false;
    }
    return true;
  });
  const costs = next.filter((item) => /сметн\p{L}*\s+стоимост/iu.test(item));
  if (costs.length > 1) {
    const numbers = [...new Set(costs.flatMap((item) => item.match(/\d[\d\s\u00a0]*(?:[,.]\d+)?/gu) ?? []))];
    next = next.filter((item) => !/сметн\p{L}*\s+стоимост/iu.test(item));
    next.push(numbers.length > 1
      ? `Сметная стоимость в документах различается: ${numbers.join(" и ")}. Сверьте источник.`
      : costs[0]);
  }
  const seen = new Set<string>();
  return next.filter((item) => {
    const text = item.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
    const key = /минстро/u.test(text) && /реквизит|пуст|письм/u.test(text) ? "minstroy-letter" : text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const OVERVIEW_TITLES = ["Паспорт закупки и тайминг", "Объёмы", "Экономика", "Риски", "Что проверить"] as const;

function useful(text: string | null | undefined): string {
  const clean = clipAtSentence(normalizeOcrText(text ?? ""), 500).text.trim();
  if (!clean || /^нет данных\.?$/iu.test(clean)) return "";
  return clean;
}

function sentencesAbout(citations: Array<{ text: string }>, pattern: RegExp, empty: string): string {
  const hits = citations.map((citation) => useful(citation.text)).filter((text) => pattern.test(text)).slice(0, 3);
  return hits.length ? hits.join(" ") : empty;
}

/** Card blocks filled from the note, or from the files and excerpts already on the procurement. */
export function filledOverviewBlocks(input: {
  summary: string;
  documents: Array<CheckDocument & { estimatePositions?: Array<{ name: string; quantity: number; unit: string }> }>;
  citations: Array<{ text: string }>;
  missingInputs: string[];
  economicsText?: string | null;
}): Array<{ title: string; body: string }> {
  const parsed = new Map<string, string>();
  const summary = input.summary;
  const titles = [
    "Паспорт закупки и тайминг",
    "Условия участия и требования к заявке",
    "Сводная ведомость объёмов",
    "Расчёт себестоимости и экономика",
    "Риски и подводные камни",
  ];
  titles.forEach((title, index) => {
    const heading = `${index + 1}. ${title}`;
    const start = summary.indexOf(heading);
    if (start < 0) return;
    const from = start + heading.length;
    let end = summary.length;
    for (let next = index + 1; next < titles.length; next += 1) {
      const at = summary.indexOf(`${next + 1}. ${titles[next]}`, from);
      if (at >= 0) {
        end = at;
        break;
      }
    }
    parsed.set(title, summary.slice(from, end));
  });
  const docs = input.documents.length;
  const excerpts = input.citations.length;
  const volumes = input.documents.flatMap((document) => document.estimatePositions ?? []);
  const volumeText = volumes.length
    ? `Распознано позиций: ${volumes.length}. ${volumes.slice(0, 3).map((row) => `${row.name}: ${row.quantity} ${row.unit}`).join("; ")}.`
    : sentencesAbout(input.citations, /объ[её]м|количеств/iu, docs ? "Объёмы в загруженных документах не распознаны." : "Объёмы не из чего собрать: документов нет.");
  const passport = useful(parsed.get("Паспорт закупки и тайминг"))
    || useful(summary.split(/\n\n/u)[0])
    || (docs
      ? `Документов: ${docs}. Фрагментов: ${excerpts}. ${sentencesAbout(input.citations, /срок|регион|заказчик/iu, "Срок и заказчик в выдержках не найдены.")}`
      : "Паспорт не из чего собрать: документов нет.");
  const checks = visibleCheckItems(input.missingInputs, input.documents);
  return [
    { title: OVERVIEW_TITLES[0], body: passport },
    { title: OVERVIEW_TITLES[1], body: useful(parsed.get("Сводная ведомость объёмов")) || volumeText },
    { title: OVERVIEW_TITLES[2], body: useful(input.economicsText) || useful(parsed.get("Расчёт себестоимости и экономика")) || sentencesAbout(input.citations, /сметн\p{L}*\s+стоимост|себестоим/iu, docs ? "Себестоимость по документам не посчитана: ставок в выдержках нет." : "Экономику не из чего собрать: документов нет.") },
    { title: OVERVIEW_TITLES[3], body: useful(parsed.get("Риски и подводные камни")) || sentencesAbout(input.citations, /штраф|пени|неустойк|риск/iu, docs ? "В выдержках явных штрафов и ограничений не найдено." : "Риски не из чего собрать: документов нет.") },
    { title: OVERVIEW_TITLES[4], body: checks.length ? checks.join("\n") : "По текущим документам отдельных пробелов не отмечено." },
  ];
}

export const PARTICIPATE_LABELS: Record<ParticipateRecommendation, string> = {
  participate: "Участвовать (условно)",
  do_not_participate: "Не участвовать (условно)",
  insufficient_data: "Недостаточно данных",
};
