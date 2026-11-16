import { config } from "@/server/config";
import { ensureReady } from "@/server/db";
import { runProcurementSync } from "@/server/jobs";
import { procurementSourceStatus } from "@/server/procurement-source";

declare global {
  var __tkSchedulerStarted: boolean | undefined;
}

const SYSTEM_ACTOR = "u-super";

export function startBackgroundJobs() {
  if (globalThis.__tkSchedulerStarted) return;
  if (config.syncIntervalMs <= 0) return;

  const source = procurementSourceStatus();
  // A live adapter with a key reports not_configured until its first request.
  // Permit that one-time bootstrap sync, but never poll an unconfigured stub.
  const canSync = source.status !== "not_configured" || source.configured;
  if (!canSync) {
    console.log(
      `[истройка] автосинхронизация отключена: источник закупок not_configured (${source.id})`
    );
    return;
  }

  globalThis.__tkSchedulerStarted = true;

  try {
    ensureReady();
  } catch (e) {
    console.error("[истройка] DB init failed", e);
    return;
  }

  console.log(
    `[истройка] автосинхронизация каждые ${Math.round(config.syncIntervalMs / 1000)}с (${source.status}/${source.id})`
  );

  let syncInFlight = false;
  const sync = () => {
    if (syncInFlight) return;
    syncInFlight = true;
    void runProcurementSync(SYSTEM_ACTOR)
      .then((result) => {
        console.log(
          `[истройка] sync job ${result.jobId} ok, закупок: ${result.data.procurements.length}`
        );
      })
      .catch((e) => {
        console.error("[истройка] sync failed", e);
      })
      .finally(() => {
        syncInFlight = false;
      });
  };

  // Run once on boot so a configured live source is actually verified before
  // waiting a full six-hour interval for its first request.
  sync();
  setInterval(sync, config.syncIntervalMs);
}
