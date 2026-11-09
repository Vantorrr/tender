#!/usr/bin/env node
/**
 * Limited local load smoke — NEVER point at Railway/prod.
 * Usage: BASE_URL=http://127.0.0.1:43141 node scripts/local-load-smoke.mjs
 */
import fs from "node:fs";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");
if (/railway\.app|tenderkontur\.ru/i.test(base)) {
  console.error("Refusing non-local BASE_URL");
  process.exit(2);
}

const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 8);
const rounds = Number(process.env.LOAD_ROUNDS ?? 5);
const email = process.env.LOAD_EMAIL ?? "ruk@alfastroy.ru";
const password = process.env.LOAD_PASSWORD ?? "Ruk123!";

const latencies = [];
let ok = 0;
let fail = 0;
const errors = [];

async function oneClient(i) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) {
    fail++;
    errors.push(`login ${login.status}`);
    return;
  }
  const setCookie = login.headers.getSetCookie?.() ?? [];
  const cookie =
    setCookie.map((c) => c.split(";")[0]).join("; ") ||
    (await login.json().catch(() => ({}))).token
      ? `tk_session=${(await login.clone().json().catch(() => ({}))).token}`
      : "";
  // Prefer JSON token if API returns it
  let tokenHeader = {};
  try {
    const body = await login.json();
    if (body.token) tokenHeader = { authorization: `Bearer ${body.token}` };
  } catch {
    /* cookie path */
  }

  for (let r = 0; r < rounds; r++) {
    for (const path of ["/api/bootstrap", "/api/zakupki"]) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { cookie, ...tokenHeader },
        });
        const ms = Date.now() - t0;
        latencies.push(ms);
        if (res.ok) ok++;
        else {
          fail++;
          if (errors.length < 8) errors.push(`${path} ${res.status}`);
        }
      } catch (e) {
        fail++;
        if (errors.length < 8) errors.push(String(e));
      }
    }
  }
  void i;
}

const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, (_, i) => oneClient(i)));
const elapsed = Date.now() - started;
latencies.sort((a, b) => a - b);
const pct = (p) =>
  latencies.length
    ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]
    : null;

const report = {
  at: new Date().toISOString(),
  base,
  concurrency,
  rounds,
  requests: ok + fail,
  ok,
  fail,
  elapsedMs: elapsed,
  p50ms: pct(50),
  p95ms: pct(95),
  errors,
  disclaimer:
    "Local cloud-VM burst only. Do NOT extrapolate to Railway or production capacity.",
};

const out =
  process.env.LOAD_OUT ??
  "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3/docs/tma361-q2-load-results.json";
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(fail > ok ? 1 : 0);
