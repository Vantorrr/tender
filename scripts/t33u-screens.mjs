/**
 * t33u Bugbot-tails screenshots: day card, Gantt cost, DateInputRu, Obmen.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");
const sha = (process.env.T33U_SHA ?? "956b192").slice(0, 7);
const store = "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3";
const media = path.join(
  store,
  `media/tma361/client-corrections-2026-11-08/t33u-screens-${sha}`
);
const artifacts = path.join(store, `artifacts/t33u-${sha}`);
const optArtifacts = "/opt/cursor/artifacts";
for (const d of [media, artifacts, optArtifacts]) fs.mkdirSync(d, { recursive: true });

const TEST = {
  calcId: "c-t25u-test",
  scheduleId: "g-t25u-test",
  planFactId: "pf-t25u-test",
  date: "2026-11-08",
  work: "Демонтаж перегородок",
  procurementId: "p-t25u-test",
};

async function shot(page, name) {
  const p = path.join(media, name);
  await page.screenshot({ path: p, fullPage: false });
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

  // 1) Day card — plan % of contract
  await page.goto(
    `${base}/cabinet/proizvodstvo/day?planFactId=${encodeURIComponent(TEST.planFactId)}&date=${TEST.date}&work=${encodeURIComponent(TEST.work)}`
  );
  await page.waitForSelector('[data-testid="day-plan-fact-row"]', { timeout: 20000 });
  await page.waitForTimeout(600);
  await shot(page, "day-plan-fact.png");
  // Date field close-up
  await page.locator('[data-testid="day-date"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="day-date"]').click();
  await page.waitForTimeout(200);
  await shot(page, "date-input-ru.png");

  // 2) Gantt with cost column
  await page.goto(`${base}/cabinet/gpr/${TEST.scheduleId}`);
  await page.waitForTimeout(1200);
  const gantt = page.locator('[data-testid="plan-fact-gantt"], [data-testid="gpr-gantt"], .overflow-x-auto').first();
  if (await page.getByText("Стоимость").count()) {
    await page.getByText("Стоимость").first().scrollIntoViewIfNeeded();
  }
  await shot(page, "gantt-cost.png");

  // 3) Obmen section on procurement card + dedicated obmen page
  await page.goto(`${base}/cabinet/zakupki/${TEST.procurementId}`);
  await page.waitForTimeout(1000);
  const obmenCard = page.getByTestId("obmen-result-on-card").or(page.getByTestId("obmen-result-empty"));
  if (await obmenCard.count()) {
    await obmenCard.first().scrollIntoViewIfNeeded();
  }
  await shot(page, "obmen-on-card.png");

  await page.goto(`${base}/cabinet/obmen`);
  await page.waitForTimeout(800);
  await shot(page, "obmen-section.png");

  console.log("ALL_SCREENS_OK", { media, artifacts, sha });
} catch (e) {
  console.error("SCREEN_FAIL", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
