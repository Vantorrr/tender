import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createSeedData } from "@/lib/seed";
import type { AppData } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "tenderkontur.sqlite");

declare global {
  // eslint-disable-next-line no-var
  var __tkDb: DatabaseSync | undefined;
  // eslint-disable-next-line no-var
  var __tkSeeded: boolean | undefined;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function getDb(): DatabaseSync {
  if (globalThis.__tkDb) return globalThis.__tkDb;
  ensureDir();
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS app_blob (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  globalThis.__tkDb = db;
  seedIfNeeded(db);
  return db;
}

function seedIfNeeded(db: DatabaseSync) {
  const row = db.prepare("SELECT payload FROM app_blob WHERE id = 1").get() as
    | { payload: string }
    | undefined;
  if (row) return;
  const seed = createSeedData();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO app_blob (id, payload, updated_at) VALUES (1, ?, ?)"
  ).run(JSON.stringify(seed), now);
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_at', ?)"
  ).run(now);
  db.prepare(
    "INSERT INTO jobs (id, type, status, detail, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "job-seed-sync",
    "procurement_sync",
    "done",
    "Первичная синхронизация согласованного источника при инициализации БД",
    now,
    now
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
  const current = readAppData();
  const next = mutator(structuredClone(current));
  writeAppData(next);
  return next;
}

export function resetAppData(): AppData {
  const seed = createSeedData();
  writeAppData(seed);
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
