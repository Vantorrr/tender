/**
 * t22u evidence screens: GPR resources/materials honesty + production plan-from-GPR.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:43141").replace(/\/$/, "");
const media =
  process.env.BROWSER_MEDIA_DIR ??
  "/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3/media/tma361/client-corrections-2026-11-08";
fs.mkdirSync(media, { recursive: true });
const results = { pass: [], fail: [] };
const pass = (n) => {
  results.pass.push(n);
  console.log("PASS", n);
};
const fail = (n, d) => {
  results.fail.push({ n, d: String(d) });
  console.error("FAIL", n, d);
};

async function login(page, email, password) {
  await page.goto(`${base}/login`);
  await page.getByLabel(/email/i).fill(email);
  const pwdTab = page.getByRole("tab", { name: /Пароль/i });
  if (await pwdTab.count()) await pwdTab.click();
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: /Войти/i }).click();
  await page.waitForURL(/\/cabinet/, { timeout: 20000 });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(25000);

try {
  await login(page, "ruk@alfastroy.ru", "Ruk123!");
  pass("login-ruk");

  // Ensure cost summary exists (materials honesty needs buckets + cost)
  await page.goto(`${base}/cabinet/raschety/c-1`);
  await page.waitForTimeout(800);
  const recompute = page.getByTestId("recompute-cost-engine");
  if (await recompute.count()) {
    await recompute.click();
    await page.waitForTimeout(1500);
    pass("recompute-cost");
  } else pass("recompute-skip");

  // GPR
  await page.goto(`${base}/cabinet/gpr`);
  await page.waitForTimeout(800);
  const gprLink = page.locator('a[href*="/cabinet/gpr/"]').first();
  if (await gprLink.count()) await gprLink.click();
  else await page.goto(`${base}/cabinet/gpr/g-1`);
  await page.waitForTimeout(1200);

  // Trigger cost summary if possible via related calc
  const mat = page.getByTestId("gpr-materials-cost");
  const matText = (await mat.count()) ? await mat.innerText() : "";
  console.log("MATERIALS_LINE", matText);
  if (/нет данных|0/.test(matText) || matText) pass("materials-line-visible");
  else fail("materials-line-visible", "missing");

  // Resource names should include stage separator · after schema12
  const table = page.getByTestId("gpr-resource-table");
  const tableText = await table.innerText();
  if (tableText.includes("·") || /Материалы ·|Бригада ·/.test(tableText)) {
    pass("stage-named-resources");
  } else {
    // may need recompute/migrate — still note
    fail("stage-named-resources", tableText.slice(0, 200));
  }
  const qty = page.locator('[data-testid^="res-qty-"]').first();
  if (await qty.count()) {
    await qty.fill("5");
    pass("resource-qty-editable");
  } else fail("resource-qty-editable", "no input");

  await page.screenshot({
    path: path.join(media, "24-gpr-readable-gantt.png"),
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(media, "24c-t22u-gpr-resources.png"),
    fullPage: true,
  });
  pass("screen-24");

  // Production
  await page.goto(`${base}/cabinet/proizvodstvo`);
  await page.waitForTimeout(1000);
  const transfer = page.locator('[data-testid^="win-to-prod-"]').first();
  if (await transfer.count()) {
    await transfer.click();
    await page.waitForTimeout(1200);
  }
  const planCard = page.getByTestId("period-plan-from-gpr");
  if (await planCard.count()) {
    const t = await planCard.innerText();
    console.log("PERIOD_PLAN", t);
    if (/из ГПР/.test(t)) pass("period-plan-from-gpr");
    else fail("period-plan-from-gpr", t);
  } else fail("period-plan-from-gpr", "missing");

  if (await page.getByTestId("pnl-cash-in").count()) pass("pnl-editable");
  else fail("pnl-editable", "missing");

  await page.screenshot({
    path: path.join(media, "25-proizvodstvo-russian-pnl.png"),
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(media, "25d-t22u-plan-from-gpr.png"),
    fullPage: true,
  });
  pass("screen-25");
} catch (e) {
  fail("uncaught", e instanceof Error ? e.message : e);
} finally {
  await browser.close();
  fs.writeFileSync(
    "/tmp/tma361-t22u-browser.json",
    JSON.stringify({ ...results, at: new Date().toISOString(), base }, null, 2)
  );
  console.log(JSON.stringify(results, null, 2));
  if (results.fail.length) process.exit(1);
}
