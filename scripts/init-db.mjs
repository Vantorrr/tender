#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, scryptSync } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, process.env.DATA_DIR ?? "data");
const dbFile = path.join(dataDir, process.env.DB_FILE ?? "tenderkontur.sqlite");

fs.mkdirSync(dataDir, { recursive: true });

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

// Если БД уже есть — только health-like info
const exists = fs.existsSync(dbFile);
const db = new DatabaseSync(dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

const row = db.prepare("SELECT payload, updated_at FROM app_blob WHERE id = 1").get();
if (!row) {
  // Минимальный маркер — полный seed сделает Next при первом getDb()
  // Чтобы setup был полезен сразу, пишем пустой валидный флаг:
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('setup_at', ?)"
  ).run(new Date().toISOString());
  console.log(`→ SQLite создана: ${dbFile}`);
  console.log("→ Полный seed выполнит приложение при первом запуске (npm run dev)");
  // keep hashPassword referenced for future inline seed if needed
  void hashPassword;
  void createHash;
} else {
  const data = JSON.parse(row.payload);
  console.log(
    `→ SQLite OK · users ${data.users?.length ?? 0} · закупок ${data.procurements?.length ?? 0}`
  );
  console.log(`→ ${dbFile}`);
  console.log(`→ updated ${row.updated_at}`);
}
db.close();

if (!exists) {
  console.log("→ новый файл БД");
}
