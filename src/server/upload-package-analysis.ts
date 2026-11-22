import { config } from "@/server/config";
import {
  analyzeProcurementPackageWithAI,
  packageAnalysisAlreadyCurrent,
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

const tails = new Map<string, Promise<void>>();

/** One package analysis at a time per procurement. A later upload waits, then rechecks the hash. */
function enqueue(procurementId: string, task: () => Promise<void>): Promise<void> {
  const previous = tails.get(procurementId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  tails.set(procurementId, settled);
  return run;
}

export function refreshAndMaybeAnalyzePackage(userId: string, procurementId: string): Promise<void> {
  refreshProcurementAnalytics(userId, procurementId);
  if (!config.openRouterOnUpload) return Promise.resolve();
  return enqueue(procurementId, async () => {
    if (packageAnalysisAlreadyCurrent(procurementId)) return;
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
  });
}
