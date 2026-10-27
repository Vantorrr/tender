import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 43141),
  host: process.env.HOST ?? "127.0.0.1",
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR ?? "data"),
  dbFile: process.env.DB_FILE ?? "tenderkontur.sqlite",
  /** Автосинхронизация закупок, мс. 0 = выкл. По умолчанию 5 мин. */
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 5 * 60 * 1000),
  sessionDays: Number(process.env.SESSION_DAYS ?? 7),
  appName: "ТендерКонтур",
  contract: "TMA361",
};

export function dbPath() {
  return path.join(config.dataDir, config.dbFile);
}
