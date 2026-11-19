/** Persisted status when a model call fails. Shown in the UI via aiFailureBannerText. */
export function aiAnalysisFailureStatus(reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim().slice(0, 300);
  return `ИИ-анализ не выполнен: ${clean || "неизвестная ошибка"}`;
}

/** Short banner line: «ИИ не выполнен: причина». */
export function aiFailureBannerText(status: string): string {
  const reason = status.replace(/^ИИ-анализ не выполнен:\s*/u, "").trim();
  return `ИИ не выполнен: ${reason || "неизвестная ошибка"}`;
}
