import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8102/';
const OUT = '/tmp/pulse-shots';
fs.mkdirSync(OUT, { recursive: true });
const errors = [];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('shot', name);
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await shot('01-auth');

await page.fill('input[placeholder="alex ou alex@exemple.fr"]', 'alex');
await page.fill('input[autocomplete="current-password"]', 'motdepasse1');
await page.click('button[type="submit"].auth-submit');
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.waitForTimeout(1200);
await shot('02-welcome');

const bob = page.locator('.conv-row', { hasText: 'Bob' }).first();
if (await bob.count()) {
  await bob.click();
  await page.waitForTimeout(1800);
  await shot('03-chat-bob');
  // menu des actions message
  const more = page.locator('.bubble-more').last();
  if (await more.count()) { await more.click({ force: true }); await page.waitForTimeout(400); await shot('04-message-actions'); await page.keyboard.press('Escape'); }
  // composer emoji
  await page.locator('.composer .emoji-anchor .icon-btn').click();
  await page.waitForTimeout(300);
  await shot('05-emoji');
  await page.keyboard.press('Escape');
}

const group = page.locator('.conv-row', { hasText: 'Les amis' }).first();
if (await group.count()) {
  await group.click();
  await page.waitForTimeout(1500);
  await shot('06-chat-group');
  await page.locator('.chat-head-actions .icon-btn').nth(1).click();
  await page.waitForTimeout(800);
  await shot('07-group-info');
  await page.keyboard.press('Escape');
}

await page.goto(`${BASE}#/contacts`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await shot('08-contacts');
await page.goto(`${BASE}#/new-group`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await shot('09-new-group');
await page.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await shot('10-settings');

// Mobile
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
const m = await mctx.newPage();
m.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));
m.on('console', (msg) => { if (msg.type() === 'error') errors.push(`mobile console: ${msg.text()}`); });
await m.goto(BASE, { waitUntil: 'networkidle' });
await m.waitForTimeout(700);
await m.screenshot({ path: `${OUT}/11-mobile-auth.png` });
await m.fill('input[placeholder="alex ou alex@exemple.fr"]', 'alex');
await m.fill('input[autocomplete="current-password"]', 'motdepasse1');
await m.click('button[type="submit"].auth-submit');
await m.waitForSelector('.conv-row', { timeout: 15000 });
await m.waitForTimeout(1200);
await m.screenshot({ path: `${OUT}/12-mobile-list.png` });
const mbob = m.locator('.conv-row', { hasText: 'Bob' }).first();
if (await mbob.count()) {
  await mbob.click();
  await m.waitForTimeout(1600);
  await m.screenshot({ path: `${OUT}/13-mobile-chat.png` });
}
await m.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
await m.waitForTimeout(800);
await m.screenshot({ path: `${OUT}/14-mobile-settings.png` });

console.log('\nErrors:', errors.length ? `\n${errors.join('\n')}` : 'none');
await browser.close();
