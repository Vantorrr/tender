#!/usr/bin/env node
/**
 * Full isolated HTTP E2E against a local Next server (never production Railway).
 * No paid API calls. Reports pass/fail counts and NOT covered areas.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:43141 node scripts/e2e-isolated.mjs
 */
import fs from "node:fs";
import path from "node:path";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");

if (/railway\.app/i.test(base)) {
  console.error("Refusing E2E against Railway/production URL");
  process.exit(2);
}

const results = [];
const notCovered = [
  "Real vendor procurement API / credentials (customer agreement)",
  "Paid OpenRouter LLM note generation (isolated: НЕ ПРОВЕРЕНО)",
  "Cloud OCR vendors (local tesseract in Docker image is prepared)",
  "SMTP delivery to real human inboxes (local smtp-sink covered in vitest)",
  "Named smeta vendor beyond ГРАНД-Смета fixtures already in repo",
];

function addUtcDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function json(urlPath, init = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail || "") });
  if (ok) console.log(`PASS ${name}`);
  else console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(email, password) {
  return json("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

const health = await json("/api/health");
check("health", health.res.ok && health.body.ok === true, JSON.stringify(health.body));

const roles = [
  ["super@tenderkontur.ru", process.env.E2E_SUPER_PASSWORD ?? "Super123!", "superadmin"],
  ["ruk@alfastroy.ru", process.env.E2E_RUK_PASSWORD ?? "Ruk123!", "rukovoditel"],
  ["tender@alfastroy.ru", process.env.E2E_PASSWORD ?? "Tender123!", "tender"],
  ["smeta@alfastroy.ru", process.env.E2E_SMETA_PASSWORD ?? "Smeta123!", "smetchik"],
  ["object@alfastroy.ru", process.env.E2E_OBJECT_PASSWORD ?? "Object123!", "otvetstvennyy"],
  ["admin@alfastroy.ru", process.env.E2E_ADMIN_PASSWORD ?? "Admin123!", "admin"],
];

const tokens = {};
for (const [email, password, role] of roles) {
  const res = await login(email, password);
  tokens[role] = res.body.token;
  check(`login ${role}`, res.res.ok && Boolean(res.body.token), res.body.error);
}

const betaLogin = await login(
  "tender@betain.ru",
  process.env.E2E_BETA_PASSWORD ?? "Beta123!"
);
const betaToken = betaLogin.body.token;
check("login beta tenant", Boolean(betaToken), betaLogin.body.error);

// Self-registration: create a new tenant and let an employee join with its code.
const registrationSuffix = String(Date.now()).slice(-7);
const registered = await json("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    mode: "create_org",
    orgName: `E2E Организация ${registrationSuffix}`,
    inn: `9${registrationSuffix}12`,
    name: "E2E Администратор",
    email: `e2e-admin-${registrationSuffix}@example.test`,
    password: "E2EAdmin123!",
  }),
});
const newOrgId = registered.body.user?.orgId;
check(
  "self-registration creates tenant admin",
  registered.res.ok && registered.body.user?.role === "admin" && Boolean(newOrgId),
  registered.body.error
);
check(
  "self-registration returns employee join code",
  typeof registered.body.joinCode === "string" && registered.body.joinCode.length > 8,
  registered.body.error
);
const joined = await json("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    mode: "join",
    joinCode: registered.body.joinCode,
    name: "E2E Сотрудник",
    email: `e2e-employee-${registrationSuffix}@example.test`,
    password: "E2EEmployee123!",
  }),
});
check(
  "employee joins registered tenant with limited role",
  joined.res.ok && joined.body.user?.orgId === newOrgId && joined.body.user?.role === "tender",
  joined.body.error
);

const bootAlfa = await json("/api/bootstrap", {
  headers: { authorization: `Bearer ${tokens.tender}` },
});
check(
  "bootstrap alfa org-scoped procurements",
  bootAlfa.res.ok &&
    Array.isArray(bootAlfa.body.data?.procurements) &&
    bootAlfa.body.data.procurements.every((p) => p.orgId === "org-alfa"),
  `count=${bootAlfa.body.data?.procurements?.length}`
);

const bootBeta = await json("/api/zakupki", {
  headers: { authorization: `Bearer ${betaToken}` },
});
const alfaIds = new Set((bootAlfa.body.data?.procurements ?? []).map((p) => p.id));
check(
  "beta cannot see alfa zakupki ids",
  !(bootBeta.body.items ?? []).some((p) => alfaIds.has(p.id))
);

const deniedZakupki = await json("/api/zakupki", {
  headers: { authorization: `Bearer ${tokens.smetchik}` },
});
check(
  "smetchik denied zakupki section",
  deniedZakupki.res.status === 403,
  `status=${deniedZakupki.res.status}`
);

const deniedDengi = await json("/api/dengi", {
  headers: { authorization: `Bearer ${tokens.tender}` },
});
check(
  "tender denied dengi section by default",
  deniedDengi.res.status === 403,
  `status=${deniedDengi.res.status}`
);

const otvRaschety = await json("/api/raschety", {
  headers: { authorization: `Bearer ${tokens.otvetstvennyy}` },
});
check(
  "otvetstvennyy denied raschety section",
  otvRaschety.res.status === 403,
  `status=${otvRaschety.res.status}`
);

// Combine sections for tender → dengi, then revoke
const combine = await json("/api/users", {
  method: "PATCH",
  headers: { authorization: `Bearer ${tokens.admin}` },
  body: JSON.stringify({
    id: "u-tender",
    sections: [
      "zakupki",
      "dokumenty",
      "raschety",
      "riski",
      "spravochniki",
      "instrukciya",
      "dengi",
    ],
  }),
});
check("admin combine tender+dengi sections", combine.res.ok, combine.body.error);
const dengiOk = await json("/api/dengi", {
  headers: { authorization: `Bearer ${tokens.tender}` },
});
check("tender can read dengi after combine", dengiOk.res.ok, dengiOk.body.error);
const revoke = await json("/api/users", {
  method: "PATCH",
  headers: { authorization: `Bearer ${tokens.admin}` },
  body: JSON.stringify({
    id: "u-tender",
    sections: [
      "zakupki",
      "dokumenty",
      "raschety",
      "riski",
      "spravochniki",
      "instrukciya",
    ],
  }),
});
check("admin revoke dengi from tender", revoke.res.ok, revoke.body.error);
const dengiDeniedAgain = await json("/api/dengi", {
  headers: { authorization: `Bearer ${tokens.tender}` },
});
check(
  "tender dengi denied after revoke",
  dengiDeniedAgain.res.status === 403,
  `status=${dengiDeniedAgain.res.status}`
);

// Block / unblock rukovoditel
const block = await json("/api/users", {
  method: "PATCH",
  headers: { authorization: `Bearer ${tokens.admin}` },
  body: JSON.stringify({ id: "u-ruk", patch: { blocked: true } }),
});
check("admin block rukovoditel", block.res.ok, block.body.error);
const blockedLogin = await login("ruk@alfastroy.ru", "Ruk123!");
check(
  "blocked rukovoditel cannot login",
  blockedLogin.res.status === 403,
  `status=${blockedLogin.res.status}`
);
const unblock = await json("/api/users", {
  method: "PATCH",
  headers: { authorization: `Bearer ${tokens.admin}` },
  body: JSON.stringify({ id: "u-ruk", patch: { blocked: false } }),
});
check("admin unblock rukovoditel", unblock.res.ok, unblock.body.error);

// Chain ensure + recalc
const proc =
  (bootAlfa.body.data?.procurements ?? []).find((p) => p.id === "p-2") ||
  (bootAlfa.body.data?.procurements ?? [])[0];
const chain = await json("/api/zakupki", {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.tender}` },
  body: JSON.stringify({ action: "ensureChain", id: proc?.id }),
});
check("ensureChain from zakupka", chain.res.ok && Boolean(proc?.id), chain.body.error);
const calcId =
  chain.body.data?.procurements?.find((p) => p.id === proc.id)?.calculationId ||
  bootAlfa.body.data?.calculations?.[0]?.id;
const recalc = await json("/api/raschety", {
  method: "PATCH",
  headers: { authorization: `Bearer ${tokens.smetchik}` },
  body: JSON.stringify({ id: calcId, recalcScenario: "optimisticheskiy" }),
});
check("smetchik recalculate scenario", recalc.res.ok, recalc.body.error || `calcId=${calcId}`);

const schedule = chain.body.data?.schedules?.find(
  (item) => item.procurementId === proc?.id
);
const firstStage = schedule?.stages?.slice().sort((a, b) => a.sequence - b.sequence)[0];
if (schedule && firstStage) {
  const shifted = await json("/api/gpr", {
    method: "PATCH",
    headers: { authorization: `Bearer ${tokens.smetchik}` },
    body: JSON.stringify({
      id: schedule.id,
      action: "shiftStage",
      stageId: firstStage.id,
      deltaDays: 1,
      cascade: true,
    }),
  });
  const shiftedSchedule = shifted.body.data?.schedules?.find((item) => item.id === schedule.id);
  const shiftedStage = shiftedSchedule?.stages?.find((item) => item.id === firstStage.id);
  const movedOk = shifted.res.ok && shiftedStage?.start === addUtcDays(firstStage.start, 1);
  check("GPR date edit cascades and persists", movedOk, shifted.body.error);

  if (shifted.res.ok && shiftedStage) {
    const oldSpan = Math.max(
      1,
      Math.round(
        (new Date(`${shiftedStage.end}T12:00:00Z`).getTime() -
          new Date(`${shiftedStage.start}T12:00:00Z`).getTime()) /
          86400000
      ) + 1
    );
    const resized = await json("/api/gpr", {
      method: "PATCH",
      headers: { authorization: `Bearer ${tokens.smetchik}` },
      body: JSON.stringify({
        id: schedule.id,
        action: "shiftStage",
        stageId: firstStage.id,
        deltaDays: 0,
        resizeDays: oldSpan + 2,
        cascade: true,
      }),
    });
    const resizedStage = resized.body.data?.schedules?.find((item) => item.id === schedule.id)?.stages?.find((item) => item.id === firstStage.id);
    check(
      "GPR duration edit persists",
      resized.res.ok &&
        Boolean(resizedStage) &&
        resizedStage.end === addUtcDays(resizedStage.start, oldSpan + 1),
      resized.body.error
    );
  } else {
    check("GPR duration edit persists", false, shifted.body.error || "stage shift failed");
  }
} else {
  check("GPR date edit cascades and persists", false, "ensureChain did not create a schedule stage");
  check("GPR duration edit persists", false, "ensureChain did not create a schedule stage");
}

// Negative export / file
const foreignCalc = (bootAlfa.body.data?.calculations ?? []).find(
  (c) => c.orgId === "org-alfa"
);
const betaExport = await fetch(
  `${base}/api/export?kind=calc-xlsx&id=${foreignCalc?.id ?? "c-1"}`,
  { headers: { authorization: `Bearer ${betaToken}` } }
);
const betaExportBody = await betaExport.json().catch(() => ({}));
check(
  "beta denied alfa calc export",
  betaExport.status === 403,
  `status=${betaExport.status} err=${betaExportBody.error}`
);

const alfaDoc = (bootAlfa.body.data?.documents ?? []).find((d) => d.orgId === "org-alfa");
const betaFile = await fetch(
  `${base}/api/dokumenty/file?id=${alfaDoc?.id ?? "d-1"}`,
  { headers: { authorization: `Bearer ${betaToken}` } }
);
const betaFileBody = await betaFile.json().catch(() => ({}));
check(
  "beta denied alfa document file",
  betaFile.status === 403,
  `status=${betaFile.status} err=${betaFileBody.error}`
);

// Recovery via local mail sink (server should use MAIL_TRANSPORT=file|memory)
const recoverReq = await json("/api/auth/recover", {
  method: "POST",
  body: JSON.stringify({ email: "object@alfastroy.ru", action: "request" }),
});
check("recovery request accepted", recoverReq.res.ok, recoverReq.body.error);

let recoveryCode = null;
const sinkLatest = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data", "mail-sink", "latest.json");
if (fs.existsSync(sinkLatest)) {
  try {
    const mail = JSON.parse(fs.readFileSync(sinkLatest, "utf8"));
    recoveryCode = mail.text?.match(/Код восстановления:\s*([a-f0-9]+)/i)?.[1];
  } catch {
    /* ignore */
  }
}
if (!recoveryCode && process.env.RECOVER_EXPOSE_CODE === "1") {
  recoveryCode = recoverReq.body.code;
}
check(
  "recovery code available via local sink (or expose flag)",
  Boolean(recoveryCode),
  recoveryCode ? "ok" : "set MAIL_TRANSPORT=file for server or RECOVER_EXPOSE_CODE=1"
);

if (recoveryCode) {
  const newPassword = "E2ERecoverTemp9!";
  const reset = await json("/api/auth/recover", {
    method: "POST",
    body: JSON.stringify({
      email: "object@alfastroy.ru",
      action: "reset",
      code: recoveryCode,
      newPassword,
    }),
  });
  check("recovery reset password", reset.res.ok, reset.body.error);
  const loginNew = await login("object@alfastroy.ru", newPassword);
  check("login with recovered password", loginNew.res.ok, loginNew.body.error);
  // restore
  const restoreReq = await json("/api/auth/recover", {
    method: "POST",
    body: JSON.stringify({ email: "object@alfastroy.ru", action: "request" }),
  });
  let restoreCode = null;
  if (fs.existsSync(sinkLatest)) {
    restoreCode = JSON.parse(fs.readFileSync(sinkLatest, "utf8")).text?.match(
      /Код восстановления:\s*([a-f0-9]+)/i
    )?.[1];
  }
  if (!restoreCode && restoreReq.body.code) restoreCode = restoreReq.body.code;
  if (restoreCode) {
    await json("/api/auth/recover", {
      method: "POST",
      body: JSON.stringify({
        email: "object@alfastroy.ru",
        action: "reset",
        code: restoreCode,
        newPassword: "Object123!",
      }),
    });
  }
} else {
  check("recovery reset password", false, "skipped — no code");
  check("login with recovered password", false, "skipped — no code");
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log("\n=== E2E summary ===");
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
console.log(`total:  ${results.length}`);
console.log("\nNOT covered:");
for (const item of notCovered) console.log(`- ${item}`);

const reportPath = path.join(
  process.cwd(),
  process.env.E2E_REPORT_DIR ?? "data",
  `e2e-report-${Date.now()}.json`
);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(
  reportPath,
  JSON.stringify({ base, passed, failed, total: results.length, results, notCovered }, null, 2)
);
console.log(`\nWrote ${reportPath}`);

if (failed) process.exit(1);
console.log("\nisolated e2e ok");
