/** Russian labels stored on findings and shown in the cabinet. Keys stay in the model JSON only. */
export const ANALYSIS_TOPIC_LABELS = {
  scope: "Объём работ",
  schedule: "Сроки",
  payment: "Оплата",
  liability: "Ответственность",
  qualification: "Допуск",
  estimate: "Смета",
  resources: "Ресурсы и логистика",
  materials: "Материалы",
  guarantees: "Обеспечение",
  safety: "Охрана труда",
  criteria: "Критерии оценки",
  conflict: "Противоречие",
  other: "Прочее",
} as const;

export type AnalysisTopicKey = keyof typeof ANALYSIS_TOPIC_LABELS;

export const ANALYSIS_IMPORTANCE_LABELS = {
  critical: "Критично",
  high: "Важно",
  medium: "Проверить",
  info: "К сведению",
} as const;

export type AnalysisImportanceKey = keyof typeof ANALYSIS_IMPORTANCE_LABELS;

/** Topics the package review must either quote or mark as absent. */
export const ANALYSIS_TOPIC_CHECKLIST: Array<{ key: AnalysisTopicKey; label: string }> = [
  { key: "scope", label: ANALYSIS_TOPIC_LABELS.scope },
  { key: "schedule", label: ANALYSIS_TOPIC_LABELS.schedule },
  { key: "resources", label: ANALYSIS_TOPIC_LABELS.resources },
  { key: "qualification", label: ANALYSIS_TOPIC_LABELS.qualification },
  { key: "guarantees", label: ANALYSIS_TOPIC_LABELS.guarantees },
  { key: "payment", label: ANALYSIS_TOPIC_LABELS.payment },
  { key: "liability", label: ANALYSIS_TOPIC_LABELS.liability },
  { key: "materials", label: ANALYSIS_TOPIC_LABELS.materials },
  { key: "safety", label: ANALYSIS_TOPIC_LABELS.safety },
  { key: "criteria", label: ANALYSIS_TOPIC_LABELS.criteria },
];
