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
  /** Автосинхронизация закупок, мс. 0 = выкл. По умолчанию 5 мин. */
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 5 * 60 * 1000),
  sessionDays: Number(process.env.SESSION_DAYS ?? 7),
  appName: "ТендерКонтур",
  contract: "TMA361",
  openRouterKey: process.env.OPENROUTER_API_KEY ?? "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
};

export function dbPath() {
  return path.join(
    /*turbopackIgnore: true*/ config.dataDir,
    config.dbFile
  );
}
