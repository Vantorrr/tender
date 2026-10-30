#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, process.env.DATA_DIR ?? "data");
const envExample = path.join(root, ".env.example");
const envFile = path.join(root, ".env");

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envFile);
  console.log("→ создан .env из .env.example");
}

const fixturesImports = path.join(root, "fixtures", "client-imports");
const runtimeImports = path.join(dataDir, "client-imports");
if (fs.existsSync(fixturesImports)) {
  fs.mkdirSync(runtimeImports, { recursive: true });
  for (const f of fs.readdirSync(fixturesImports).filter((x) => x.endsWith(".xlsx"))) {
    fs.copyFileSync(path.join(fixturesImports, f), path.join(runtimeImports, f));
  }
  console.log("→ клиентские XLSX → data/client-imports");
}

const init = spawnSync(
  process.execPath,
  [path.join(root, "scripts/init-db.mjs")],
  { cwd: root, encoding: "utf8", env: process.env }
);

if (init.status === 0) {
  console.log(init.stdout.trim());
} else {
  console.log("→ data/ готов:", dataDir);
  console.log("→ БД поднимется при npm run dev /api/health");
  if (init.stderr) console.error(init.stderr.slice(0, 500));
}

console.log(`
ТендерКонтур setup OK

  npm run dev       → http://127.0.0.1:43141
  npm run doctor    → проверка /api/health
  docker compose up → контейнер на :43141

Демо: tender@alfastroy.ru / Tender123!
`);
