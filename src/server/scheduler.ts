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
  // Never timer-poll an unconfigured stub — that used to invent p-auto-* noise.
  if (source.status === "not_configured") {
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

  setInterval(() => {
    void runProcurementSync(SYSTEM_ACTOR)
      .then((result) => {
        console.log(
          `[истройка] sync job ${result.jobId} ok, закупок: ${result.data.procurements.length}`
        );
      })
      .catch((e) => {
        console.error("[истройка] sync failed", e);
      });
  }, config.syncIntervalMs);
}
