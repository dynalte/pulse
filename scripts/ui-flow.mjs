import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8102/';
const OUT = '/tmp/pulse-flow';
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });

async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 }, locale: 'fr-FR', permissions: ['clipboard-read', 'clipboard-write'] });
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

function shot(page, name) {
  return page.screenshot({ path: `${OUT}/${name}.png` });
}

const { page: alex } = await newPage('alex');
await login(alex, 'alex', 'motdepasse1');
const { page: bob } = await newPage('bob');
await login(bob, 'bob', 'nouveaupass2');

// Ouvrir la conversation directe des deux côtés.
await alex.locator('.conv-row', { hasText: 'Bob' }).first().click();
await alex.waitForTimeout(800);
await bob.locator('.conv-row', { hasText: 'Alex' }).first().click();
await bob.waitForTimeout(800);
console.log('✓ conversations ouvertes');

// Envoi temps réel Alex -> Bob
const text1 = `Test réel ${Date.now()}`;
await alex.locator('.composer textarea').fill(text1);
await alex.locator('.send-btn').click();
await alex.waitForTimeout(400);
await bob.waitForSelector(`.bubble-text:has-text("${text1}")`, { timeout: 10000 });
console.log('✓ message reçu en temps réel');
await shot(alex, '01-alex-chat');

// Réponse Bob -> Alex
const text2 = `Réponse ${Date.now()}`;
await bob.locator('.composer textarea').fill(text2);
await bob.locator('.send-btn').click();
await alex.waitForSelector(`.bubble-text:has-text("${text2}")`, { timeout: 10000 });
console.log('✓ réponse reçue');

// Réaction Bob sur le message d'Alex
const alexBubble = bob.locator('.msg-row', { hasText: text1 }).last();
await alexBubble.locator('.bubble-more').click({ force: true });
await bob.waitForTimeout(400);
await bob.locator('.quick-reactions button').first().click();
await bob.waitForTimeout(300);
await alex.waitForSelector(`.reaction`, { timeout: 10000 });
console.log('✓ réaction synchronisée');
await shot(alex, '02-reaction');

// Édition côté Alex
const editText = `Édité ${Date.now()}`;
const alexRow = alex.locator('.msg-row', { hasText: text1 }).last();
await alexRow.locator('.bubble-more').click({ force: true });
await alex.waitForTimeout(300);
await alex.locator('.sheet-action', { hasText: 'Modifier' }).click();
await alex.locator('.composer textarea').fill(editText);
await alex.locator('.send-btn').click();
await bob.waitForSelector(`.bubble-text:has-text("${editText}")`, { timeout: 10000 });
console.log('✓ édition synchronisée');

// Suppression pour tout le monde côté Alex
const editedRow = alex.locator('.msg-row', { hasText: editText }).last();
await editedRow.locator('.bubble-more').click({ force: true });
await alex.waitForTimeout(300);
await alex.locator('.sheet-action', { hasText: 'Supprimer pour tout le monde' }).click();
await alex.locator('.modal .btn.danger', { hasText: 'Supprimer' }).click();
await bob.waitForSelector('.deleted-text', { timeout: 10000 });
console.log('✓ suppression pour tout le monde');

// Recherche interne
await alex.locator('.chat-head-actions .icon-btn').first().click();
await alex.locator('.chat-search input').fill('Réponse');
await alex.waitForTimeout(700);
const results = await alex.locator('.chat-search .search-result').count();
if (results === 0) errors.push('recherche interne : aucun résultat');
await shot(alex, '03-search');
await alex.locator('.chat-search-head .icon-btn').click();
console.log('✓ recherche interne', results, 'résultat(s)');

// Recherche globale
await alex.goto(`${BASE}#/`, { waitUntil: 'networkidle' });
await alex.locator('.list-search input').fill('Bob');
await alex.waitForTimeout(1100);
await alex.waitForSelector('.search-panel', { timeout: 5000 });
await shot(alex, '04-global-search');
await alex.locator('.list-search .clear-btn').click();
console.log('✓ recherche globale');

// Profil contact
await alex.goto(`${BASE}#/contacts`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(700);
await alex.locator('.person-main', { hasText: 'Bob' }).first().click();
await alex.waitForTimeout(700);
await shot(alex, '05-profile');
await alex.locator('.profile-modal .modal-head .icon-btn').click();
console.log('✓ fiche utilisateur');

// Invitations : création
await alex.locator('.page-tabs button', { hasText: 'Invitations' }).click();
await alex.waitForTimeout(300);
await alex.locator('.invite-cta').click();
await alex.waitForTimeout(300);
await alex.locator('.modal input[placeholder="Pour rejoindre notre groupe…"]').fill('Test UI');
await alex.locator('.modal .btn.primary', { hasText: 'Créer et partager' }).click();
await alex.waitForTimeout(900);
await shot(alex, '06-invites');
const inviteRows = await alex.locator('.invite-row').count();
console.log('✓ invitations :', inviteRows, 'ligne(s)');

// Création de groupe
await alex.goto(`${BASE}#/new-group`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(500);
await alex.locator('.picker-row', { hasText: 'Bob' }).first().click();
await alex.locator('.btn.primary', { hasText: 'Suivant' }).click();
await alex.waitForTimeout(300);
await alex.locator('.group-form input[placeholder="Les amis, Famille, Projet…"]').fill('Groupe UI');
await alex.locator('.btn.primary', { hasText: 'Créer' }).click();
await alex.waitForTimeout(1500);
const groupTitle = await alex.locator('.chat-peer-text strong').first().textContent();
if (!groupTitle?.includes('Groupe UI')) errors.push(`création groupe: titre=${groupTitle}`);
await alex.locator('.composer textarea').fill('Bienvenue dans le groupe UI');
await alex.locator('.send-btn').click();
await alex.waitForTimeout(500);
await shot(alex, '07-group-created');
console.log('✓ groupe créé et message envoyé');

// Infos groupe
await alex.locator('.chat-head-actions .icon-btn').nth(1).click();
await alex.waitForTimeout(800);
await alex.locator('.group-info .text-btn', { hasText: 'Ajouter' }).click();
await alex.waitForTimeout(600);
await shot(alex, '08-add-members');
await alex.locator('.modal-head .icon-btn, .modal .sheet-cancel').last().click().catch(() => {});
// Fermer les modals restantes
await alex.keyboard.press('Escape');
await alex.keyboard.press('Escape');

// Thème clair
await alex.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(700);
await alex.locator('.segmented button', { hasText: 'Clair' }).click();
await alex.waitForTimeout(600);
const theme = await alex.evaluate(() => document.documentElement.dataset.theme);
if (theme !== 'light') errors.push(`thème clair: ${theme}`);
await alex.evaluate(() => window.scrollTo(0, 0));
await shot(alex, '09-light-settings');
await alex.goto(`${BASE}#/`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(800);
await shot(alex, '10-light-list');
await alex.locator('.segmented button', { hasText: 'Sombre' }).count().catch(() => 0);
await alex.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
await alex.waitForTimeout(500);
await alex.locator('.segmented button', { hasText: 'Sombre' }).click();
console.log('✓ thème clair testé');

// Mobile avec le compte de bob
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
const m = await mctx.newPage();
m.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));
m.on('console', (msg) => { if (msg.type() === 'error') errors.push(`mobile console: ${msg.text()}`); });
await login(m, 'bob', 'nouveaupass2');
await m.screenshot({ path: `${OUT}/11-mobile-list.png` });
await m.goto(`${BASE}#/contacts`, { waitUntil: 'networkidle' });
await m.waitForTimeout(700);
await m.screenshot({ path: `${OUT}/12-mobile-contacts.png` });
console.log('✓ mobile');

console.log('\nErrors:', errors.length ? `\n${errors.join('\n')}` : 'none');
await browser.close();
