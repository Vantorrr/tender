import path from "node:path";

const DATA_SUBDIR = "data";

export const config = {
  port: Number(process.env.PORT ?? 43141),
  host: process.env.HOST ?? "0.0.0.0",
  /** Statically scoped under cwd/data — avoids Turbopack whole-project trace */
  dataDir: path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    process.env.DATA_DIR && process.env.DATA_DIR !== "data"
      ? process.env.DATA_DIR
      : DATA_SUBDIR
  ),
  dbFile: process.env.DB_FILE ?? "tenderkontur.sqlite",
  /**
   * Автосинхронизация закупок, мс. 0 = выкл.
   * Default 0: без реального источника таймер не должен плодить записи.
   * Явный демо: PROCUREMENT_DEMO=1 + SYNC_INTERVAL_MS>0.
   */
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 0),
  sessionDays: Number(process.env.SESSION_DAYS ?? 7),
  appName: "истройка",
  contract: "TMA361",
  openRouterKey: process.env.OPENROUTER_API_KEY ?? "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
  /** Paid full-package LLM analysis after an upload — off by default. */
  openRouterOnUpload:
    process.env.OPENROUTER_ON_UPLOAD === "1" ||
    process.env.OPENROUTER_ON_UPLOAD === "true",
  /** Max multipart upload size (bytes). Default 25 MiB. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
  /** Soft timeout budget for document analysis (ms). */
  analysisTimeoutMs: Number(process.env.ANALYSIS_TIMEOUT_MS ?? 60_000),
};

export function dbPath() {
  return path.join(
    /*turbopackIgnore: true*/ config.dataDir,
    config.dbFile
  );
}
