/**
 * t25u final combined acceptance (one pass).
 * Real UI/API path only — no CSS injection, no direct DB writes.
 *
 * Env:
 *   BASE_URL, BROWSER_MEDIA_DIR, ACCEPT_OUT, ACCEPT_PASS, GIT_SHA
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { chromium } from "playwright";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");
const media =
  process.env.BROWSER_MEDIA_DIR ??
  "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3/media/tma361/client-corrections-2026-11-08/t25u-final-accept";
const outDir =
  process.env.ACCEPT_OUT ??
  "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3/artifacts/t25u-final-accept";
const passNo = Number(process.env.ACCEPT_PASS ?? "1");
const sha =
  process.env.GIT_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

fs.mkdirSync(media, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const TEST = {
  calcId: "c-t25u-test",
  scheduleId: "g-t25u-test",
  planFactId: "pf-t25u-test",
  date: "2026-11-08",
  work: "Демонтаж перегородок",
  busId: "rst-2-bus",
  stageId: "gst-2",
};

/** Independent hand constants after bus qty 2→3 AND rate 2650→2700 */
const EXPECTED = {
  baselineBusR: 174900, // 2×11×1×3×2650
  Q: 99, // 3×11×1×3
  R: 267300, // 99×2700
  V: 10171048,
  W: 4373550.64,
  X: 14544598.64,
  Y: 5817839.46,
  Z: 20362438.1,
};

const results = {
  sha,
  passNo,
  injections: "none",
  production: false,
  visual1to1:
    "English terms / label density may differ from PDF mock — incomplete visual 1:1; no polish opened",
  expected: EXPECTED,
  actions: [],
  assertions: [],
  shots: [],
  fail: [],
  nofail: true,
};

function act(name, detail) {
  results.actions.push({ name, detail, at: new Date().toISOString() });
  console.log("ACT", name, detail ?? "");
}
function assert(name, expected, actual) {
  const ok =
    expected === actual ||
    (typeof expected === "number" &&
      typeof actual === "number" &&
      Math.abs(expected - actual) < 0.011);
  results.assertions.push({ name, expected, actual, ok });
  if (!ok) {
    results.fail.push({ name, expected, actual });
    results.nofail = false;
    console.error("FAIL", name, { expected, actual });
  } else {
    console.log("OK", name, actual);
  }
  return ok;
}
function assertMatch(name, text, re) {
  const ok = re.test(text);
  results.assertions.push({ name, expected: String(re), actual: ok ? "match" : text.slice(0, 120), ok });
  if (!ok) {
    results.fail.push({ name, expected: String(re), actual: text.slice(0, 200) });
    results.nofail = false;
    console.error("FAIL", name);
  } else console.log("OK", name);
  return ok;
}

async function login(page, email, password) {
  await page.goto(`${base}/login`);
  await page.getByLabel(/email/i).fill(email);
  const pwdTab = page.getByRole("tab", { name: /Пароль/i });
  if (await pwdTab.count()) await pwdTab.click();
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: /Войти/i }).click();
  await page.waitForURL(/\/cabinet/, { timeout: 25000 });
}

async function shot(page, name) {
  const p = path.join(media, `pass${passNo}-${name}`);
  await page.screenshot({ path: p, fullPage: false });
  results.shots.push(p);
  console.log("SHOT", p);
}

function makePng() {
  const p = "/tmp/t25u-final-accept-photo.png";
  fs.writeFileSync(
    p,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6aAAAAAElFTkSuQmCC",
      "base64"
    )
  );
  return p;
}

async function downloadBuf(page, urlPath) {
  const res = await page.request.get(`${base}${urlPath}`);
  if (!res.ok()) throw new Error(`download ${urlPath} → ${res.status()}`);
  return Buffer.from(await res.body());
}

function pdfText(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t25u-acc-pdf-"));
  const pdfPath = path.join(dir, "a.pdf");
  fs.writeFileSync(pdfPath, buf);
  try {
    return execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function loadXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.setDefaultTimeout(40000);

try {
  await login(page, "ruk@alfastroy.ru", "Ruk123!");
  act("login", "ruk@alfastroy.ru");

  // School originals untouched
  await page.goto(`${base}/cabinet/gpr/g-1`);
  await page.waitForTimeout(700);
  assert(
    "school-g1-no-test-banner",
    0,
    await page.getByTestId("t25u-test-banner").count()
  );

  // Estimate: baseline bus leaf
  await page.goto(`${base}/cabinet/raschety/${TEST.calcId}`);
  await page.waitForTimeout(1200);
  assert(
    "test-banner-on-estimate",
    true,
    (await page.getByTestId("t25u-test-banner").count()) > 0
  );
  await page.getByTestId("estimate-expand-all").click();
  await page.waitForTimeout(400);
  const amountBefore = await page.getByTestId(`estimate-amount-${TEST.busId}`).innerText();
  act("baseline-bus-amount-ui", amountBefore);
  // 174900 formatted as money — tolerate spaces/nbsp
  assertMatch("baseline-bus-R-174900-ui", amountBefore.replace(/\s/g, ""), /174.?900/);

  await shot(page, "estimate-title-resources.png");

  // REAL UI path: change BOTH qty and rate on bus leaf (blur commits → patchResource API)
  act("ui-edit-bus-qty-rate", "qty 2→3, rate 2650→2700");
  const qty = page.getByTestId(`estimate-qty-${TEST.busId}`);
  await qty.fill("3");
  await qty.blur();
  await page.waitForTimeout(800);
  const rate = page.getByTestId(`estimate-rate-${TEST.busId}`);
  await rate.fill("2700");
  await rate.blur();
  await page.waitForTimeout(1200);

  // Ordinary reload → re-read
  act("reload-estimate", "ordinary page reload");
  await page.reload();
  await page.waitForTimeout(1200);
  await page.getByTestId("estimate-expand-all").click();
  await page.waitForTimeout(400);

  const qtyAfter = await page.getByTestId(`estimate-qty-${TEST.busId}`).inputValue();
  const rateAfter = await page.getByTestId(`estimate-rate-${TEST.busId}`).inputValue();
  const qAfter = await page.getByTestId(`estimate-q-${TEST.busId}`).innerText();
  const amtAfter = await page.getByTestId(`estimate-amount-${TEST.busId}`).innerText();
  assert("tree-qty-after-reload", "3", qtyAfter);
  assert("tree-rate-after-reload", "2700", rateAfter.replace(/\s/g, "").replace(",", "."));
  assertMatch("tree-Q-99", qAfter.replace(/\s/g, ""), /99/);
  assertMatch("tree-R-267300", amtAfter.replace(/\s/g, ""), /267.?300/);

  // Summary cards show Z (PARTIAL ok)
  const zCard = await page.getByTestId("budget-card-total-z").innerText();
  assertMatch("cards-Z-present", zCard.replace(/\s/g, ""), /20.?362.?438|20362438/);

  // Actual calc-XLSX / calc-PDF export endpoints (same as UI download buttons)
  act("export-calc-xlsx", `/api/export?kind=calc-xlsx&id=${TEST.calcId}`);
  const xlsxBuf = await downloadBuf(
    page,
    `/api/export?kind=calc-xlsx&id=${TEST.calcId}`
  );
  const xwb = await loadXlsx(xlsxBuf);
  const xws = xwb.getWorksheet("Расчёт");
  const xcell = (code) => {
    let v = null;
    xws.eachRow((row) => {
      if (String(row.getCell(1).value) === code) v = Number(row.getCell(6).value);
    });
    return v;
  };
  assert("xlsx-V", EXPECTED.V, xcell("V_direct"));
  assert("xlsx-W", EXPECTED.W, xcell("W_oh43"));
  assert("xlsx-X", EXPECTED.X, xcell("X_cost_oh"));
  assert("xlsx-Y", EXPECTED.Y, xcell("Y_markup40"));
  assert("xlsx-Z", EXPECTED.Z, xcell("Z_total"));

  act("export-calc-pdf", `/api/export?kind=calc-pdf&id=${TEST.calcId}`);
  const pdfBuf = await downloadBuf(
    page,
    `/api/export?kind=calc-pdf&id=${TEST.calcId}`
  );
  const ptxt = pdfText(pdfBuf);
  assertMatch("pdf-V", ptxt, new RegExp(`V direct:\\s*${Math.round(EXPECTED.V)}`));
  assertMatch("pdf-W", ptxt, new RegExp(`W OH43%:\\s*${Math.round(EXPECTED.W)}`));
  assertMatch("pdf-X", ptxt, new RegExp(`X cost\\+OH:\\s*${Math.round(EXPECTED.X)}`));
  assertMatch("pdf-Y", ptxt, new RegExp(`Y markup40%:\\s*${Math.round(EXPECTED.Y)}`));
  assertMatch("pdf-Z", ptxt, new RegExp(`Z TOTAL:\\s*${Math.round(EXPECTED.Z)}`));

  // GPR export — full V–Z + bus R
  act("export-gpr-xlsx", `/api/export?kind=gpr-xlsx&id=${TEST.scheduleId}`);
  const gprBuf = await downloadBuf(
    page,
    `/api/export?kind=gpr-xlsx&id=${TEST.scheduleId}`
  );
  const gwb = await loadXlsx(gprBuf);
  const res = gwb.getWorksheet("Ресурсы");
  let gprR = null;
  res.eachRow((row) => {
    if (String(row.getCell(3).value) === "Автобус доставки") {
      gprR = Number(row.getCell(12).value);
    }
  });
  assert("gpr-bus-R", EXPECTED.R, gprR);
  const rs = gwb.getWorksheet("Ресурсный_параметры");
  const byLabel = new Map();
  rs.eachRow((row) => {
    const label = String(row.getCell(1).value ?? "");
    const val = Number(row.getCell(2).value);
    if (Number.isFinite(val)) byLabel.set(label, val);
  });
  const findVal = (re) => {
    for (const [k, v] of byLabel) if (re.test(k)) return v;
    return null;
  };
  assert("gpr-V", EXPECTED.V, findVal(/Прямые V/));
  assert("gpr-W", EXPECTED.W, findVal(/НР W/));
  assert("gpr-X", EXPECTED.X, findVal(/с НР X/));
  assert("gpr-Y", EXPECTED.Y, findVal(/Прибыль Y/));
  assert("gpr-Z", EXPECTED.Z, findVal(/Итого Z/));

  // Gantt: filter + shift → reload
  await page.goto(`${base}/cabinet/gpr/${TEST.scheduleId}`);
  await page.waitForTimeout(1200);
  assert(
    "test-banner-on-gantt",
    true,
    (await page.getByTestId("t25u-test-banner").count()) > 0
  );
  const rows = page.getByTestId("gantt-rows");
  const allCount = Number(await rows.getAttribute("data-row-count"));
  await page.getByTestId("gantt-resource-filter").selectOption("labor");
  await page.waitForTimeout(400);
  const filtered = Number(await rows.getAttribute("data-row-count"));
  assert("gantt-filter-labor-reduces", true, filtered < allCount);
  await page.getByTestId("gantt-resource-filter").selectOption("all");
  const shift = page.locator('[data-testid^="gantt-shift-right-"]').first();
  if (await shift.count()) {
    await shift.click();
    await page.waitForTimeout(900);
    act("gantt-shift-right", "clicked");
  }
  await page.reload();
  await page.waitForTimeout(1000);
  assert(
    "gantt-after-reload",
    true,
    (await page.getByTestId("plan-fact-gantt").count()) > 0
  );
  await shot(page, "gantt.png");

  // Day: fact + resources + photo → save → reload
  await page.goto(
    `${base}/cabinet/proizvodstvo/day?planFactId=${TEST.planFactId}&date=${TEST.date}&work=${encodeURIComponent(TEST.work)}`
  );
  await page.waitForTimeout(1200);
  assert(
    "test-banner-on-day",
    true,
    (await page.getByTestId("t25u-test-banner").count()) > 0
  );
  await shot(page, "day-top.png");

  const people = page.getByTestId("day-people-list");
  if (await people.count()) {
    const factInput = people.locator('input[type="number"]').first();
    if (await factInput.count()) {
      await factInput.fill("2");
      act("day-fact-edit", "2");
    }
  }
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(makePng());
    act("day-photo-upload", "png");
    await page.waitForTimeout(800);
  }
  const saveBtn = page.getByRole("button", { name: /Сохранить|Save/i }).first();
  if (await saveBtn.count()) {
    await saveBtn.click();
    await page.waitForTimeout(1200);
    act("day-save", "clicked");
  }
  await page.reload();
  await page.waitForTimeout(1200);
  const photo = page.getByTestId("day-photo-report");
  assert("day-photo-preserved", true, (await photo.count()) > 0);
  await shot(page, "day-bottom-fact-photo.png");
  if (await photo.count()) {
    const photoShot = path.join(media, `pass${passNo}-day-photo-report.png`);
    await photo.screenshot({ path: photoShot });
    results.shots.push(photoShot);
  }
} catch (e) {
  results.nofail = false;
  results.fail.push({ name: "uncaught", expected: "ok", actual: String(e?.stack || e) });
  console.error(e);
} finally {
  await browser.close();
  const out = path.join(outDir, `pass${passNo}-accept.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log("RESULT", out, JSON.stringify({ nofail: results.nofail, fails: results.fail.length, sha }));
  if (!results.nofail) process.exit(1);
}
