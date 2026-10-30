import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createSeedData } from "@/lib/seed";
import type { AppData } from "@/lib/types";
import { config, dbPath } from "@/server/config";
import { hashPassword } from "@/server/passwords";

const SCHEMA_VERSION = "4";

declare global {
  // eslint-disable-next-line no-var
  var __tkDb: DatabaseSync | undefined;
  // eslint-disable-next-line no-var
  var __tkWriteLock: boolean | undefined;
}

function ensureDir() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
}

export function getDb(): DatabaseSync {
  if (globalThis.__tkDb) return globalThis.__tkDb;
  ensureDir();
  const db = new DatabaseSync(dbPath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS app_blob (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  globalThis.__tkDb = db;
  migrate(db);
  return db;
}

function metaGet(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function metaSet(db: DatabaseSync, key: string, value: string) {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
  ).run(key, value);
}

function hashSeedUsers(data: AppData): AppData {
  return {
    ...data,
    users: data.users.map((u) => ({
      ...u,
      password:
        u.password && u.password.includes(":")
          ? u.password
          : hashPassword(u.password ?? "Demo123!"),
    })),
  };
}

function migrate(db: DatabaseSync) {
  const row = db.prepare("SELECT payload FROM app_blob WHERE id = 1").get() as
    | { payload: string }
    | undefined;

  if (!row) {
    const seed = hashSeedUsers(createSeedData());
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO app_blob (id, payload, updated_at) VALUES (1, ?, ?)"
    ).run(JSON.stringify(seed), now);
    metaSet(db, "seeded_at", now);
    metaSet(db, "schema_version", SCHEMA_VERSION);
    db.prepare(
      "INSERT INTO jobs (id, type, status, detail, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "job-seed-sync",
      "procurement_sync",
      "done",
      "Первичная инициализация БД ТендерКонтур",
      now,
      now
    );
    return;
  }

  const version = metaGet(db, "schema_version") ?? "1";
  if (version !== SCHEMA_VERSION) {
    const data = hashSeedUsers(JSON.parse(row.payload) as AppData);
    // v4: orgId на обменах со сметным ПО
    data.smetaExchanges = (data.smetaExchanges ?? []).map((sx) => {
      if (sx.orgId) return sx;
      const author = data.users.find((u) => u.id === sx.authorId);
      return { ...sx, orgId: author?.orgId ?? "org-alfa" };
    });
    // link orphan plan/fact on p-2 if missing
    data.procurements = data.procurements.map((p) => {
      if (p.id === "p-2" && !p.planFactId) {
        const pf = data.planFacts.find((x) => x.procurementId === "p-2");
        return pf ? { ...p, planFactId: pf.id } : p;
      }
      return p;
    });
    db.prepare(
      "UPDATE app_blob SET payload = ?, updated_at = ? WHERE id = 1"
    ).run(JSON.stringify(data), new Date().toISOString());
    metaSet(db, "schema_version", SCHEMA_VERSION);
    metaSet(db, "migrated_at", new Date().toISOString());
  }

  // purge expired sessions
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(
    new Date().toISOString()
  );
}

export function readAppData(): AppData {
  const db = getDb();
  const row = db.prepare("SELECT payload FROM app_blob WHERE id = 1").get() as {
    payload: string;
  };
  return JSON.parse(row.payload) as AppData;
}

export function writeAppData(data: AppData): void {
  const db = getDb();
  db.prepare(
    "UPDATE app_blob SET payload = ?, updated_at = ? WHERE id = 1"
  ).run(JSON.stringify(data), new Date().toISOString());
}

export function mutateAppData(mutator: (data: AppData) => AppData): AppData {
  while (globalThis.__tkWriteLock) {
    /* spin briefly — sync API, rare contention */
  }
  globalThis.__tkWriteLock = true;
  try {
    const current = readAppData();
    const next = mutator(structuredClone(current));
    writeAppData(next);
    return next;
  } finally {
    globalThis.__tkWriteLock = false;
  }
}

export function resetAppData(): AppData {
  const seed = hashSeedUsers(createSeedData());
  writeAppData(seed);
  getDb().prepare("DELETE FROM sessions").run();
  metaSet(getDb(), "reset_at", new Date().toISOString());
  return seed;
}

export function insertJob(job: {
  id: string;
  type: string;
  status: string;
  detail: string;
  createdAt: string;
  finishedAt?: string | null;
}) {
  getDb()
    .prepare(
      "INSERT INTO jobs (id, type, status, detail, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      job.id,
      job.type,
      job.status,
      job.detail,
      job.createdAt,
      job.finishedAt ?? null
    );
}

export function updateJob(
  id: string,
  patch: { status?: string; detail?: string; finishedAt?: string }
) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | {
        status: string;
        detail: string;
        finished_at: string | null;
      }
    | undefined;
  if (!row) return;
  db.prepare(
    "UPDATE jobs SET status = ?, detail = ?, finished_at = ? WHERE id = ?"
  ).run(
    patch.status ?? row.status,
    patch.detail ?? row.detail,
    patch.finishedAt ?? row.finished_at,
    id
  );
}

export function listJobs(limit = 20) {
  return getDb()
    .prepare(
      "SELECT id, type, status, detail, created_at as createdAt, finished_at as finishedAt FROM jobs ORDER BY created_at DESC LIMIT ?"
    )
    .all(limit) as Array<{
    id: string;
    type: string;
    status: string;
    detail: string;
    createdAt: string;
    finishedAt: string | null;
  }>;
}

export function healthSnapshot() {
  const db = getDb();
  const blob = db
    .prepare("SELECT updated_at, length(payload) as bytes FROM app_blob WHERE id = 1")
    .get() as { updated_at: string; bytes: number };
  const sessions = db
    .prepare("SELECT count(*) as c FROM sessions")
    .get() as { c: number };
  const jobs = db
    .prepare("SELECT count(*) as c FROM jobs")
    .get() as { c: number };
  const data = readAppData();
  return {
    ok: true,
    app: config.appName,
    contract: config.contract,
    schemaVersion: metaGet(db, "schema_version") ?? SCHEMA_VERSION,
    dbPath: dbPath(),
    updatedAt: blob.updated_at,
    payloadBytes: blob.bytes,
    sessions: sessions.c,
    jobs: jobs.c,
    organizations: data.organizations.length,
    users: data.users.length,
    procurements: data.procurements.length,
    syncIntervalMs: config.syncIntervalMs,
  };
}

let clientImportScheduled = false;

/** Подтягивает клиентские XLSX в справочники один раз после seed. */
function maybeScheduleClientImport(db: DatabaseSync) {
  if (clientImportScheduled) return;
  if (metaGet(db, "client_xlsx_imported") === "1") return;
  clientImportScheduled = true;
  void import("@/server/client-import")
    .then(async ({ importClientDirectories }) => {
      const data = readAppData();
      const already = data.directories.some(
        (d) => d.current && /клиент/i.test(d.name)
      );
      if (!already) {
        await importClientDirectories("u-super");
      }
      metaSet(getDb(), "client_xlsx_imported", "1");
    })
    .catch((err) => {
      console.error("[tk] client xlsx auto-import failed", err);
      clientImportScheduled = false;
    });
}

export function markClientImportDone() {
  metaSet(getDb(), "client_xlsx_imported", "1");
}

export function clearClientImportFlag() {
  metaSet(getDb(), "client_xlsx_imported", "0");
  clientImportScheduled = false;
}

export function ensureReady() {
  const db = getDb();
  // allow hot-reload to pick up SCHEMA_VERSION bumps without process restart
  const version = metaGet(db, "schema_version") ?? "1";
  if (version !== SCHEMA_VERSION) {
    migrate(db);
  }
  maybeScheduleClientImport(db);
  return healthSnapshot();
}
