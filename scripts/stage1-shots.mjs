import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const out = '/cursor/stores/bc-9835700e-8111-4465-b19d-1854d624abd3/media/tma361/client-corrections-2026-11-08';
fs.mkdirSync(out, { recursive: true });
const base = 'http://127.0.0.1:43141';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function shot(name) {
  const p = path.join(out, name);
  await page.screenshot({ path: p, fullPage: false });
  console.log('saved', p);
}

await page.goto(base + '/login', { waitUntil: 'networkidle' });
await shot('01-login.png');

await page.fill('input[type="email"], input[name="email"], #email', 'super@tenderkontur.ru');
await page.fill('input[type="password"], #password', 'Super123!');
await page.click('button[type="submit"]');
await page.waitForURL(/cabinet/, { timeout: 20000 });
await page.waitForTimeout(800);
await shot('02-cabinet-sidebar.png');

await page.goto(base + '/cabinet/zakupki', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await shot('03-zakupki-kanban.png');

// filter norilsk if select exists
try {
  await page.getByTestId('zakupki-region').click({ timeout: 3000 });
  await page.getByRole('option', { name: 'Норильск' }).click();
  await page.waitForTimeout(400);
  await shot('04-zakupki-filter-norilsk.png');
} catch (e) {
  console.log('region filter skip', e.message);
}

await page.goto(base + '/cabinet/zakupki/p-1', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await shot('05-zakupka-matryoshka.png');

await page.getByRole('tab', { name: /Документы/ }).click();
await page.waitForTimeout(400);
await shot('06-zakupka-docs-tab.png');

await page.getByRole('tab', { name: /Аналитика/ }).click();
await page.waitForTimeout(400);
try {
  await page.getByRole('button', { name: /Обновить сводку/ }).click();
  await page.waitForTimeout(800);
} catch {}
await shot('07-zakupka-analytics.png');

await page.goto(base + '/cabinet/raschety', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot('08-raschety-list.png');

await page.goto(base + '/cabinet/raschety/c-1', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await shot('09-raschet-draft.png');

await page.goto(base + '/cabinet/spravochniki', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot('10-spravochniki-obmen-link.png');

await page.goto(base + '/register', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await shot('11-self-register.png');

await browser.close();
console.log('done');
