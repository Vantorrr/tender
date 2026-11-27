import { refreshProcurementAnalytics } from "@/server/repo";

/** Archive extraction is complete only after all supported child files are processed. */
export function archiveResultStatus(
  extractionOk: boolean,
  processingErrors: string[]
): "gotovo" | "trebuet_proverki" {
  return extractionOk && processingErrors.length === 0 ? "gotovo" : "trebuet_proverki";
}

export function refreshAndMaybeAnalyzePackage(userId: string, procurementId: string): Promise<void> {
  refreshProcurementAnalytics(userId, procurementId);
  // A file upload never calls the model. Gemini runs only from an explicit
  // «Составить аналитическую записку» / «Спросить ИИ» action.
  return Promise.resolve();
}
