#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT ?? "43141";
const host = process.env.HOST ?? "127.0.0.1";
const url = `http://${host}:${port}/api/health`;
const dataDir = path.join(root, process.env.DATA_DIR ?? "data");
const dbFile = path.join(dataDir, process.env.DB_FILE ?? "tenderkontur.sqlite");

let liveOk = false;
try {
  const res = await fetch(url);
  if (res.ok) {
    const j = await res.json();
    if (j.ok) {
      liveOk = true;
      console.log("OK live", j.app, j.contract);
      console.log(
        `  schema ${j.schemaVersion} · users ${j.users} · закупок ${j.procurements}`
      );
      console.log(`  db ${j.dbPath}`);
      console.log(`  sync every ${j.syncIntervalMs}ms`);
    }
  }
} catch {
  /* server may be down — fall back to sqlite */
}

if (!liveOk) {
  console.log(`Сервер ${url} недоступен — проверяю SQLite напрямую`);
  if (!fs.existsSync(dbFile)) {
    console.error(`Нет БД: ${dbFile}`);
    console.error("Запустите: npm run setup && npm run dev");
    process.exit(1);
  }
  const db = new DatabaseSync(dbFile);
  const row = db
    .prepare("SELECT length(payload) as bytes, updated_at FROM app_blob WHERE id = 1")
    .get();
  const users = row
    ? JSON.parse(
        db.prepare("SELECT payload FROM app_blob WHERE id = 1").get().payload
      ).users?.length
    : 0;
  db.close();
  if (!row) {
    console.error("app_blob пуст — запустите npm run dev один раз для seed");
    process.exit(1);
  }
  console.log("OK sqlite", dbFile);
  console.log(`  payload ${row.bytes} B · updated ${row.updated_at} · users ~${users}`);
  console.log("  (live health появится после npm run dev)");
}

// optional curl parity for CI
if (process.env.DOCTOR_REQUIRE_LIVE === "1" && !liveOk) {
  const res = spawnSync("curl", ["-sS", url], { encoding: "utf8" });
  if (res.status !== 0) {
    console.error("DOCTOR_REQUIRE_LIVE=1 но сервер недоступен");
    process.exit(1);
  }
}
