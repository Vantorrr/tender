/**
 * Deterministic project-level analytical note.
 * No invented LLM reasons, no accuracy promises.
 */

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
  if (!hasTz) blockers.push("не найдено ТЗ / извещение — объём и границы работ не подтверждены");
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
    `Проект «${procurement.title}» (${procurement.number}). Регион: ${procurement.region}.`,
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
    summaryParts.push(`«${d.title}»: ${d.analyticalNote.slice(0, 220)}`);
  }

  return {
    recommendation,
    summary: summaryParts.join("\n\n"),
    missingInputs: missing,
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
      requiredDocumentsFound: [hasEstimate, hasContract, hasTz].filter(Boolean).length,
      citationCount: citations.length,
    },
  };
}

export const PARTICIPATE_LABELS: Record<ParticipateRecommendation, string> = {
  participate: "Участвовать (условно)",
  do_not_participate: "Не участвовать (условно)",
  insufficient_data: "Недостаточно данных",
};
