#!/usr/bin/env node
/**
 * Serveur MCP pour Pulse — pilote l'API PHP existante (aucune modification serveur).
 *
 * Transport : stdio (OpenCode lance ce processus).
 * Auth      : login/mot de passe Pulse, jeton de session mis en cache.
 *
 * Variables d'environnement (ou fichier mcp/.env, voir mcp/.env.example) :
 *   PULSE_API_URL        URL de l'API (défaut : prod pulse.dynaspirit.com)
 *   PULSE_LOGIN          identifiant ou e-mail du compte
 *   PULSE_PASSWORD       mot de passe
 *   PULSE_API_TOKEN      jeton d'accès personnel (recommandé, généré dans Pulse)
 *   PULSE_SESSION_TOKEN  ancien jeton de session du navigateur (optionnel)
 *   PULSE_READ_ONLY=1    n'expose que les outils de lecture
 *   PULSE_DRY_RUN=1      n'écrit rien : renvoie l'appel qui aurait été fait
 *   PULSE_SESSION_FILE   chemin du cache de session (défaut ~/.cache/pulse-mcp)
 *   PULSE_TIMEOUT_MS     délai réseau (défaut 20000)
 *
 * Diagnostic : node mcp/pulse-mcp.mjs --check
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ env */

/** Charge un fichier .env minimaliste sans écraser l'environnement existant. */
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

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
// Le fichier du projet est prioritaire : on le charge en premier.
loadEnvFile(path.join(HERE, '.env'));
loadEnvFile(path.join(XDG_CONFIG, 'pulse-mcp', '.env'));

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

/** Une variable non substituée par OpenCode (`{env:NOM}`) est traitée comme absente. */
function envValue(name, fallback = '') {
  const value = process.env[name];
  if (!value || /^\{env:[A-Z0-9_]+\}$/.test(String(value).trim())) return fallback;
  return String(value);
}

function normalizeApiUrl(raw) {
  let url = String(raw || '').trim() || 'https://pulse.dynaspirit.com/api-messagerie.php';
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`PULSE_API_URL invalide (http/https attendu) : ${url}`);
  }
  url = url.replace(/\/+$/, '');
  if (!/\.php(\?|$)/i.test(url)) url += '/api-messagerie.php';
  return url;
}

const API_URL = normalizeApiUrl(envValue('PULSE_API_URL'));
const LOGIN = envValue('PULSE_LOGIN').trim();
const PASSWORD = envValue('PULSE_PASSWORD');
const API_TOKEN = envValue('PULSE_API_TOKEN').trim();
const LEGACY_SESSION_TOKEN = envValue('PULSE_SESSION_TOKEN').trim();
const READ_ONLY = truthy(process.env.PULSE_READ_ONLY);
const DRY_RUN = truthy(process.env.PULSE_DRY_RUN);
const TIMEOUT_MS = Math.max(1000, Number(envValue('PULSE_TIMEOUT_MS')) || 20000);
const CACHE_DIR = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
const SESSION_FILE =
  envValue('PULSE_SESSION_FILE') || path.join(CACHE_DIR, 'pulse-mcp', 'session.json');

/* -------------------------------------------------------------- session */

class PulseError extends Error {
  constructor(message, status = 0, action = '') {
    super(message);
    this.name = 'PulseError';
    this.status = status;
    this.action = action;
  }
}

function endpoint(action) {
  return `${API_URL}${API_URL.includes('?') ? '&' : '?'}action=${encodeURIComponent(action)}`;
}

async function rawRequest(action, body = {}, auth = null) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `pulse-mcp/${VERSION}`,
  };
  if (auth?.token) headers[auth.header || 'X-Session-Token'] = auth.token;

  let res;
  try {
    res = await fetch(endpoint(action), {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const detail = e?.cause?.code || e?.cause?.message || e?.message || String(e);
    throw new PulseError(
      `Impossible de joindre l'API Pulse (${API_URL}) : ${detail}`,
      0,
      action,
    );
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new PulseError(
      `Réponse illisible de l'API (${action}, HTTP ${res.status}).`,
      res.status,
      action,
    );
  }
  if (!res.ok || !data || data.ok !== true) {
    throw new PulseError(
      data?.error || `Erreur HTTP ${res.status} (${action}).`,
      res.status,
      action,
    );
  }
  return data;
}

function sessionKey() {
  return crypto
    .createHash('sha256')
    .update(`${API_URL}\n${LOGIN}`)
    .digest('hex')
    .slice(0, 16);
}

function readSessionFile() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function loadCachedToken() {
  const entry = readSessionFile()[sessionKey()];
  return entry && typeof entry.token === 'string' ? entry.token : '';
}

function saveCachedToken(token) {
  try {
    const all = readSessionFile();
    all[sessionKey()] = { token, api: API_URL, login: LOGIN, savedAt: Date.now() };
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch (e) {
    console.error(`[pulse-mcp] cache de session non écrit : ${e.message}`);
  }
}

function clearCachedToken() {
  try {
    const all = readSessionFile();
    delete all[sessionKey()];
    fs.writeFileSync(SESSION_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {
    /* sans importance */
  }
}

let sessionToken = LEGACY_SESSION_TOKEN || loadCachedToken();
let loginInFlight = null;

/** Récupère les identifiants à envoyer : jeton d'accès prioritaire, sinon session. */
function currentAuth() {
  if (API_TOKEN) return { token: API_TOKEN, header: 'X-Api-Token', type: 'api' };
  if (sessionToken) return { token: sessionToken, header: 'X-Session-Token', type: 'session' };
  return null;
}

async function ensureSession(force = false) {
  if (!force && sessionToken) return sessionToken;
  if (!LOGIN || !PASSWORD) {
    throw new PulseError(
      'Aucun jeton d’accès Pulse. Générez-en un dans Réglages → Jetons d’accès, ' +
        'puis renseigne PULSE_API_TOKEN dans mcp/.env (ou lance `npm run mcp:token`).',
      401,
      'login',
    );
  }
  if (!loginInFlight) {
    loginInFlight = (async () => {
      const data = await rawRequest('login', { login: LOGIN, password: PASSWORD });
      sessionToken = String(data.token || '');
      if (!sessionToken) throw new PulseError('Réponse de connexion sans jeton.', 500, 'login');
      saveCachedToken(sessionToken);
      return sessionToken;
    })().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

async function api(action, body = {}) {
  let auth = currentAuth();
  if (!auth) {
    const fresh = await ensureSession();
    auth = { token: fresh, header: 'X-Session-Token', type: 'session' };
  }
  try {
    return await rawRequest(action, body, auth);
  } catch (e) {
    if (e instanceof PulseError && e.status === 401) {
      if (auth.type === 'api') {
        e.message += ' (jeton révoqué ou expiré ?)';
        throw e;
      }
      if (LOGIN && PASSWORD) {
        clearCachedToken();
        sessionToken = '';
        const fresh = await ensureSession(true);
        return rawRequest(action, body, { token: fresh, header: 'X-Session-Token', type: 'session' });
      }
      e.message += ' (session expirée ?)';
    }
    throw e;
  }
}

/* ------------------------------------------------------------- formatting */

function fmtDate(seconds) {
  if (!seconds) return '—';
  const d = new Date(Number(seconds) * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

function compactUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    email: u.email,
    bio: u.bio || '',
    online: !!u.online,
    lastSeen: u.lastSeen,
    isContact: u.isContact,
    contactStatus: u.contactStatus,
    blocked: u.blocked,
  };
}

function userLine(u) {
  const bits = [`#${u.id}`, u.name || '(sans nom)', `@${u.username}`];
  if (u.role === 'admin') bits.push('[admin]');
  if (u.online) bits.push('[en ligne]');
  if (u.contactStatus === 'accepted' || u.isContact) bits.push('[contact]');
  if (u.contactStatus === 'pending_in') bits.push('[demande reçue]');
  if (u.contactStatus === 'pending_out') bits.push('[demande envoyée]');
  if (u.blocked) bits.push('[bloqué]');
  return bits.join(' ');
}

function messageText(m) {
  if (m.deletedAt) return '(message supprimé)';
  switch (m.type) {
    case 'image':
      return `[photo${m.body ? ` — ${m.body}` : ''}]`;
    case 'voice':
      return `[vocal ${fmtDuration(m.media?.duration)}]`;
    case 'file':
      return `[fichier ${m.media?.filename || m.body || ''}]`;
    case 'poll':
      return `[sondage « ${m.poll?.question || m.body} »]`;
    case 'location':
      return m.location?.liveUntil
        ? `[position en direct ${m.location.lat},${m.location.lng}]`
        : `[position ${m.location?.lat ?? ''},${m.location?.lng ?? ''}]`;
    default:
      return m.body || '';
  }
}

function messageLine(m) {
  const who = m.mine ? 'moi' : m.senderName || `utilisateur ${m.senderId}`;
  let line = `#${m.id} [${fmtDate(m.createdAt)}] ${who} : ${messageText(m)}`;
  if (m.replyTo) line += `  ↳ réponse à #${m.replyTo.id} (${m.replyTo.senderName})`;
  if (m.reactions?.length) {
    line += `  ${m.reactions.map((r) => `${r.emoji}${r.name ? ` ${r.name}` : ''}`).join(' · ')}`;
  }
  if (m.editedAt) line += '  (modifié)';
  if (m.starred) line += '  ★';
  if (m.type === 'poll' && m.poll) {
    const opts = m.poll.options
      .map((o, i) => `${i + 1}. ${o.text}${o.votes ? ` (${o.votes})` : ''}${o.mine ? ' ✓' : ''}`)
      .join(' · ');
    line += `\n    ${opts}`;
  }
  return line;
}

function compactConversation(c) {
  return {
    id: c.id,
    type: c.type,
    title: c.title,
    description: c.description || '',
    unread: c.unread,
    memberCount: c.memberCount,
    myRole: c.myRole,
    mutedUntil: c.mutedUntil || 0,
    pinned: c.pinned ? 1 : 0,
    archived: c.archived ? 1 : 0,
    peer: c.peer ? { id: c.peer.id, name: c.peer.name, username: c.peer.username } : null,
    updatedAt: c.updatedAt,
    lastMessage: c.lastMessage
      ? {
          id: c.lastMessage.id,
          from: c.lastMessage.senderName,
          type: c.lastMessage.type,
          text: c.lastMessage.body,
          createdAt: c.lastMessage.createdAt,
          deleted: !!c.lastMessage.deleted,
        }
      : null,
  };
}

function conversationLine(c) {
  const kind = c.type === 'group' ? `groupe ${c.memberCount} membres` : 'direct';
  const flags = [];
  if (c.unread) flags.push(`${c.unread} non lu${c.unread > 1 ? 's' : ''}`);
  if (c.archived) flags.push('archivée');
  if (c.pinned) flags.push('épinglée');
  if (c.mutedUntil && c.mutedUntil * 1000 > Date.now()) flags.push('en sourdine');
  const last = c.lastMessage
    ? `dernier #${c.lastMessage.id} ${c.lastMessage.senderName}: ${
        c.lastMessage.deleted ? '(supprimé)' : String(c.lastMessage.body || `[${c.lastMessage.type}]`).slice(0, 80)
      } (${fmtDate(c.lastMessage.createdAt)})`
    : 'aucun message';
  return `#${c.id} [${kind}] ${c.title || '(sans titre)'}${
    flags.length ? ` — ${flags.join(', ')}` : ''
  }\n    ${last}`;
}

/* ---------------------------------------------------------------- results */

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(data, intro = '') {
  return textResult(`${intro ? `${intro}\n\n` : ''}${JSON.stringify(data, null, 2)}`);
}

function errorResult(e) {
  const status = e instanceof PulseError && e.status ? ` (HTTP ${e.status})` : '';
  const action = e instanceof PulseError && e.action ? ` [${e.action}]` : '';
  return {
    isError: true,
    content: [{ type: 'text', text: `Erreur${status}${action} : ${e.message}` }],
  };
}

/** Enveloppe un outil : gestion d'erreurs homogène + dry-run pour les écritures. */
function tool(handler) {
  return async (args, extra) => {
    try {
      return await handler(args || {}, extra);
    } catch (e) {
      console.error(`[pulse-mcp] ${e instanceof PulseError ? e.message : e?.stack || e}`);
      return errorResult(e);
    }
  };
}

function dryRun(label, action, payload) {
  return jsonResult(
    { dryRun: true, action, payload },
    `PULSE_DRY_RUN=1 — aucun appel effectué. ${label}`,
  );
}

/* ------------------------------------------------------------------ tools */

const server = new McpServer(
  { name: 'pulse', version: VERSION },
  {
    instructions:
      'Pulse est une messagerie privée (conversations directes et groupes). ' +
      'Commence toujours par pulse_list_conversations pour obtenir les identifiants numériques, ' +
      'puis pulse_read_messages avec conversationId. Les identifiants (#12) sont ceux des messages. ' +
      "N'envoie, ne modifie ou ne supprime un message que si l'utilisateur le demande explicitement ; " +
      "en cas de doute, montre d'abord le message prévu et demande confirmation. " +
      'Toutes les heures sont en UTC.',
  },
);

/* --- lecture : santé / identité ---------------------------------------- */

server.registerTool(
  'pulse_health',
  {
    title: 'Vérifier la connexion à Pulse',
    description:
      "Teste la joignabilité de l'API Pulse (action ping) et indique l'URL utilisée. " +
      "Ne nécessite pas d'authentification. À utiliser en premier en cas d'erreur réseau.",
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const data = await rawRequest('ping');
    return textResult(
      `API Pulse joignable : ${API_URL}\n${JSON.stringify(data, null, 2)}\n` +
        `Authentification : ${LOGIN ? `compte « ${LOGIN} »` : 'non configurée (PULSE_LOGIN absent)'}`,
    );
  }),
);

server.registerTool(
  'pulse_whoami',
  {
    title: 'Compte Pulse courant',
    description:
      "Retourne le compte utilisé par le serveur MCP (nom, identifiant, rôle, non-lus, demandes de contact). " +
      "Utile pour vérifier que l'IA agit bien avec le bon compte.",
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const { user } = await api('me');
    return jsonResult(compactUser(user), `Connecté en tant que ${userLine(user)}.`);
  }),
);

/* --- lecture : conversations -------------------------------------------- */

server.registerTool(
  'pulse_list_conversations',
  {
    title: 'Lister les conversations',
    description:
      'Liste les conversations (directes et groupes) triées par épinglage puis activité récente : ' +
      'identifiant #id, type, titre, membres, non-lus et dernier message. ' +
      "Point de départ pour obtenir les conversationId utilisés par les autres outils.",
    inputSchema: {
      includeArchived: z
        .boolean()
        .optional()
        .default(true)
        .describe('Inclure les conversations archivées (true par défaut).'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ includeArchived = true }) => {
    const { conversations, unreadTotal } = await api('conversations_list', { includeArchived });
    if (!conversations?.length) {
      return textResult('Aucune conversation. Le compte ne participe à aucune discussion.');
    }
    const lines = conversations.map(conversationLine).join('\n');
    return textResult(
      `${conversations.length} conversation(s) — ${unreadTotal} message(s) non lu(s) au total.\n\n${lines}`,
    );
  }),
);

server.registerTool(
  'pulse_get_conversation',
  {
    title: 'Détail d’une conversation',
    description:
      "Détail d'une conversation : métadonnées, membres (id, nom, rôle, présence, dernier message lu) " +
      'et message épinglé. Utile pour connaître les userId avant de créer un groupe ou cibler une personne.',
    inputSchema: {
      conversationId: z.number().int().positive().describe('Identifiant de la conversation (#id).'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ conversationId }) => {
    const { conversation, members } = await api('conversation_get', { id: conversationId });
    const c = compactConversation(conversation);
    const memberLines = (members || [])
      .map(
        (m) =>
          `#${m.id} ${m.name} (@${m.username}) — ${m.memberRole}${
            m.online ? ' · en ligne' : ` · vu ${fmtDate(m.lastSeen)}`
          } · dernier lu #${m.lastReadMessageId}`,
      )
      .join('\n');
    return jsonResult(
      { conversation: c, members: members.map(compactUser) },
      `#${c.id} « ${c.title} » (${c.type}, ${c.memberCount} membres) — créée le ${fmtDate(
        conversation.createdAt,
      )}\n${conversation.description ? `${conversation.description}\n` : ''}\nMembres :\n${memberLines}`,
    );
  }),
);

server.registerTool(
  'pulse_read_messages',
  {
    title: 'Lire les messages',
    description:
      "Lit l'historique d'une conversation sous forme de transcript horodaté (UTC). " +
      'Chaque ligne commence par #id (utilisable pour répondre, réagir, éditer ou supprimer). ' +
      "`before` permet de remonter dans le temps ; `query` filtre dans la conversation.",
    inputSchema: {
      conversationId: z.number().int().positive().describe('Identifiant de la conversation.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(30)
        .describe('Nombre de messages (1 à 100, 30 par défaut).'),
      before: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Ne renvoyer que les messages dont l’id est strictement inférieur (pagination).'),
      after: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Ne renvoyer que les messages dont l’id est strictement supérieur (nouveaux messages).'),
      query: z.string().optional().describe('Filtre texte (corps du message ou nom de l’expéditeur).'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ conversationId, limit = 30, before, after, query }) => {
    const [list, detail] = await Promise.all([
      api('messages_list', { conversationId, limit, before, after, q: query }),
      api('conversation_get', { id: conversationId }),
    ]);
    const c = detail.conversation;
    const messages = list.messages || [];
    const header =
      `#${c.id} « ${c.title} » (${c.type}, ${c.memberCount} membres) — ` +
      `${messages.length} message(s)${query ? ` correspondant à « ${query} »` : ''}`;
    if (!messages.length) {
      return textResult(`${header}\n\nAucun message.${query ? ' Essaie une autre recherche.' : ''}`);
    }
    const minId = messages[0].id;
    const maxId = messages[messages.length - 1].id;
    const footer = list.hasMore
      ? `\n\nIl reste des messages plus anciens. Pagination : before=${minId}.`
      : '\n\nDébut de la conversation atteint.';
    return textResult(
      `${header}\nIDs ${minId}→${maxId}\n\n${messages.map(messageLine).join('\n')}${footer}`,
    );
  }),
);

server.registerTool(
  'pulse_search',
  {
    title: 'Rechercher dans Pulse',
    description:
      'Recherche de messages. Sans conversationId : recherche globale (conversations, personnes, messages). ' +
      'Avec conversationId : recherche limitée à cette conversation. Retourne les #id des messages trouvés.',
    inputSchema: {
      query: z.string().min(1).max(100).describe('Texte recherché.'),
      conversationId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Limiter la recherche à cette conversation.'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ query, conversationId }) => {
    if (conversationId) {
      const { messages } = await api('search_messages', { q: query, conversationId });
      if (!messages?.length) return textResult(`Aucun message ne contient « ${query} » dans #${conversationId}.`);
      return textResult(
        `${messages.length} message(s) trouvé(s) dans #${conversationId} pour « ${query} » :\n\n` +
          messages.map(messageLine).join('\n'),
      );
    }
    const data = await api('search', { q: query });
    const sections = [];
    if (data.conversations?.length) {
      sections.push(
        `Conversations (${data.conversations.length}) :\n` +
          data.conversations.map(conversationLine).join('\n'),
      );
    }
    if (data.users?.length) {
      sections.push(`Personnes (${data.users.length}) :\n` + data.users.map(userLine).join('\n'));
    }
    if (data.messages?.length) {
      sections.push(
        `Messages (${data.messages.length}) :\n` +
          data.messages
            .slice(0, 30)
            .map((m) => `[${m.conversationTitle || `conv #${m.conversationId}`}] ${messageLine(m)}`)
            .join('\n'),
      );
    }
    return textResult(sections.length ? `Recherche « ${query} » :\n\n${sections.join('\n\n')}` : `Aucun résultat pour « ${query} ».`);
  }),
);

server.registerTool(
  'pulse_list_contacts',
  {
    title: 'Lister les contacts',
    description:
      'Liste les contacts acceptés et les demandes de contact entrantes/sortantes. ' +
      'Donne les userId nécessaires pour créer une conversation directe ou inviter dans un groupe.',
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const [contacts, requests] = await Promise.all([
      api('contacts_list'),
      api('contact_requests_list'),
    ]);
    const lines = [`Contacts acceptés (${contacts.users?.length || 0}) :`];
    lines.push(
      contacts.users?.length ? contacts.users.map(userLine).join('\n') : '  (aucun)',
    );
    lines.push('', `Demandes reçues (${requests.incoming?.length || 0}) :`);
    lines.push(
      requests.incoming?.length
        ? requests.incoming
            .map((r) => `demande #${r.id} de ${userLine(r.user)} — ${fmtDate(r.createdAt)}`)
            .join('\n')
        : '  (aucune)',
    );
    lines.push('', `Demandes envoyées (${requests.outgoing?.length || 0}) :`);
    lines.push(
      requests.outgoing?.length
        ? requests.outgoing
            .map((r) => `demande #${r.id} vers ${userLine(r.user)} — ${fmtDate(r.createdAt)}`)
            .join('\n')
        : '  (aucune)',
    );
    return textResult(lines.join('\n'));
  }),
);

server.registerTool(
  'pulse_find_people',
  {
    title: 'Chercher des personnes',
    description:
      "Recherche des utilisateurs Pulse par nom, @identifiant ou e-mail. " +
      'Indique le statut de contact et la conversation directe existante (directId) le cas échéant.',
    inputSchema: {
      query: z.string().min(1).max(120).describe('Nom, identifiant ou e-mail recherché.'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ query }) => {
    const { users } = await api('user_search', { q: query });
    if (!users?.length) return textResult(`Aucun utilisateur trouvé pour « ${query} ».`);
    return textResult(
      `${users.length} personne(s) trouvée(s) pour « ${query} » :\n\n` +
        users
          .map(
            (u) =>
              `${userLine(u)}${u.hasDirect ? ` — conversation directe : #${u.directId}` : ''}${
                u.bio ? `\n    ${u.bio}` : ''
              }`,
          )
          .join('\n'),
    );
  }),
);

server.registerTool(
  'pulse_list_media',
  {
    title: 'Galerie d’une conversation',
    description:
      'Liste les photos, vocaux et fichiers partagés dans une conversation, avec leur mediaId et le message associé.',
    inputSchema: {
      conversationId: z.number().int().positive().describe('Identifiant de la conversation.'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ conversationId }) => {
    const { items } = await api('conversation_media', { id: conversationId });
    if (!items?.length) return textResult(`Aucun média dans la conversation #${conversationId}.`);
    return textResult(
      `${items.length} média(s) dans #${conversationId} :\n\n` +
        items
          .map(
            (it) =>
              `media #${it.media.id} (${it.media.kind}) — message #${it.messageId} de ${it.senderName}, ` +
              `${fmtDate(it.createdAt)} — ${it.media.filename || ''} ${it.media.size ? `(${Math.round(it.media.size / 1024)} Ko)` : ''}`,
          )
          .join('\n'),
    );
  }),
);

/* --- écriture : messagerie ---------------------------------------------- */

function registerWriteTool(name, config, handler) {
  if (READ_ONLY) return;
  server.registerTool(name, config, handler);
}

registerWriteTool(
  'pulse_send_message',
  {
    title: 'Envoyer un message',
    description:
      "Envoie un message texte (ou un sondage) dans une conversation. " +
      "À n'utiliser que sur demande explicite de l'utilisateur. `replyToId` cite un message existant. " +
      'Pour un sondage, fournis `poll` (question + 2 à 10 options) et laisse `text` vide.',
    inputSchema: {
      conversationId: z.number().int().positive().describe('Conversation cible (#id).'),
      text: z.string().min(1).max(4000).optional().describe('Texte du message (max 4000 caractères).'),
      replyToId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Identifiant du message auquel répondre (#id).'),
      poll: z
        .object({
          question: z.string().min(1).max(300),
          options: z.array(z.string().min(1).max(120)).min(2).max(10),
          multiple: z.boolean().optional().describe('Autoriser plusieurs choix (sondage simple).'),
        })
        .optional()
        .describe('Sondage à créer. Exclusif avec `text`.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  tool(async ({ conversationId, text, replyToId, poll }) => {
    if (!text && !poll) throw new Error('Fournis `text` ou `poll`.');
    if (text && poll) throw new Error('Fournis `text` OU `poll`, pas les deux.');
    const payload = { conversationId, type: poll ? 'poll' : 'text' };
    if (replyToId) payload.replyTo = replyToId;
    if (poll) {
      payload.body = poll.question;
      payload.poll = {
        question: poll.question,
        kind: 'choice',
        multiple: !!poll.multiple,
        options: poll.options,
      };
    } else {
      payload.body = text;
    }
    if (DRY_RUN) return dryRun(`Message vers #${conversationId}.`, 'message_send', payload);

    const { message } = await api('message_send', payload);
    return textResult(
      `Message envoyé dans #${conversationId} :\n${messageLine(message)}\n` +
        `(message #${message.id})`,
    );
  }),
);

registerWriteTool(
  'pulse_edit_message',
  {
    title: 'Modifier un message',
    description:
      "Modifie le texte d'un message envoyé par le compte connecté (limite serveur : 15 minutes). " +
      "À n'utiliser que sur demande explicite.",
    inputSchema: {
      messageId: z.number().int().positive().describe('Identifiant du message (#id).'),
      text: z.string().min(1).max(4000).describe('Nouveau texte.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  tool(async ({ messageId, text }) => {
    if (DRY_RUN) return dryRun(`Modification du message #${messageId}.`, 'message_edit', { messageId, body: text });
    const { message } = await api('message_edit', { messageId, body: text });
    return textResult(`Message #${messageId} modifié :\n${messageLine(message)}`);
  }),
);

registerWriteTool(
  'pulse_delete_message',
  {
    title: 'Supprimer un message',
    description:
      "Supprime un message. Par défaut, suppression pour soi uniquement (`forEveryone: false`) ; " +
      "`forEveryone: true` le supprime pour tous les participants et est irréversible. " +
      "Ne le fais qu'après une demande explicite et confirmée.",
    inputSchema: {
      messageId: z.number().int().positive().describe('Identifiant du message (#id).'),
      forEveryone: z
        .boolean()
        .optional()
        .default(false)
        .describe('Supprimer aussi pour les autres participants (irréversible).'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  tool(async ({ messageId, forEveryone = false }) => {
    if (DRY_RUN)
      return dryRun(`Suppression du message #${messageId}.`, 'message_delete', { messageId, forEveryone });
    await api('message_delete', { messageId, forEveryone });
    return textResult(
      `Message #${messageId} supprimé ${forEveryone ? 'pour tout le monde' : 'pour moi uniquement'}.`,
    );
  }),
);

registerWriteTool(
  'pulse_react',
  {
    title: 'Réagir à un message',
    description:
      "Ajoute ou retire une réaction emoji sur un message (le même emoji deux fois retire la réaction). " +
      "Emojis autorisés : 👍 ❤️ 😂 😮 😢 🙏 🔥 👏 ✅ 👀 🎉 😍.",
    inputSchema: {
      messageId: z.number().int().positive().describe('Identifiant du message (#id).'),
      emoji: z
        .enum(['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '✅', '👀', '🎉', '😍'])
        .describe('Emoji de réaction.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  tool(async ({ messageId, emoji }) => {
    if (DRY_RUN) return dryRun(`Réaction ${emoji} sur #${messageId}.`, 'message_react', { messageId, emoji });
    const { reactions } = await api('message_react', { messageId, emoji });
    return textResult(
      `Réaction ${emoji} appliquée au message #${messageId}. Réactions actuelles : ` +
        (reactions?.length ? reactions.map((r) => `${r.emoji} ${r.name}`).join(' · ') : 'aucune'),
    );
  }),
);

registerWriteTool(
  'pulse_mark_read',
  {
    title: 'Marquer comme lu',
    description:
      "Marque une conversation comme lue jusqu'à un message. Sans `messageId`, marque jusqu'au dernier message.",
    inputSchema: {
      conversationId: z.number().int().positive().describe('Identifiant de la conversation.'),
      messageId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Marquer comme lu jusqu’à ce message inclus.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  tool(async ({ conversationId, messageId }) => {
    let target = messageId;
    if (!target) {
      const { messages } = await api('messages_list', { conversationId, limit: 1 });
      target = messages?.[messages.length - 1]?.id;
    }
    if (!target) return textResult(`Aucun message à marquer comme lu dans #${conversationId}.`);
    if (DRY_RUN)
      return dryRun(`Marquer #${conversationId} lu jusqu'à #${target}.`, 'conversation_read', {
        id: conversationId,
        messageId: target,
      });
    await api('conversation_read', { id: conversationId, messageId: target });
    return textResult(`Conversation #${conversationId} marquée comme lue jusqu'au message #${target}.`);
  }),
);

registerWriteTool(
  'pulse_create_direct',
  {
    title: 'Ouvrir une conversation directe',
    description:
      "Ouvre (ou retrouve) la conversation directe avec un utilisateur. " +
      "Le contact doit exister (utilise pulse_find_people pour obtenir son userId).",
    inputSchema: {
      userId: z.number().int().positive().describe('Identifiant de l’utilisateur cible.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  tool(async ({ userId }) => {
    if (DRY_RUN) return dryRun(`Conversation directe avec #${userId}.`, 'conversation_create_direct', { userId });
    const { conversation } = await api('conversation_create_direct', { userId });
    return textResult(
      `Conversation directe prête : ${conversationLine(compactConversation(conversation))}`,
    );
  }),
);

registerWriteTool(
  'pulse_create_group',
  {
    title: 'Créer un groupe',
    description:
      "Crée un groupe avec un nom et des membres (userId obtenus via pulse_find_people ou pulse_list_contacts). " +
      "Le compte connecté en devient propriétaire.",
    inputSchema: {
      name: z.string().min(2).max(80).describe('Nom du groupe.'),
      memberIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(250)
        .describe('Identifiants des membres à ajouter.'),
      description: z.string().max(500).optional().describe('Description du groupe.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  tool(async ({ name, memberIds, description }) => {
    const payload = { name, memberIds, description };
    if (DRY_RUN) return dryRun(`Création du groupe « ${name} ».`, 'conversation_create_group', payload);
    const { conversation } = await api('conversation_create_group', payload);
    return textResult(
      `Groupe créé : ${conversationLine(compactConversation(conversation))}\n` +
        `Utilise conversationId=${conversation.id} pour envoyer des messages.`,
    );
  }),
);

registerWriteTool(
  'pulse_forward_message',
  {
    title: 'Transférer un message',
    description:
      "Transfère un message existant vers une ou plusieurs conversations. " +
      "Utilise pulse_list_conversations pour obtenir les conversationId.",
    inputSchema: {
      messageId: z.number().int().positive().describe('Identifiant du message à transférer (#id).'),
      conversationIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(20)
        .describe('Conversations de destination.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  tool(async ({ messageId, conversationIds }) => {
    if (DRY_RUN)
      return dryRun(`Transfert du message #${messageId}.`, 'message_forward', { messageId, conversationIds });
    const { messages } = await api('message_forward', { messageId, conversationIds });
    return textResult(
      `Message #${messageId} transféré dans ${conversationIds.length} conversation(s) : ` +
        (messages || []).map((m) => `#${m.id} → conv #${m.conversationId}`).join(', '),
    );
  }),
);

registerWriteTool(
  'pulse_star_message',
  {
    title: 'Mettre un message en favori',
    description: 'Ajoute ou retire un message des favoris du compte connecté.',
    inputSchema: {
      messageId: z.number().int().positive().describe('Identifiant du message (#id).'),
      starred: z.boolean().optional().default(true).describe('true pour ajouter, false pour retirer.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  tool(async ({ messageId, starred = true }) => {
    if (DRY_RUN) return dryRun(`Favori sur #${messageId}.`, 'message_star', { messageId, starred });
    await api('message_star', { messageId, starred });
    return textResult(`Message #${messageId} ${starred ? 'ajouté aux' : 'retiré des'} favoris.`);
  }),
);

registerWriteTool(
  'pulse_pin_message',
  {
    title: 'Épingler un message',
    description:
      "Épingle ou désépingle un message dans sa conversation (bannière en haut du chat). " +
      "Un seul message épinglé par conversation.",
    inputSchema: {
      messageId: z.number().int().positive().describe('Identifiant du message (#id).'),
      pinned: z.boolean().optional().default(true).describe('true pour épingler, false pour retirer.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  tool(async ({ messageId, pinned = true }) => {
    if (DRY_RUN) return dryRun(`Épinglage du message #${messageId}.`, 'message_pin', { messageId, pinned });
    const { pinnedMessageId } = await api('message_pin', { messageId, pinned });
    return textResult(
      pinned
        ? `Message #${messageId} épinglé (message épinglé actuel : #${pinnedMessageId}).`
        : `Message #${messageId} désépinglé.`,
    );
  }),
);

/* ------------------------------------------------------------------- run */

function describeConfig() {
  const source = API_TOKEN
    ? 'PULSE_API_TOKEN'
    : LEGACY_SESSION_TOKEN
      ? 'PULSE_SESSION_TOKEN (legacy)'
      : LOGIN
        ? 'login/mot de passe'
        : 'aucune';
  return [
    `API         : ${API_URL}`,
    `Compte      : ${LOGIN || (API_TOKEN || LEGACY_SESSION_TOKEN ? '(via jeton)' : '(non configuré)')}`,
    `Auth        : ${source}`,
    `Mode        : ${READ_ONLY ? 'lecture seule' : 'lecture + messagerie'}${DRY_RUN ? ' + dry-run' : ''}`,
    `Cache       : ${SESSION_FILE}`,
    `Délai       : ${TIMEOUT_MS} ms`,
  ].join('\n');
}

async function runCheck() {
  console.log('Configuration pulse-mcp\n' + describeConfig() + '\n');
  const ping = await rawRequest('ping');
  console.log('✓ API joignable :', JSON.stringify(ping));
  if (!API_TOKEN && !LEGACY_SESSION_TOKEN && !LOGIN) {
    console.log('! Aucun identifiant : les outils authentifiés échoueront.');
    return;
  }
  if (!API_TOKEN && !LEGACY_SESSION_TOKEN && LOGIN && PASSWORD) {
    clearCachedToken();
    sessionToken = '';
    await ensureSession(true);
  }
  const { user } = await api('me');
  console.log(`✓ Connecté : #${user.id} ${user.name} (@${user.username}), rôle ${user.role}`);
  console.log(`✓ Non-lus : ${user.unreadTotal ?? 0}, demandes de contact : ${user.contactRequests ?? 0}`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'Serveur MCP Pulse (stdio).\n\n' +
        'Usage : node mcp/pulse-mcp.mjs [--check|--help]\n\n' +
        'Variables : PULSE_API_URL, PULSE_API_TOKEN, PULSE_LOGIN, PULSE_PASSWORD,\n' +
        '            PULSE_SESSION_TOKEN (legacy), PULSE_READ_ONLY=1, PULSE_DRY_RUN=1,\n' +
        '            PULSE_TIMEOUT_MS, PULSE_SESSION_FILE\n' +
        'Fichier .env supporté : mcp/.env ou ~/.config/pulse-mcp/.env\n',
    );
    return;
  }
  if (process.argv.includes('--check')) {
    await runCheck();
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[pulse-mcp] prêt — ${API_URL} — ${LOGIN ? `compte ${LOGIN}` : 'sans identifiants'}` +
      `${READ_ONLY ? ' — lecture seule' : ''}${DRY_RUN ? ' — dry-run' : ''}`,
  );
}

main().catch((e) => {
  console.error(`[pulse-mcp] démarrage impossible : ${e?.stack || e}`);
  process.exit(1);
});
