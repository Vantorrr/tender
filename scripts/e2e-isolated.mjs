#!/usr/bin/env node
/**
 * Isolated HTTP smoke against a local Next server (never production Railway).
 * Expects server already running with DATA_DIR/DB_FILE pointing at test files,
 * or starts nothing — call after `npm run dev` on an isolated DB.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:43141 node scripts/e2e-isolated.mjs
 */
const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");

if (/railway\.app/i.test(base)) {
  console.error("Refusing E2E against Railway/production URL");
  process.exit(2);
}

async function json(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

const failures = [];

function check(name, ok, detail = "") {
  if (ok) console.log(`ok  ${name}`);
  else {
    console.error(`FAIL ${name} ${detail}`);
    failures.push(name);
  }
}

const health = await json("/api/health");
check("health", health.res.ok && health.body.ok === true, JSON.stringify(health.body));

const login = await json("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({
    email: "tender@alfastroy.ru",
    password: process.env.E2E_PASSWORD ?? "Tender123!",
  }),
});
check("login alfa tender", login.res.ok && Boolean(login.body.token), login.body.error);
const token = login.body.token;

const boot = await json("/api/bootstrap", {
  headers: { authorization: `Bearer ${token}` },
});
check(
  "bootstrap org-scoped",
  boot.res.ok &&
    Array.isArray(boot.body.data?.procurements) &&
    boot.body.data.procurements.every((p) => p.orgId === "org-alfa"),
  `count=${boot.body.data?.procurements?.length}`
);

const betaLogin = await json("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({
    email: "tender@betain.ru",
    password: process.env.E2E_BETA_PASSWORD ?? "Beta123!",
  }),
});
const betaToken = betaLogin.body.token;
check("login beta", Boolean(betaToken));

const betaZakupki = await json("/api/zakupki", {
  headers: { authorization: `Bearer ${betaToken}` },
});
const alfaIds = new Set((boot.body.data?.procurements ?? []).map((p) => p.id));
const leak = (betaZakupki.body.items ?? []).some((p) => alfaIds.has(p.id));
check("beta cannot see alfa zakupki ids", !leak);

const smetaLogin = await json("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({
    email: "smeta@alfastroy.ru",
    password: process.env.E2E_SMETA_PASSWORD ?? "Smeta123!",
  }),
});
const smetaToken = smetaLogin.body.token;
const denied = await json("/api/zakupki", {
  headers: { authorization: `Bearer ${smetaToken}` },
});
check(
  "smetchik denied zakupki section",
  denied.res.status === 403,
  `status=${denied.res.status}`
);

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nisolated e2e ok");
