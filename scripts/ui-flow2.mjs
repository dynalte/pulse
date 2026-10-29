import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8102/';
const OUT = '/tmp/pulse-flow2';
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function newPage(label, mobile = false) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 880 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'fr-FR',
    permissions: ['clipboard-read', 'clipboard-write', 'microphone'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  return { ctx, page };
}

async function login(page, user, pass) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  if (await page.locator('.conv-row').count()) return;
  await page.fill('input[placeholder="alex ou alex@exemple.fr"]', user);
  await page.fill('input[autocomplete="current-password"]', pass);
  await page.click('button[type="submit"].auth-submit');
  await page.waitForSelector('.conv-row', { timeout: 15000 });
  await page.waitForTimeout(800);
}

const { page: alex } = await newPage('alex');
await login(alex, 'alex', 'motdepasse1');

// Crée une invitation de compte et récupère son code.
await alex.goto(`${BASE}#/contacts`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(500);
await alex.locator('.page-tabs button', { hasText: 'Invitations' }).click();
await alex.waitForTimeout(300);
const before = await alex.locator('.invite-row').count();
await alex.locator('.invite-cta').click();
await alex.waitForTimeout(250);
await alex.locator('.modal input[placeholder="Pour rejoindre notre groupe…"]').fill('Invitation E2E');
await alex.locator('.modal .btn.primary', { hasText: 'Créer et partager' }).click();
await alex.waitForTimeout(1000);
const after = await alex.locator('.invite-row').count();
if (after <= before) errors.push(`invitation non créée (${before} -> ${after})`);
const codeText = await alex.locator('.invite-row .invite-info strong').first().textContent();
const code = (codeText || '').replace(/^Code\s*/i, '').trim().replace(/[^A-Z0-9]/g, '').slice(0, 8);
if (!code) throw new Error('code invitation introuvable');
console.log('✓ invitation créée', code);

// Inscription du nouveau compte via le lien public.
const { ctx: danaCtx, page: dana } = await newPage('dana');
await dana.goto(`${BASE}#/invite/${code}`, { waitUntil: 'networkidle' });
await dana.waitForTimeout(700);
await dana.screenshot({ path: `${OUT}/01-invite-register.png` });
const codeValue = await dana.locator('input[placeholder="XXXXXXXX"]').inputValue();
if (codeValue !== code) errors.push(`code prérempli incorrect: ${codeValue} != ${code}`);
const stamp = Date.now().toString().slice(-6);
await dana.locator('input[autocomplete="name"]').fill('Dana UI');
await dana.locator('input[autocomplete="email"]').fill(`dana${stamp}@example.com`);
await dana.locator('input[autocomplete="username"]').fill(`dana${stamp}`);
const passwords = dana.locator('input[autocomplete="new-password"]');
await passwords.nth(0).fill('motdepasse4');
await passwords.nth(1).fill('motdepasse4');
await dana.locator('.auth-submit').click();
await dana.waitForSelector('.welcome-pane, .empty-state', { timeout: 15000 });
await dana.waitForTimeout(1000);
await dana.screenshot({ path: `${OUT}/02-new-account.png` });
console.log('✓ inscription par invitation');

// Rejoindre un groupe via lien, avec le nouveau compte.
await alex.goto(`${BASE}#/`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(600);
if (!(await alex.locator('.conv-row', { hasText: 'Groupe UI' }).count())) {
  await alex.goto(`${BASE}#/new-group`, { waitUntil: 'networkidle' });
  await alex.waitForTimeout(500);
  await alex.locator('.picker-row', { hasText: 'Bob' }).first().click();
  await alex.locator('.btn.primary', { hasText: 'Suivant' }).click();
  await alex.waitForTimeout(250);
  await alex.locator('.group-form input[placeholder="Les amis, Famille, Projet…"]').fill('Groupe UI');
  await alex.locator('.btn.primary', { hasText: 'Créer' }).click();
  await alex.waitForSelector('.chat-peer-text strong', { timeout: 10000 });
  await alex.waitForTimeout(600);
  await alex.goto(`${BASE}#/`, { waitUntil: 'networkidle' });
  await alex.waitForTimeout(500);
}
const groupRow = alex.locator('.conv-row', { hasText: 'Groupe UI' }).first();
await groupRow.click();
await alex.waitForTimeout(900);
await alex.locator('.chat-head-actions .icon-btn').nth(1).click();
await alex.waitForTimeout(700);
const groupCode = (await alex.locator('.invite-link-card code').textContent() || '').trim();
if (!groupCode) throw new Error('code groupe introuvable');
await alex.keyboard.press('Escape');
await alex.waitForTimeout(300);
await dana.goto(`${BASE}#/invite/${groupCode}`, { waitUntil: 'networkidle' });
await dana.waitForTimeout(800);
await dana.screenshot({ path: `${OUT}/03-group-invite.png` });
await dana.locator('.btn.primary', { hasText: 'Rejoindre le groupe' }).click();
await dana.waitForSelector('.chat-peer-text strong', { timeout: 10000 });
const joinedTitle = await dana.locator('.chat-peer-text strong').first().textContent();
if (!joinedTitle?.includes('Groupe UI')) errors.push(`groupe rejoint: ${joinedTitle}`);
console.log('✓ groupe rejoint par lien');

// Envoi d'image depuis Alex dans le groupe.
const png = path.resolve('public/pwa-192x192.png');
await alex.locator('.composer-wrap input[type="file"]').first().setInputFiles(png);
await alex.waitForTimeout(3500);
await alex.screenshot({ path: `${OUT}/04-image-sent.png` });
console.log('✓ image envoyée');

// Message vocal (micro factice).
await alex.locator('.mic-btn').click();
await alex.waitForTimeout(1800);
await alex.locator('.rec-send').click();
await alex.waitForTimeout(4000);
const voices = await alex.locator('.voice-player').count();
if (!voices) errors.push('aucun lecteur vocal après enregistrement');
await alex.screenshot({ path: `${OUT}/05-voice-sent.png` });
console.log('✓ vocal enregistré/envoyé');

// Thème clair dans le chat
await alex.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(600);
await alex.locator('.segmented button', { hasText: 'Clair' }).click();
await alex.waitForTimeout(400);
await alex.goto(`${BASE}#/`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(700);
await alex.locator('.conv-row', { hasText: 'Bob' }).first().click();
await alex.waitForTimeout(1200);
await alex.screenshot({ path: `${OUT}/06-light-chat.png` });
console.log('✓ chat en thème clair');
await alex.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(500);
await alex.locator('.segmented button', { hasText: 'Sombre' }).click();

// Clôture : supprimer l'invitation créée ?
console.log('\nErrors:', errors.length ? `\n${errors.join('\n')}` : 'none');
await browser.close();
