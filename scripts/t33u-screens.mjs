/**
 * t33u Bugbot-tails screenshots: day card, Gantt cost (+ bus), DateInputRu distinct, Obmen.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");
const sha = (process.env.T33U_SHA ?? "tip").slice(0, 7);
const store = "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3";
const media = path.join(
  store,
  `media/tma361/client-corrections-2026-11-08/t33u-screens-${sha}`
);
const artifacts = path.join(store, `artifacts/t33u-${sha}`);
const optArtifacts = "/opt/cursor/artifacts";
for (const d of [media, artifacts, optArtifacts]) fs.mkdirSync(d, { recursive: true });

const TEST = {
  scheduleId: "g-t25u-test",
  planFactId: "pf-t25u-test",
  date: "2026-11-08",
  work: "Демонтаж перегородок",
  procurementId: "p-t25u-test",
  demontazhStageId: "gst-2",
  mobilizStageId: "gst-1",
};

async function shot(page, name, clip) {
  const p = path.join(media, name);
  if (clip) {
    await page.screenshot({ path: p, clip });
  } else {
    await page.screenshot({ path: p, fullPage: false });
  }
  fs.copyFileSync(p, path.join(artifacts, name));
  fs.copyFileSync(p, path.join(optArtifacts, `t33u-${name}`));
  console.log("SHOT", p);
}

async function login(page) {
  await page.goto(`${base}/login`);
  await page.getByLabel(/email/i).fill("ruk@alfastroy.ru");
  const pwdTab = page.getByRole("tab", { name: /Пароль/i });
  if (await pwdTab.count()) await pwdTab.click();
  await page.locator('input[type="password"]').first().fill("Ruk123!");
  await page.getByRole("button", { name: /Войти/i }).click();
  await page.waitForURL(/\/cabinet/, { timeout: 30000 });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.setDefaultTimeout(40000);

try {
  await login(page);

  // ── Day plan (reference, not date demo) ──
  const dayUrl = `${base}/cabinet/proizvodstvo/day?planFactId=${encodeURIComponent(TEST.planFactId)}&date=${TEST.date}&work=${encodeURIComponent(TEST.work)}`;
  await page.goto(dayUrl);
  await page.waitForSelector('[data-testid="day-plan-fact-row"]', { timeout: 20000 });
  await page.waitForTimeout(500);
  await shot(page, "day-plan-fact.png");

  // ── DateInputRu (a): invalid with visible error ──
  const dateInput = page.locator('[data-testid="day-date"]');
  await dateInput.click({ clickCount: 3 });
  await dateInput.fill("32.13.2026");
  await page.waitForSelector('[data-testid="day-date-error"]', { timeout: 5000 });
  // Crop tightly around date field + error (distinct from day-plan-fact)
  const box = await page.locator('[data-testid="day-date"]').evaluate((el) => {
    const root = el.closest("div.grid")?.parentElement ?? el.parentElement;
    const r = root.getBoundingClientRect();
    return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(420, r.width + 24), height: Math.min(120, r.height + 48) };
  });
  await shot(page, "date-input-ru-invalid.png", box);
  // Also full viewport crop of the date controls only area
  await page.locator('[data-testid="day-date-error"]').scrollIntoViewIfNeeded();
  await shot(page, "date-input-ru.png", {
    x: 240,
    y: 160,
    width: 520,
    height: 160,
  });

  // ── DateInputRu (b): valid after blur + reload, no day-shift ──
  await dateInput.click({ clickCount: 3 });
  await dateInput.fill("09.11.2026");
  await dateInput.press("Tab");
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="day-date"]');
    return el && el.value === "09.11.2026";
  });
  await page.waitForURL(/date=2026-11-09/, { timeout: 10000 });
  const afterBlur = await page.locator('[data-testid="day-date"]').inputValue();
  if (afterBlur !== "09.11.2026") throw new Error(`blur value ${afterBlur}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="day-date"]', { timeout: 15000 });
  await page.waitForTimeout(400);
  const afterReload = await page.locator('[data-testid="day-date"]').inputValue();
  if (afterReload !== "09.11.2026") {
    throw new Error(`reload day-shift: got ${afterReload}, want 09.11.2026`);
  }
  if (!page.url().includes("2026-11-09")) {
    throw new Error(`reload URL missing ISO date: ${page.url()}`);
  }
  await shot(page, "date-input-ru-valid-reload.png", {
    x: 240,
    y: 160,
    width: 520,
    height: 140,
  });
  console.log("DATE_OK", { afterBlur, afterReload });

  // ── Gantt: Мобилизация incomplete reason + Демонтаж bus 174900 ──
  await page.goto(`${base}/cabinet/gpr/${TEST.scheduleId}`);
  await page.waitForTimeout(1200);
  const mob = page.getByTestId(`gantt-stage-cost-${TEST.mobilizStageId}`);
  if (await mob.count()) {
    await mob.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
  }
  await shot(page, "gantt-mobiliz-incomplete.png");

  const dem = page.getByTestId(`gantt-stage-cost-${TEST.demontazhStageId}`);
  await dem.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const busText = await page.getByTestId(`gantt-bus-cost-${TEST.demontazhStageId}`).innerText();
  if (!/174\s*900|174 900|174900/.test(busText.replace(/\u00a0/g, " "))) {
    console.warn("BUS_TEXT", busText);
  }
  const demBox = await dem.evaluate((el) => {
    const row = el.closest("[data-testid^=\"gantt-row\"], .grid, .relative") ?? el.parentElement;
    const r = (row ?? el).getBoundingClientRect();
    return {
      x: Math.max(0, r.x - 4),
      y: Math.max(0, r.y - 4),
      width: Math.min(700, r.width + 8),
      height: Math.min(220, r.height + 8),
    };
  });
  await shot(page, "gantt-demontazh-bus-174900.png", demBox);
  await shot(page, "gantt-cost.png");

  // ── Obmen ──
  await page.goto(`${base}/cabinet/zakupki/${TEST.procurementId}`);
  await page.waitForTimeout(800);
  const obmenCard = page.getByTestId("obmen-result-on-card").or(page.getByTestId("obmen-result-empty"));
  if (await obmenCard.count()) await obmenCard.first().scrollIntoViewIfNeeded();
  await shot(page, "obmen-on-card.png");

  await page.goto(`${base}/cabinet/obmen`);
  await page.waitForTimeout(600);
  await shot(page, "obmen-section.png");

  console.log("ALL_SCREENS_OK", { media, artifacts, sha });
} catch (e) {
  console.error("SCREEN_FAIL", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
