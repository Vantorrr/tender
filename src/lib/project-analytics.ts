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
  const citations = uniqueCitations(docs);
  const highlights = docs.flatMap((d) => d.highlights ?? []);
  const extractionErrors = docs.flatMap((d) => d.extractionErrors ?? []);
  const hasEstimate = docs.some(
    (d) => d.category === "estimate" || /\bsmeta\b|смет/i.test(d.fileName)
  );
  const hasContract = docs.some(
    (d) => d.category === "contract" || /dogovor|договор/i.test(d.fileName)
  );
  const hasTz = docs.some((d) => /tz|тз|извещ/i.test(d.fileName + d.title));
  const analyzed = docs.filter(
    (d) => (d.analyticalNote && d.analyticalNote.length > 40) || d.analysis
  );

  const missing: string[] = [];
  if (!docs.length) missing.push("нет загруженных документов пакета");
  if (!hasEstimate) missing.push("нет сметы заказчика");
  if (!hasContract) missing.push("нет проекта договора");
  if (!hasTz) missing.push("нет ТЗ / извещения");
  if (extractionErrors.length) {
    missing.push(
      `ошибки извлечения: ${extractionErrors.slice(0, 3).join("; ")}`
    );
  }
  for (const d of docs) {
    if (d.status === "oshibka" || d.status === "trebuet_proverki") {
      missing.push(`документ «${d.title}» требует проверки (${d.status})`);
    }
  }

  const stopHits = highlights.filter((h) => h.severity === "critical");
  let recommendation: ParticipateRecommendation = "insufficient_data";
  let rationale: string;

  if (missing.length >= 3 || docs.length === 0) {
    recommendation = "insufficient_data";
    rationale =
      "Недостаточно исходников для рекомендации: заполните пакет документов и устраните ошибки извлечения.";
  } else if (stopHits.length >= 1) {
    recommendation = "do_not_participate";
    rationale =
      "В пакете найдено критичное замечание. Рекомендация условная — проверьте источник и примите решение вручную.";
  } else if (
    hasEstimate &&
    hasContract &&
    hasTz &&
    analyzed.length === docs.length &&
    missing.length === 0 &&
    extractionErrors.length === 0
  ) {
    recommendation = "participate";
    rationale =
      "Все обязательные типы документов разобраны, извлечение без ошибок, критичных замечаний не найдено. Это предварительная рекомендация, не гарантия выигрыша.";
  } else {
    recommendation = "insufficient_data";
    rationale =
      "Данных недостаточно или есть непроверенные места. Не обещаем процент точности — только статус покрытия исходников.";
  }

  const summaryParts: string[] = [
    `Проект «${procurement.title}» (${procurement.number}). Регион: ${procurement.region}.`,
    `Документов в пакете: ${docs.length}; цитат: ${citations.length}; критичных подсветок: ${stopHits.length}.`,
    rationale,
  ];
  if (missing.length) {
    summaryParts.push(`Требует уточнения: ${missing.join("; ")}.`);
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
      "Записка собрана детерминированно из загруженных документов. Это не ИИ-экспертное заключение и не обещание точности.",
    quality: {
      status: docs.length === 0 || missing.length >= 3
        ? "insufficient_sources"
        : missing.length || extractionErrors.length || stopHits.length
          ? "needs_review"
          : "evidence_backed",
      sourceDocuments: docs.length,
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
