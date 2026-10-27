import { config } from "@/server/config";
import { ensureReady } from "@/server/db";
import { runProcurementSync } from "@/server/jobs";

declare global {
  // eslint-disable-next-line no-var
  var __tkSchedulerStarted: boolean | undefined;
}

const SYSTEM_ACTOR = "u-super";

export function startBackgroundJobs() {
  if (globalThis.__tkSchedulerStarted) return;
  if (config.syncIntervalMs <= 0) return;
  globalThis.__tkSchedulerStarted = true;

  try {
    ensureReady();
  } catch (e) {
    console.error("[ТендерКонтур] DB init failed", e);
    return;
  }

  console.log(
    `[ТендерКонтур] автосинхронизация каждые ${Math.round(config.syncIntervalMs / 1000)}с`
  );

  setInterval(() => {
    try {
      const result = runProcurementSync(SYSTEM_ACTOR);
      console.log(
        `[ТендерКонтур] sync job ${result.jobId} ok, закупок: ${result.data.procurements.length}`
      );
    } catch (e) {
      console.error("[ТендерКонтур] sync failed", e);
    }
  }, config.syncIntervalMs);
}
