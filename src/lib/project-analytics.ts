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
  } else if (stopHits.length >= 2) {
    recommendation = "do_not_participate";
    rationale =
      "В пакете есть критичные замечания (штрафы/условия). Рекомендация условная — окончательное решение за человеком.";
  } else if (hasEstimate && analyzed.length > 0 && missing.length <= 1) {
    recommendation = "participate";
    rationale =
      "Базовый пакет есть, критичных стоп-факторов меньше двух. Это не гарантия выигрыша и не оценка точности.";
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
  };
}

export const PARTICIPATE_LABELS: Record<ParticipateRecommendation, string> = {
  participate: "Участвовать (условно)",
  do_not_participate: "Не участвовать (условно)",
  insufficient_data: "Недостаточно данных",
};
