import { config } from "@/server/config";
import {
  analyzeProcurementPackageWithAI,
  recordProcurementAiFailure,
  refreshProcurementAnalytics,
} from "@/server/repo";

/** Archive extraction is complete only after all supported child files are processed. */
export function archiveResultStatus(
  extractionOk: boolean,
  processingErrors: string[]
): "gotovo" | "trebuet_proverki" {
  return extractionOk && processingErrors.length === 0 ? "gotovo" : "trebuet_proverki";
}

export async function refreshAndMaybeAnalyzePackage(userId: string, procurementId: string) {
  refreshProcurementAnalytics(userId, procurementId);
  if (!config.openRouterOnUpload) return;
  try {
    await analyzeProcurementPackageWithAI(userId, procurementId);
  } catch (error) {
    // Upload and deterministic analysis are already persisted. A provider outage
    // must not turn a successful document upload into an apparent failure, but
    // the failure itself has to stay on the card.
    const reason = error instanceof Error ? error.message : "неизвестная ошибка";
    console.error(`[documents] automatic package analysis failed: ${reason}`);
    try {
      recordProcurementAiFailure(userId, procurementId, reason);
    } catch (persistError) {
      const persistReason = persistError instanceof Error ? persistError.message : "неизвестная ошибка";
      console.error(`[documents] failed to persist AI status: ${persistReason}`);
    }
  }
}
