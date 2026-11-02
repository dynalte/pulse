#!/usr/bin/env node
/**
 * Génère un jeton d'accès Pulse et l'écrit dans mcp/.env.
 *
 * Le mot de passe sert une seule fois (login) et n'est jamais enregistré.
 * Le jeton créé est un jeton d'accès révocable, stocké haché côté serveur.
 *
 * Usage :
 *   npm run mcp:token
 *   node scripts/pulse-token.mjs
 *
 * Variables : PULSE_API_URL, PULSE_LOGIN, PULSE_PASSWORD,
 *             PULSE_TOKEN_NAME (défaut « MCP (CLI) »), PULSE_TOKEN_DAYS (0/30/90/365).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = process.env.PULSE_ENV_FILE
  ? path.resolve(process.env.PULSE_ENV_FILE)
  : path.join(ROOT, 'mcp', '.env');

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

function envValue(name, fallback = '') {
  const value = process.env[name];
  if (!value || /^\{env:[A-Z0-9_]+\}$/.test(String(value).trim())) return fallback;
  return String(value);
}

function normalizeApiUrl(raw) {
  let url = String(raw || '').trim() || 'https://pulse.dynaspirit.com/api-messagerie.php';
  if (!/^https?:\/\//i.test(url)) throw new Error(`URL invalide : ${url}`);
  url = url.replace(/\/+$/, '');
  if (!/\.php(\?|$)/i.test(url)) url += '/api-messagerie.php';
  return url;
}

loadEnvFile(ENV_FILE);
const API_URL = normalizeApiUrl(envValue('PULSE_API_URL'));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Saisie masquée (le mot de passe n'apparaît pas et n'est pas historisé). */
function askHidden(question) {
  if (!process.stdin.isTTY) {
    return ask(question);
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        } else if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
    stdin.once('error', reject);
  });
}

async function callApi(action, body = {}, auth = null) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'pulse-token/1.0' };
  if (auth?.token) headers[auth.header] = auth.token;
  let res;
  let data = null;
  try {
    res = await fetch(
      `${API_URL}${API_URL.includes('?') ? '&' : '?'}action=${encodeURIComponent(action)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      },
    );
    data = await res.json();
  } catch (e) {
    throw new Error(`Impossible de joindre l'API Pulse : ${e?.cause?.code || e.message}`);
  }
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function writeEnvToken(key, token, comment) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }

  const kept = lines.filter(
    (line) => !/^\s*#?\s*PULSE_(API_TOKEN|SESSION_TOKEN|LOGIN|PASSWORD)\s*=/.test(line),
  );
  // Nettoie les lignes vides consécutives laissées par la suppression.
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();

  kept.push('', `# ${comment}`, '# Généré par `npm run mcp:token` — le mot de passe n’est pas conservé.', `${key}=${token}`, '');

  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ENV_FILE, kept.join('\n'), { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
}

async function main() {
  console.log(`API Pulse : ${API_URL}\n`);

  const login = envValue('PULSE_LOGIN') || (await ask('Identifiant ou e-mail : '));
  const password = envValue('PULSE_PASSWORD') || (await askHidden('Mot de passe (masqué) : '));

  if (!login || !password) {
    console.error('Identifiant et mot de passe requis.');
    process.exit(1);
  }

  const session = await callApi('login', { login, password });
  const u = session.user || {};
  console.log(`✓ Connecté : #${u.id} ${u.name} (@${u.username}), rôle ${u.role}`);

  const name = envValue('PULSE_TOKEN_NAME', 'MCP (CLI)');
  const days = Number(envValue('PULSE_TOKEN_DAYS', '90'));
  if (![0, 30, 90, 365].includes(days)) {
    console.error('PULSE_TOKEN_DAYS invalide : utilisez 0, 30, 90 ou 365.');
    process.exit(1);
  }

  try {
    const created = await callApi(
      'token_create',
      { name, days },
      { token: session.token, header: 'X-Session-Token' },
    );
    writeEnvToken('PULSE_API_TOKEN', created.token, `Jeton d’accès « ${name} » (${days ? `${days} jours` : 'sans expiration'}).`);
    const info = created.tokenInfo || {};
    console.log(`✓ Jeton « ${name} » créé (id ${info.id}, ${days ? `${days} jours` : 'sans expiration'})`);
    console.log(`✓ Écrit dans ${ENV_FILE} sous PULSE_API_TOKEN (chmod 600, ignoré par git)`);
    console.log(`  ${created.token.slice(0, 14)}…  (${created.token.length} caractères)`);
  } catch (e) {
    if (e.status === 404 || /Action inconnue/i.test(e.message)) {
      // Ancienne API sans gestion de jetons : repli sur le jeton de session.
      writeEnvToken('PULSE_SESSION_TOKEN', session.token, 'Jeton de session (API sans gestion de jetons).');
      console.log(`! L’API ne gère pas encore les jetons d’accès : jeton de session écrit dans ${ENV_FILE}.`);
      console.log('  Déployez la nouvelle API puis relancez `npm run mcp:token`.');
    } else {
      throw e;
    }
  }

  console.log('\nRelance OpenCode (`/reload`) ou `npm run mcp:check` pour vérifier.');
}

main().catch((e) => {
  console.error(`Échec : ${e.message}`);
  process.exit(1);
});
