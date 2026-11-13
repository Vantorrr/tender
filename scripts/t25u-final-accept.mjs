/**
 * t25u final combined acceptance (one pass) — hard expected/actual asserts.
 * Real UI/API only. No CSS injection. No invented filter persistence.
 *
 * Env: BASE_URL, BROWSER_MEDIA_DIR, ACCEPT_OUT, ACCEPT_PASS, GIT_SHA
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import ExcelJS from "exceljs";
import { chromium } from "playwright";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");
const media =
  process.env.BROWSER_MEDIA_DIR ??
  "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3/media/tma361/client-corrections-2026-11-08/t25u-accept-assert-fix";
const outDir =
  process.env.ACCEPT_OUT ??
  "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3/artifacts/t25u-accept-assert-fix";
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
  baselineBusR: 174900,
  Q: 99,
  R: 267300,
  V: 10171048,
  W: 4373550.64,
  X: 14544598.64,
  Y: 5817839.46,
  Z: 20362438.1,
  dayQty: 18,
  peopleFact: 9,
};

const CAPTION = `t25u-accept-p${passNo}-${sha.slice(0, 7)}-vol18`;

const results = {
  sha,
  passNo,
  injections: "none",
  production: false,
  limitations: {
    visual1to1:
      "English export terms / label density vs PDF mock — incomplete visual 1:1; no polish opened",
    ganttFilter:
      "Resource filter is ephemeral UI state — verified before reload only; does NOT persist after reload (not invented sticky)",
    priorFalsePositive:
      "bc8d79a day/photo asserts were false positives (wrong field + save(false) + empty gallery exists-check) — corrected here",
  },
  expected: { ...EXPECTED, caption: CAPTION },
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
  } else console.log("OK", name, actual);
  return ok;
}
function assertMatch(name, text, re) {
  const ok = re.test(String(text ?? ""));
  results.assertions.push({
    name,
    expected: String(re),
    actual: ok ? "match" : String(text).slice(0, 160),
    ok,
  });
  if (!ok) {
    results.fail.push({
      name,
      expected: String(re),
      actual: String(text).slice(0, 240),
    });
    results.nofail = false;
    console.error("FAIL", name, String(text).slice(0, 120));
  } else console.log("OK", name);
  return ok;
}
function digits(s) {
  return String(s ?? "").replace(/[^\d]/g, "");
}
async function login(page, email, password) {
  // Prefer API session cookie — UI login is flaky under cold Next compiles.
  const api = await page.request.post(`${base}/api/auth/login`, {
    data: { email, password },
  });
  if (api.ok()) {
    await gotoStable(page, `${base}/cabinet`);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    const emailField = page.getByLabel(/email|почта|e-mail/i).or(
      page.locator('input[type="email"], input[name="email"]').first()
    );
    try {
      await emailField.first().waitFor({ state: "visible", timeout: 15000 });
      await emailField.first().fill(email);
      const pwdTab = page.getByRole("tab", { name: /Пароль/i });
      if (await pwdTab.count()) await pwdTab.click();
      await page.locator('input[type="password"]').first().fill(password);
      await page.getByRole("button", { name: /Войти/i }).click();
      await page.waitForURL(/\/cabinet/, { timeout: 25000 });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      await page.waitForTimeout(1500 * attempt);
    }
  }
}

/** Avoid load races when Next soft-navigates mid-goto. */
async function gotoStable(page, url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(400);
      const here = page.url();
      if (here.includes("/login")) {
        const api = await page.request.post(`${base}/api/auth/login`, {
          data: { email: "ruk@alfastroy.ru", password: "Ruk123!" },
        });
        if (!api.ok()) throw new Error(`relogin ${api.status()}`);
        continue;
      }
      const want = new URL(url).pathname;
      if (new URL(here).pathname === want || here.startsWith(url.split("?")[0])) {
        return;
      }
    } catch (err) {
      if (attempt === 4) throw err;
      await page.waitForTimeout(500 * attempt);
    }
  }
  throw new Error(`gotoStable failed for ${url} (at ${page.url()})`);
}

async function shot(page, name) {
  const p = path.join(media, `pass${passNo}-${name}`);
  await page.screenshot({ path: p, fullPage: false });
  results.shots.push(p);
  console.log("SHOT", p);
  return p;
}

/** Visible RGB PNG (not 1×1) so day-bottom shot proves real upload. */
function makePng() {
  const p = path.join(os.tmpdir(), `t25u-accept-p${passNo}.png`);
  const w = 64;
  const h = 48;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = 20;
      raw[i + 1] = 160;
      raw[i + 2] = 90; // teal-ish so visible vs white UI
    }
  }
  const crc = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc(Buffer.concat([typeB, data])));
    return Buffer.concat([len, typeB, data, crcB]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(p, png);
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
    return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function loadXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

async function scheduleStage(page, stageId) {
  const res = await page.request.get(`${base}/api/gpr`);
  if (!res.ok()) throw new Error(`GET /api/gpr ${res.status()}`);
  const body = await res.json();
  const items = body.items ?? body.data?.schedules ?? [];
  const sch =
    items.find((s) => s.id === TEST.scheduleId) ??
    (body.data?.schedules || []).find((s) => s.id === TEST.scheduleId);
  if (!sch) throw new Error("TEST schedule missing from /api/gpr");
  const st = (sch.stages ?? []).find((s) => s.id === stageId);
  if (!st) throw new Error(`stage ${stageId} missing`);
  return st;
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtUi(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.setDefaultTimeout(45000);

try {
  await login(page, "ruk@alfastroy.ru", "Ruk123!");
  act("login", "ruk@alfastroy.ru");

  await gotoStable(page, `${base}/cabinet/gpr/g-1`);
  await page.waitForTimeout(600);
  assert(
    "school-g1-no-test-banner",
    0,
    await page.getByTestId("t25u-test-banner").count()
  );

  // ── Estimate: mutate bus via real UI ──
  await gotoStable(page, `${base}/cabinet/raschety/${TEST.calcId}`);
  await page.waitForTimeout(1200);
  assert(
    "test-banner-on-estimate",
    true,
    (await page.getByTestId("t25u-test-banner").count()) > 0
  );
  await page.getByTestId("estimate-expand-all").click();
  await page.waitForTimeout(400);
  assertMatch(
    "baseline-bus-R-174900-ui",
    (await page.getByTestId(`estimate-amount-${TEST.busId}`).innerText()).replace(
      /\s/g,
      ""
    ),
    /174.?900/
  );

  act("ui-edit-bus-qty-rate", "qty 2→3, rate 2650→2700");
  const qtyEl = page.getByTestId(`estimate-qty-${TEST.busId}`);
  await qtyEl.fill("3");
  await qtyEl.blur();
  await page.waitForTimeout(700);
  const rateEl = page.getByTestId(`estimate-rate-${TEST.busId}`);
  await rateEl.fill("2700");
  await rateEl.blur();
  await page.waitForTimeout(1200);

  act("reload-estimate", "ordinary page reload");
  await page.reload();
  await page.waitForTimeout(1200);
  await page.getByTestId("estimate-expand-all").click();
  await page.waitForTimeout(400);

  assert(
    "tree-qty-after-reload",
    "3",
    await page.getByTestId(`estimate-qty-${TEST.busId}`).inputValue()
  );
  assert(
    "tree-rate-after-reload",
    "2700",
    (await page.getByTestId(`estimate-rate-${TEST.busId}`).inputValue())
      .replace(/\s/g, "")
      .replace(",", ".")
  );
  assertMatch(
    "tree-Q-99",
    (await page.getByTestId(`estimate-q-${TEST.busId}`).innerText()).replace(
      /\s/g,
      ""
    ),
    /99/
  );
  assertMatch(
    "tree-R-267300",
    (
      await page.getByTestId(`estimate-amount-${TEST.busId}`).innerText()
    ).replace(/\s/g, ""),
    /267.?300/
  );

  // UI cards: all V/W/X/Y/Z (formatMoney → whole rubles).
  // W/Z cards nest X/Y sublabels — read primary .text-2xl/.text-xl only.
  const uiRound = {
    V: Math.round(EXPECTED.V),
    W: Math.round(EXPECTED.W),
    X: Math.round(EXPECTED.X),
    Y: Math.round(EXPECTED.Y),
    Z: Math.round(EXPECTED.Z),
  };
  async function cardMainDigits(testId) {
    const card = page.getByTestId(testId);
    const main = card.locator(".text-2xl, .text-xl").first();
    if ((await main.count()) > 0) return digits(await main.innerText());
    // Sublabel-only nodes (X/Y): strip letters, take last/first number group carefully
    const t = (await card.innerText()).replace(/\u00a0/g, " ");
    const m = t.match(/(\d[\d\s]*)/g);
    return m ? digits(m[m.length - 1]) : digits(t);
  }
  assert("ui-card-V", String(uiRound.V), await cardMainDigits("budget-card-direct-v"));
  assert("ui-card-W", String(uiRound.W), await cardMainDigits("budget-card-oh-w"));
  assert("ui-card-X", String(uiRound.X), await cardMainDigits("budget-card-x"));
  assert("ui-card-Y", String(uiRound.Y), await cardMainDigits("budget-card-y"));
  assert("ui-card-Z", String(uiRound.Z), await cardMainDigits("budget-card-total-z"));

  await shot(page, "estimate-title-resources.png");

  // Exports (unchanged constants)
  act("export-calc-xlsx", "calc-xlsx");
  const xlsxBuf = await downloadBuf(
    page,
    `/api/export?kind=calc-xlsx&id=${TEST.calcId}`
  );
  const xws = (await loadXlsx(xlsxBuf)).getWorksheet("Расчёт");
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

  act("export-calc-pdf", "calc-pdf");
  const ptxt = pdfText(
    await downloadBuf(page, `/api/export?kind=calc-pdf&id=${TEST.calcId}`)
  );
  // PDF is Russian (Прямые затраты V / … / Итого … Z) with ru-RU spaced numbers.
  const pdfCompact = String(ptxt ?? "").replace(/\s/g, "");
  function pdfHas(label, amount) {
    const formatted = (Math.round(amount * 100) / 100)
      .toLocaleString("ru-RU", { maximumFractionDigits: 2 })
      .replace(/\s/g, "");
    return pdfCompact.includes(`${label.replace(/\s/g, "")}${formatted}`);
  }
  assert("pdf-V", true, pdfHas("Прямые затраты V:", EXPECTED.V));
  assert("pdf-W", true, pdfHas("Накладные W:", EXPECTED.W));
  assert("pdf-X", true, pdfHas("Себестоимость с накладными X:", EXPECTED.X));
  assert("pdf-Y", true, pdfHas("Прибыль Y:", EXPECTED.Y));
  assert("pdf-Z", true, pdfHas("Итого ресурсного черновика Z:", EXPECTED.Z));

  act("export-gpr-xlsx", "gpr-xlsx");
  const gwb = await loadXlsx(
    await downloadBuf(page, `/api/export?kind=gpr-xlsx&id=${TEST.scheduleId}`)
  );
  let gprR = null;
  gwb.getWorksheet("Ресурсы").eachRow((row) => {
    if (String(row.getCell(3).value) === "Автобус доставки") {
      gprR = Number(row.getCell(12).value);
    }
  });
  assert("gpr-bus-R", EXPECTED.R, gprR);
  const byLabel = new Map();
  gwb.getWorksheet("Ресурсный_параметры").eachRow((row) => {
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

  // ── Gantt: filter effect BEFORE reload; shift +1 day persists ──
  await gotoStable(page, `${base}/cabinet/gpr/${TEST.scheduleId}`);
  await page.waitForTimeout(1200);
  assert(
    "test-banner-on-gantt",
    true,
    (await page.getByTestId("t25u-test-banner").count()) > 0
  );

  const beforeStage = await scheduleStage(page, TEST.stageId);
  act("gantt-dates-before", `${beforeStage.start}..${beforeStage.end}`);
  const rows = page.getByTestId("gantt-rows");
  const allCount = Number(await rows.getAttribute("data-row-count"));
  await page.getByTestId("gantt-resource-filter").selectOption("labor");
  await page.waitForTimeout(400);
  const filtered = Number(await rows.getAttribute("data-row-count"));
  const filtAttr = await rows.getAttribute("data-resource-filter");
  assert("gantt-filter-labor-before-reload", "labor", filtAttr);
  assert("gantt-filter-reduces-before-reload", true, filtered < allCount);
  // Honest: clear filter is UI-only; do not claim persistence
  await page.getByTestId("gantt-resource-filter").selectOption("all");

  const shiftBtn = page.getByTestId(`gantt-shift-right-${TEST.stageId}`);
  assert("gantt-shift-btn-present", true, (await shiftBtn.count()) > 0);
  await shiftBtn.click();
  await page.waitForTimeout(1200);
  act("gantt-shift-right", `${TEST.stageId} +1 day`);

  await page.reload();
  await page.waitForTimeout(1200);
  const afterStage = await scheduleStage(page, TEST.stageId);
  const expectStart = addDaysIso(beforeStage.start, 1);
  const expectEnd = addDaysIso(beforeStage.end, 1);
  assert("gantt-start-plus1-api", expectStart, afterStage.start);
  assert("gantt-end-plus1-api", expectEnd, afterStage.end);
  const ganttBody = await page.getByTestId("plan-fact-gantt").innerText();
  assertMatch(
    "gantt-start-plus1-ui",
    ganttBody,
    new RegExp(fmtUi(expectStart).replace(/\./g, "\\."))
  );
  assertMatch(
    "gantt-end-plus1-ui",
    ganttBody,
    new RegExp(fmtUi(expectEnd).replace(/\./g, "\\."))
  );
  // Filter after reload: ephemeral — document actual state, do not invent sticky
  const filtAfter = await page
    .getByTestId("gantt-rows")
    .getAttribute("data-resource-filter");
  results.assertions.push({
    name: "gantt-filter-after-reload-documented-ephemeral",
    expected: "all|null (ephemeral; not required sticky)",
    actual: filtAfter,
    ok: true,
  });
  act("gantt-filter-after-reload", filtAfter);
  // Early gantt shot is before day facts — retaken after day save for consistency.
  await shot(page, "gantt-before-day.png");

  // ── Day: volume + people + photo via correct controls ──
  const dayUrl = `${base}/cabinet/proizvodstvo/day?planFactId=${TEST.planFactId}&date=${TEST.date}&work=${encodeURIComponent(TEST.work)}`;
  await gotoStable(page, dayUrl);
  await page.waitForTimeout(1200);
  assert(
    "test-banner-on-day",
    true,
    (await page.getByTestId("t25u-test-banner").count()) > 0
  );
  assert(
    "day-work-locked",
    TEST.work,
    (await page.getByTestId("day-work").inputValue().catch(() => null)) ??
      (await page.getByTestId("day-work").innerText())
  );
  assertMatch(
    "day-date-locked",
    await page.getByTestId("day-date").inputValue().catch(async () =>
      page.getByTestId("day-date").innerText()
    ),
    /2026-11-08|08\.11\.2026/
  );

  const photosBefore = await page.locator('a[data-testid^="day-photo-"]').count();
  act("day-photos-before", String(photosBefore));

  // Explicit Fact m² field — NOT people
  const dayQty = page.getByTestId("day-qty");
  assert("day-qty-present", true, (await dayQty.count()) > 0);
  await dayQty.fill(String(EXPECTED.dayQty));
  act("day-qty-fill", String(EXPECTED.dayQty));

  const peopleFact = page.getByTestId("day-people-fact-0");
  assert("day-people-fact-0-present", true, (await peopleFact.count()) > 0);
  await peopleFact.fill(String(EXPECTED.peopleFact));
  act("day-people-fact-fill", String(EXPECTED.peopleFact));

  await page.getByTestId("day-caption").fill(CAPTION);
  const pngPath = makePng();
  await page.getByTestId("day-upload-input").setInputFiles(pngPath);
  act("day-photo-file", pngPath);

  // Must use Факт + фото → save(true)
  await page.getByTestId("day-save-photo").click();
  act("day-save-photo", "save(true)");
  await page.waitForTimeout(2000);

  // Ordinary reload — same work+date URL
  await gotoStable(page, dayUrl);
  await page.waitForTimeout(1200);
  assert(
    "day-work-same-after-reload",
    true,
    (await page.locator("body").innerText()).includes(TEST.work)
  );

  const qtyAfter = await page.getByTestId("day-qty").inputValue();
  assert("day-qty-after-reload", String(EXPECTED.dayQty), qtyAfter);

  const peopleAfter = await page.getByTestId("day-people-fact-0").inputValue();
  assert(
    "day-people-fact-after-reload",
    String(EXPECTED.peopleFact),
    peopleAfter
  );

  const factCard = await page.getByTestId("day-fact-card").innerText();
  assertMatch(
    "day-fact-card-volume-18",
    factCard.replace(/\s/g, ""),
    /18/
  );
  assertMatch("day-fact-card-accumulated", factCard, /Накоплено/);

  // Photo: unique caption + real img + HTTP PNG
  const photosAfter = await page.locator('a[data-testid^="day-photo-"]').count();
  assert("day-photo-count-increased", true, photosAfter > photosBefore);

  const captionLoc = page
    .locator('a[data-testid^="day-photo-"]')
    .filter({ hasText: CAPTION });
  assert("day-photo-caption-present", true, (await captionLoc.count()) > 0);
  const photoCard = captionLoc.first();
  const href = await photoCard.getAttribute("href");
  assertMatch("day-photo-href", href, /\/api\/proizvodstvo\/photo\?id=/);
  const img = photoCard.locator("img");
  assert("day-photo-img-present", true, (await img.count()) > 0);
  const imgSrc = await img.getAttribute("src");
  assertMatch("day-photo-img-src", imgSrc, /\/api\/proizvodstvo\/photo\?id=/);

  const imgRes = await page.request.get(new URL(imgSrc, base).toString());
  assert("day-photo-http-status", 200, imgRes.status());
  const imgBody = Buffer.from(await imgRes.body());
  assert(
    "day-photo-png-magic",
    "89504e47",
    imgBody.subarray(0, 4).toString("hex")
  );
  assert("day-photo-bytes-gt-100", true, imgBody.length > 100);

  // Screens AFTER save/reload
  await page.evaluate(() => {
    const main = document.querySelector('[data-testid="cabinet-main-scroll"]');
    if (main) main.scrollTop = 0;
    else window.scrollTo(0, 0);
  });
  await page.waitForTimeout(200);
  await shot(page, "day-top.png");
  await page.getByTestId("day-photo-report").scrollIntoViewIfNeeded();
  await shot(page, "day-bottom-fact-photo.png");
  const photoShot = path.join(media, `pass${passNo}-day-photo-card.png`);
  await photoCard.screenshot({ path: photoShot });
  results.shots.push(photoShot);

  // ── Gantt after day save: daily facts must match the same fixture ──
  await gotoStable(page, `${base}/cabinet/gpr/${TEST.scheduleId}`);
  await page.waitForTimeout(1200);
  const dailyFactsAttr = await page
    .getByTestId("gantt-daily-facts-count")
    .getAttribute("data-daily-facts");
  const dailyFactsCount = Number(dailyFactsAttr ?? "0");
  assert("gantt-daily-facts-after-day-save", true, dailyFactsCount >= 1);
  const ganttAfterDay = await page.getByTestId("plan-fact-gantt").innerText();
  assertMatch("gantt-daily-facts-label-nonzero", ganttAfterDay, /Дневных фактов:\s*[1-9]/);
  assert(
    "gantt-title-once",
    1,
    (await page.getByTestId("gantt-title").count())
  );
  await page.getByTestId("plan-fact-gantt").scrollIntoViewIfNeeded();
  await shot(page, "gantt.png");
} catch (e) {
  results.nofail = false;
  results.fail.push({
    name: "uncaught",
    expected: "ok",
    actual: String(e?.stack || e),
  });
  console.error(e);
} finally {
  await browser.close();
  const out = path.join(outDir, `pass${passNo}-accept.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(
    "RESULT",
    out,
    JSON.stringify({
      nofail: results.nofail,
      fails: results.fail.length,
      sha,
      failNames: results.fail.map((f) => f.name),
    })
  );
  if (!results.nofail) process.exit(1);
}
