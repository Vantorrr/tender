#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const port = process.env.PORT ?? "43141";
const host = process.env.HOST ?? "127.0.0.1";
const url = `http://${host}:${port}/api/health`;

const res = spawnSync("curl", ["-sS", url], { encoding: "utf8" });
if (res.status !== 0) {
  console.error(`Недоступно: ${url}`);
  console.error("Запустите: npm run dev");
  process.exit(1);
}
try {
  const j = JSON.parse(res.stdout);
  if (!j.ok) {
    console.error("Health failed:", j);
    process.exit(1);
  }
  console.log("OK", j.app, j.contract);
  console.log(`  schema ${j.schemaVersion} · users ${j.users} · закупок ${j.procurements}`);
  console.log(`  db ${j.dbPath}`);
  console.log(`  sync every ${j.syncIntervalMs}ms`);
} catch {
  console.error("Bad health payload:", res.stdout);
  process.exit(1);
}
