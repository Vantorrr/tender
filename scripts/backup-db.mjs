#!/usr/bin/env node
/**
 * Copy SQLite + optional uploads into a timestamped backup folder.
 * Isolated / ops use only — does not touch production remotes.
 *
 * Usage:
 *   DATA_DIR=data DB_FILE=test-tma361.sqlite node scripts/backup-db.mjs
 *   node scripts/backup-db.mjs --out data/backups/manual
 */
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const dataDir = path.join(
  cwd,
  process.env.DATA_DIR && process.env.DATA_DIR !== "data"
    ? process.env.DATA_DIR
    : "data"
);
const dbFile = process.env.DB_FILE ?? "tenderkontur.sqlite";
const dbPath = path.join(dataDir, dbFile);

const outArg = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : null;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(
  outArg ?? path.join(dataDir, "backups", `backup-${stamp}`)
);

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(dbPath, path.join(outDir, dbFile));
for (const suffix of ["-wal", "-shm"]) {
  const side = `${dbPath}${suffix}`;
  if (fs.existsSync(side)) {
    fs.copyFileSync(side, path.join(outDir, `${dbFile}${suffix}`));
  }
}

const uploads = path.join(dataDir, "uploads");
if (fs.existsSync(uploads)) {
  const destUploads = path.join(outDir, "uploads");
  fs.cpSync(uploads, destUploads, { recursive: true });
}

const manifest = {
  at: new Date().toISOString(),
  sourceDb: dbPath,
  outDir,
  dbFile,
  hasUploads: fs.existsSync(uploads),
};
fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify(manifest, null, 2)
);
console.log(JSON.stringify({ ok: true, ...manifest }, null, 2));
