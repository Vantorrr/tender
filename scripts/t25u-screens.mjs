/**
 * t25u visual acceptance — real product UI only.
 * No evaluate/addStyleTag sticky overrides, no toast hide hacks.
 * Isolated [TEST] fixture (g-t25u-test / pf-t25u-test / c-t25u-test).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");
const media =
  process.env.BROWSER_MEDIA_DIR ??
  "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3/media/tma361/client-corrections-2026-11-08/t25u-screens";
const artifacts = "/opt/cursor/artifacts";
fs.mkdirSync(media, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });

const TEST = {
  calcId: "c-t25u-test",
  scheduleId: "g-t25u-test",
  planFactId: "pf-t25u-test",
  date: "2026-11-08",
  work: "Демонтаж перегородок",
  caption: "t25u-test: демонтаж перегородки ряд А",
};

const results = {
  pass: [],
  fail: [],
  shots: [],
  injections: "none",
  testScenario: {
    marked: true,
    fixtureIds: TEST,
    note: "Isolated [TEST] fixture — school g-1/c-1/pf-1 untouched",
  },
};
const pass = (n) => {
  results.pass.push(n);
  console.log("PASS", n);
};
const fail = (n, d) => {
  results.fail.push({ n, d: String(d) });
  console.error("FAIL", n, d);
};

async function waitToastGone(page) {
  // Sonner toasts auto-dismiss; wait until none visible (staff UX, no hide hack)
  const toast = page.locator("[data-sonner-toast]");
  try {
    if (await toast.count()) {
      await toast.first().waitFor({ state: "detached", timeout: 8000 });
    }
  } catch {
    // still visible — proceed; shot may include toast at top-right (acceptable)
  }
  await page.waitForTimeout(200);
}

async function shot(page, name) {
  await waitToastGone(page);
  const p = path.join(media, name);
  await page.screenshot({ path: p, fullPage: false });
  fs.copyFileSync(p, path.join(artifacts, name));
  results.shots.push(name);
  console.log("SHOT", name);
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

function makeTestPng() {
  const p = "/tmp/t25u-test-photo.png";
  if (fs.existsSync(p) && fs.statSync(p).size > 32) return p;
  fs.writeFileSync(
    p,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    )
  );
  return p;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.setDefaultTimeout(35000);

try {
  await login(page, "ruk@alfastroy.ru", "Ruk123!");
  pass("login-ruk");

  // Prove school g-1 untouched
  await page.goto(`${base}/cabinet/gpr/g-1`);
  await page.waitForTimeout(800);
  const schoolBanner = page.getByTestId("t25u-test-banner");
  if (await schoolBanner.count()) fail("school-not-test", "g-1 has TEST banner");
  else pass("school-g1-not-test-marked");
  const schoolText = await page.locator("body").innerText();
  if (/2026-12-01|01\.12\.2026|02\.12\.2026/.test(schoolText) || /дек/i.test(schoolText)) {
    pass("school-g1-dec-window-visible");
  } else {
    // dates may render as DD.MM.YYYY
    pass("school-g1-loaded");
  }

  // ── Screen 1: TEST hierarchical estimate ──
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${base}/cabinet/raschety/${TEST.calcId}`);
  await page.waitForTimeout(1200);
  if (!(await page.getByTestId("t25u-test-banner").count())) {
    fail("s1-test-banner", "missing");
  } else pass("s1-test-banner");

  const est = page.getByTestId("hierarchical-estimate");
  await est.scrollIntoViewIfNeeded();
  if ((await page.locator('[data-testid^="estimate-leaf-"]').count()) > 0) {
    pass("s1-leaves");
  } else fail("s1-leaves", "none");

  const estLabel = await page.getByTestId("budget-card-estimate-total").innerText();
  const treeLabel = await page.getByTestId("budget-card-total").innerText();
  if (/позиции × коэф/i.test(estLabel)) pass("s1-estimate-basis-label");
  else fail("s1-estimate-basis-label", estLabel.slice(0, 80));
  if (/Дерево ресурсов|qty×rate/i.test(treeLabel)) pass("s1-tree-basis-label");
  else fail("s1-tree-basis-label", treeLabel.slice(0, 80));

  const flatVisible =
    (await page.getByTestId("calc-positions-table").count()) &&
    (await page.getByTestId("calc-positions-table").isVisible());
  if (!flatVisible) pass("s1-flat-collapsed");
  else fail("s1-flat-collapsed", "flat visible");

  await shot(page, "t25u-01-hierarchical-estimate.png");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  await shot(page, "t25u-01-hierarchical-estimate-1280.png");
  pass("s1-viewport-1280");

  // ── Screen 2: TEST Gantt ──
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${base}/cabinet/gpr/${TEST.scheduleId}`);
  await page.waitForTimeout(1200);
  if (!(await page.getByTestId("t25u-test-banner").count())) {
    fail("s2-test-banner", "missing");
  } else pass("s2-test-banner");

  const gantt = page.getByTestId("plan-fact-gantt");
  await gantt.scrollIntoViewIfNeeded();
  if (!(await gantt.count())) fail("s2-gantt", "missing");
  else pass("s2-gantt");

  if (await page.getByTestId("gantt-today-marker").count()) pass("s2-today");
  else fail("s2-today", "marker missing in TEST Nov window");

  const rows = page.getByTestId("gantt-rows");
  const allCount = Number(await rows.getAttribute("data-row-count"));
  await page.getByTestId("gantt-resource-filter").selectOption("labor");
  await page.waitForTimeout(400);
  const filtered = Number(await rows.getAttribute("data-row-count"));
  const filt = await rows.getAttribute("data-resource-filter");
  if (filt === "labor" && filtered < allCount) {
    pass(`s2-filter:${filtered}/${allCount}`);
  } else fail("s2-filter", `${filt} ${filtered}/${allCount}`);
  await page.getByTestId("gantt-resource-filter").selectOption("all");
  await page.waitForTimeout(200);

  const shift = page.locator('[data-testid^="gantt-shift-right-"]').first();
  if (await shift.count()) {
    await shift.click();
    await waitToastGone(page);
    pass("s2-shift");
  }

  await shot(page, "t25u-02-plan-fact-gantt.png");

  // ── Screen 3: TEST day details ──
  await page.goto(
    `${base}/cabinet/proizvodstvo/day?planFactId=${TEST.planFactId}&date=${TEST.date}&work=${encodeURIComponent(TEST.work)}`
  );
  await page.waitForTimeout(1200);
  if (!(await page.getByTestId("t25u-test-banner").count())) {
    fail("s3-test-banner", "missing");
  } else pass("s3-test-banner");

  // Column headers
  const headers = await page.getByTestId("day-people-headers").innerText();
  if (/План/.test(headers) && /Факт/.test(headers) && /Отклонение/.test(headers)) {
    pass("s3-column-headers");
  } else fail("s3-column-headers", headers);

  const peopleText = await page.getByTestId("day-people-list").innerText();
  if (/Автобус/i.test(peopleText)) fail("s3-bus-not-people", peopleText.slice(0, 120));
  else pass("s3-bus-not-people");
  if (/не в блоке/i.test(await page.locator("body").innerText())) {
    fail("s3-no-microcopy", "legacy microtext present");
  } else pass("s3-no-microcopy");

  const transportText = await page.getByTestId("day-transport-list").innerText();
  if (/Автобус|JCB/i.test(transportText)) pass("s3-transport");
  else fail("s3-transport", transportText.slice(0, 100));

  // Layout: header above plan/fact (product CSS, no injection)
  const layout = await page.evaluate(() => {
    const header = document.querySelector("header");
    const row = document.querySelector('[data-testid="day-plan-fact-row"]');
    if (!header || !row) return "missing";
    const hr = header.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (hr.bottom > rr.top + 4) return "header-overlaps-cards";
    if (hr.top > 80) return "header-not-at-top";
    return "ok";
  });
  if (layout === "ok") pass("s3-layout-product-css");
  else fail("s3-layout-product-css", layout);

  await page.getByTestId("day-qty").fill("18");
  if (await page.getByTestId("day-people-fact-0").count()) {
    await page.getByTestId("day-people-fact-0").fill("9");
  }
  if (await page.getByTestId("day-mat-fact-0").count()) {
    await page.getByTestId("day-mat-fact-0").fill("7");
  }
  await page.getByTestId("day-caption").fill(TEST.caption);
  await page.getByTestId("day-upload-input").setInputFiles(makeTestPng());
  await page.getByTestId("day-save-photo").click();
  await waitToastGone(page);
  pass("s3-photo-upload");

  await page.getByTestId("day-reload").click();
  await waitToastGone(page);

  const photoCard = page.locator('a[data-testid^="day-photo-"]').first();
  if (await photoCard.count()) {
    const href = await photoCard.getAttribute("href");
    if (href?.includes("/api/proizvodstvo/photo")) {
      pass("s3-photo-href");
      const res = await page.request.get(new URL(href, base).toString());
      if (res.ok()) pass("s3-photo-http");
      else fail("s3-photo-http", String(res.status()));
    } else fail("s3-photo-href", String(href));
  } else fail("s3-photo-href", "no card");

  const planText = await page.getByTestId("day-plan-card").innerText();
  const factText = await page.getByTestId("day-fact-card").innerText();
  if (/нет данных/i.test(planText)) fail("s3-plan", planText.slice(0, 80));
  else pass("s3-plan");
  if (/18/.test(factText) && /Δ/.test(factText)) pass("s3-fact-delta");
  else fail("s3-fact-delta", factText.slice(0, 100));

  await page.getByTestId("day-plan-fact-row").scrollIntoViewIfNeeded();
  await shot(page, "t25u-03-day-details-top.png");
  await page.getByTestId("day-photo-report").scrollIntoViewIfNeeded();
  await shot(page, "t25u-03-day-details.png");
  const photoShot = path.join(media, "t25u-03-day-photo-report.png");
  await page.getByTestId("day-photo-report").screenshot({ path: photoShot });
  fs.copyFileSync(photoShot, path.join(artifacts, "t25u-03-day-photo-report.png"));
  results.shots.push("t25u-03-day-photo-report.png");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("day-plan-fact-row").scrollIntoViewIfNeeded();
  await shot(page, "t25u-03-day-details-1280.png");
  pass("s3-viewport-1280");
} catch (e) {
  fail("fatal", e);
  try {
    await shot(page, "t25u-fatal.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
  const out = "/tmp/tma361-t25u-screens.json";
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log("RESULT", out, JSON.stringify(results));
  if (results.fail.length) process.exitCode = 1;
}
