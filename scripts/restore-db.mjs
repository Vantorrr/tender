#!/usr/bin/env node
/**
 * Restore SQLite (+ uploads) from a backup folder created by backup-db.mjs.
 *
 * Usage:
 *   DATA_DIR=data DB_FILE=test-tma361.sqlite node scripts/restore-db.mjs data/backups/backup-…
 */
import fs from "node:fs";
import path from "node:path";

const backupDir = process.argv[2];
if (!backupDir) {
  console.error("Usage: node scripts/restore-db.mjs <backup-dir>");
  process.exit(1);
}

const cwd = process.cwd();
const dataDir = path.join(
  cwd,
  process.env.DATA_DIR && process.env.DATA_DIR !== "data"
    ? process.env.DATA_DIR
    : "data"
);
const dbFile = process.env.DB_FILE ?? "tenderkontur.sqlite";
const srcDir = path.resolve(backupDir);
const srcDb = path.join(srcDir, dbFile);

if (!fs.existsSync(srcDb)) {
  console.error(`Backup DB not found: ${srcDb}`);
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
const destDb = path.join(dataDir, dbFile);
fs.copyFileSync(srcDb, destDb);
for (const suffix of ["-wal", "-shm"]) {
  const side = path.join(srcDir, `${dbFile}${suffix}`);
  const dest = `${destDb}${suffix}`;
  if (fs.existsSync(side)) fs.copyFileSync(side, dest);
  else if (fs.existsSync(dest)) fs.unlinkSync(dest);
}

const srcUploads = path.join(srcDir, "uploads");
const destUploads = path.join(dataDir, "uploads");
if (fs.existsSync(srcUploads)) {
  fs.rmSync(destUploads, { recursive: true, force: true });
  fs.cpSync(srcUploads, destUploads, { recursive: true });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      restoredDb: destDb,
      from: srcDir,
      uploads: fs.existsSync(destUploads),
    },
    null,
    2
  )
);
