import { config } from "@/server/config";
import {
  analyzeProcurementPackageWithAI,
  refreshProcurementAnalytics,
} from "@/server/repo";

export async function refreshAndMaybeAnalyzePackage(userId: string, procurementId: string) {
  refreshProcurementAnalytics(userId, procurementId);
  if (!config.openRouterOnUpload) return;
  try {
    await analyzeProcurementPackageWithAI(userId, procurementId);
  } catch (error) {
    // Upload and deterministic analysis are already persisted. A provider outage
    // must not turn a successful document upload into an apparent failure.
    const errorType = error instanceof Error ? error.name : "unknown error";
    console.warn(`[documents] automatic package analysis failed (${errorType})`);
  }
}
