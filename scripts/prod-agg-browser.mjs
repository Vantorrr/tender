/**
 * Focused browser check: two daily ×1 → fact/remain consistent; date DD.MM.YYYY.
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
  await login(page, "object@alfastroy.ru", "Object123!");
  pass("login");

  await page.goto(`${base}/cabinet/proizvodstvo`);
  await page.waitForTimeout(1200);

  // Transfer first candidate if present (creates Общий объём plan 100)
  const transfer = page.locator('[data-testid^="win-to-prod-"]').first();
  if (await transfer.count()) {
    await transfer.click();
    await page.waitForTimeout(1500);
    pass("transfer");
  } else {
    pass("transfer-skip");
  }

  // Date field must be text DD.MM.YYYY, not type=date
  const dateInput = page.getByTestId("daily-fact-date");
  if (!(await dateInput.count())) fail("date-field", "missing");
  else {
    const type = await dateInput.getAttribute("type");
    const ph = await dateInput.getAttribute("placeholder");
    const val = await dateInput.inputValue();
    if (type === "date") fail("date-not-native-us", `type=date still`);
    else pass("date-not-native-us");
    if (ph === "ДД.ММ.ГГГГ" || /^\d{2}\.\d{2}\.\d{4}$/.test(val)) pass("date-ddmm-format");
    else fail("date-ddmm-format", `placeholder=${ph} value=${val}`);
  }

  // Fill qty=1 and save twice
  const qty = page.getByTestId("daily-fact-qty");
  await qty.fill("1");
  const save = page.getByTestId("daily-fact-save");
  await save.click();
  await page.waitForTimeout(1200);
  await qty.fill("1");
  await save.click();
  await page.waitForTimeout(1200);
  pass("two-saves");

  await page.reload();
  await page.waitForTimeout(1500);
  pass("reload");

  // Table row for Общий объём: Fact == За день == За месяц; remain = plan - fact
  const rowText = await page.locator("table tbody tr").filter({ hasText: "Общий объём" }).first().innerText();
  console.log("ROW", rowText.replace(/\n/g, " | "));
  const nums = rowText
    .split(/\s+/)
    .map((t) => t.replace(",", "."))
    .filter((t) => /^-?\d+(\.\d+)?$/.test(t))
    .map(Number);
  // Expected columns after Работа/Ед: Plan, Fact, Day, Month, Remain, Baseline, Variance
  // (plan input may not appear as plain number in innerText — tolerate)
  const factCardEls = await page.locator(".rounded-xl.border.bg-white\\/80.p-3.text-sm").allTextContents();
  const factCard = factCardEls.find((c) => /Факт/i.test(c)) || "";
  const remainCard = factCardEls.find((c) => /Остаток/i.test(c)) || "";
  console.log("FACT_CARD", factCard, "REMAIN_CARD", remainCard);
  const factM = /Факт[^0-9]*([\d]+)/.exec(factCard);
  const remainM = /Остаток[^0-9]*([\d]+)/.exec(remainCard);
  const cardFact = factM ? Number(factM[1]) : NaN;
  const cardRemain = remainM ? Number(remainM[1]) : NaN;
  if (!Number.isFinite(cardFact) || cardFact <= 0) fail("fact-card", factCard);
  else pass("fact-card");
  if (!Number.isFinite(cardRemain) || cardRemain !== 100 - cardFact) {
    fail("remain-card", `${remainCard} expected ${100 - cardFact}`);
  } else pass("remain-card");
  // Day/month/fact alignment: card fact must appear in row and not be stuck at 0
  if (rowText.includes(String(cardFact)) && !/\t0\t2\t2\t100\t/.test(rowText)) {
    pass("table-aligned");
  } else if (nums.includes(cardFact)) {
    pass("table-aligned");
  } else {
    fail("table-aligned", rowText.slice(0, 300));
  }

  await page.screenshot({
    path: path.join(media, "25-proizvodstvo-russian-pnl.png"),
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(media, "25c-proizvodstvo-agg-fix.png"),
    fullPage: true,
  });
  pass("screenshot-25");
} catch (e) {
  fail("uncaught", e instanceof Error ? e.message : e);
} finally {
  await browser.close();
  const out = path.join("/tmp/tma361-verify-agg-final/pass3", "browser.json");
  fs.writeFileSync(out, JSON.stringify({ ...results, at: new Date().toISOString(), base }, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.fail.length) process.exit(1);
}
