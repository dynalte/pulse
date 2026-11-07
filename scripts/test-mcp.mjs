/**
 * Test du serveur MCP Pulse (Node 18+).
 *
 * Lance une fausse API Pulse en mémoire, puis un vrai client MCP qui parle au
 * serveur `mcp/pulse-mcp.mjs` en stdio. Vérifie la découverte des outils, la
 * lecture, l'écriture, le cache de session et la reconnexion sur 401.
 *
 * Usage : node scripts/test-mcp.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp/pulse-mcp.mjs');
let passed = 0;

function check(name, cond, extra = '') {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`);
    process.exitCode = 1;
    throw new Error(name);
  }
  passed++;
  console.log(`✓ ${name}`);
}

/* ------------------------------------------------------------- faux serveur */

const now = Math.floor(Date.now() / 1000);
let validTokens = new Set();
const validApiTokens = new Set();
const apiTokenStore = [];
let apiTokenSeq = 0;
let loginCount = 0;
let convListCount = 0;
let delegatedToken = '';

const user = {
  id: 1, username: 'assistant', name: 'Assistant', bio: 'Compte IA',
  email: 'assistant@example.com', avatarId: null, role: 'member',
  createdAt: now - 86400, lastSeen: now, online: true, unreadTotal: 2,
  contactRequests: 0, notif: {}, privacy: {},
};
const peer = {
  id: 2, username: 'alice', name: 'Alice', bio: '', phone: '', email: 'alice@example.com',
  avatarId: null, role: 'member', createdAt: now - 90000, lastSeen: now - 30,
  online: true, isContact: true, contactStatus: 'accepted',
};
const delegatedUser = {
  ...user, id: 3, username: 'bob', name: 'Bob', bio: 'Compte délégué', email: 'bob@example.com',
};
const conversation = {
  id: 10, type: 'direct', title: 'Alice', description: '', avatarId: null,
  createdBy: 1, createdAt: now - 3600, updatedAt: now - 60,
  members: [], peer,
  unread: 2, lastReadMessageId: 40, lastDeliveredMessageId: 42, myRole: 'member',
  mutedUntil: 0, pinned: 0, archived: 0, inviteCode: '', disappearingSeconds: 0,
  onlyAdminsCanPost: 0, memberCount: 2, pinnedMessageId: 0, pinnedMessage: null,
  blocked: false,
  lastMessage: {
    id: 42, senderId: 2, senderName: 'Alice', type: 'text', body: 'Tu es là ?',
    mediaId: null, createdAt: now - 60, deleted: false,
  },
};
const messages = [
  {
    id: 41, conversationId: 10, senderId: 1, senderName: 'Assistant',
    senderUsername: 'assistant', senderAvatarId: null, type: 'text',
    body: 'Bonjour Alice', media: null, replyTo: null, reactions: [], mentions: [],
    poll: null, location: null, readCount: 1, deliveredCount: 1, starred: false,
    editedAt: 0, deletedAt: 0, createdAt: now - 120, expiresAt: 0, forwarded: false,
    mine: true, conversationTitle: 'Alice',
  },
  {
    id: 42, conversationId: 10, senderId: 2, senderName: 'Alice',
    senderUsername: 'alice', senderAvatarId: null, type: 'text',
    body: 'Tu es là ?', media: null, replyTo: null, reactions: [], mentions: [],
    poll: null, location: null, readCount: 0, deliveredCount: 1, starred: false,
    editedAt: 0, deletedAt: 0, createdAt: now - 60, expiresAt: 0, forwarded: false,
    mine: false, conversationTitle: 'Alice',
  },
];

function publicUser(u) {
  const { notif, privacy, ...rest } = u;
  return rest;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function requireAuth(req, res) {
  const session = String(req.headers['x-session-token'] || '');
  const api = String(req.headers['x-api-token'] || '');
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (validTokens.has(session) || validApiTokens.has(api) || (bearer && validApiTokens.has(bearer))) {
    return true;
  }
  json(res, 401, { ok: false, error: 'Session expirée ou compte désactivé.' });
  return false;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function handle(action, body, req) {
  switch (action) {
    case 'ping':
      return [200, { ok: true, app: 'Pulse', version: 'test', time: now }];
    case 'login': {
      if (body.login !== 'assistant' || body.password !== 'secret123') {
        return [401, { ok: false, error: 'Identifiant ou mot de passe incorrect.' }];
      }
      loginCount++;
      const token = `tok-${loginCount}`;
      validTokens.add(token);
      return [200, { ok: true, token, user }];
    }
    case 'me': {
      const token = String(req.headers['x-api-token'] || '');
      return [200, { ok: true, user: token && token === delegatedToken ? delegatedUser : user }];
    }
    case 'conversations_list':
      convListCount++;
      return [200, { ok: true, conversations: [conversation], unreadTotal: 2 }];
    case 'conversation_get':
      return [
        200,
        {
          ok: true,
          conversation,
          members: [
            { ...publicUser(user), memberRole: 'member', lastReadMessageId: 42, mutedUntil: 0 },
            { ...publicUser(peer), memberRole: 'member', lastReadMessageId: 41, mutedUntil: 0 },
          ],
        },
      ];
    case 'messages_list':
      return [
        200,
        {
          ok: true,
          messages: body.limit === 1 ? [messages[1]] : messages,
          hasMore: false,
          myLastRead: 40,
          peerReads: [{ userId: 2, lastReadMessageId: 41 }],
        },
      ];
    case 'message_send': {
      const message = {
        ...messages[0],
        id: 43,
        body: body.body,
        type: body.type,
        poll: body.poll || null,
        createdAt: now,
        mine: true,
      };
      return [200, { ok: true, message, conversation }];
    }
    case 'message_edit':
      return [200, { ok: true, message: { ...messages[0], id: body.messageId, body: body.body, editedAt: now } }];
    case 'message_delete':
      return [200, { ok: true, messageId: body.messageId }];
    case 'message_react':
      return [
        200,
        {
          ok: true,
          messageId: body.messageId,
          reactions: [{ userId: 1, name: 'Assistant', emoji: body.emoji }],
        },
      ];
    case 'conversation_read':
      return [200, { ok: true }];
    case 'conversation_create_direct':
      return [200, { ok: true, conversation }];
    case 'conversation_create_group':
      return [
        200,
        {
          ok: true,
          conversation: {
            ...conversation,
            id: 11,
            type: 'group',
            title: body.name,
            description: body.description || '',
            peer: null,
            memberCount: body.memberIds.length + 1,
          },
        },
      ];
    case 'message_forward':
      return [
        200,
        { ok: true, messages: body.conversationIds.map((cid, i) => ({ ...messages[0], id: 50 + i, conversationId: cid })) },
      ];
    case 'message_star':
    case 'message_pin':
      return [200, { ok: true, pinnedMessageId: body.messageId }];
    case 'search_messages':
      return [200, { ok: true, messages: [messages[1]] }];
    case 'search':
      return [200, { ok: true, conversations: [conversation], users: [peer], messages: [messages[1]] }];
    case 'contacts_list':
      return [200, { ok: true, users: [peer], incoming: 0 }];
    case 'contact_requests_list':
      return [200, { ok: true, incoming: [], outgoing: [] }];
    case 'user_search':
      return [200, { ok: true, users: [peer] }];
    case 'conversation_media':
      return [
        200,
        {
          ok: true,
          items: [
            {
              messageId: 44, createdAt: now - 10, senderName: 'Alice',
              media: { id: 7, kind: 'image', mime: 'image/jpeg', size: 2048, width: 800, height: 600, duration: 0, filename: 'photo.jpg', waveform: [] },
            },
          ],
        },
      ];
    case 'token_create': {
      if (!validTokens.has(String(req?.headers['x-session-token'] || ''))) {
        return [403, { ok: false, error: 'La gestion des jetons nécessite une session web connectée.' }];
      }
      const seq = ++apiTokenSeq;
      const token = `pulse_${String(seq).padStart(64, 'a')}`;
      validApiTokens.add(token);
      const tokenInfo = {
        id: seq,
        name: body.name || 'Jeton',
        prefix: token.slice(0, 14),
        createdAt: now,
        lastUsedAt: 0,
        expiresAt: body.days ? now + body.days * 86400 : 0,
      };
      apiTokenStore.unshift(tokenInfo);
      return [200, { ok: true, token, tokenInfo }];
    }
    case 'tokens_list':
      return [200, { ok: true, tokens: apiTokenStore }];
    case 'token_revoke': {
      const idx = apiTokenStore.findIndex((t) => t.id === body.id);
      if (idx >= 0) apiTokenStore.splice(idx, 1);
      return [200, { ok: true, id: body.id }];
    }
    default:
      return [404, { ok: false, error: `Action inconnue : ${action}` }];
  }
}

const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || '';
  const body = await readBody(req);
  if (action !== 'ping' && action !== 'login' && !requireAuth(req, res)) return;
  const [status, payload] = handle(action, body, req);
  json(res, status, payload);
});

/* ---------------------------------------------------------------------- test */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mcp-test-'));
const sessionFile = path.join(tmp, 'session.json');

await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}/api-messagerie.php`;

const client = new Client({ name: 'pulse-mcp-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  cwd: ROOT,
  env: {
    ...process.env,
    PULSE_NO_DOTENV: '1',
    PULSE_API_URL: apiUrl,
    PULSE_LOGIN: 'assistant',
    PULSE_PASSWORD: 'secret123',
    PULSE_SESSION_FILE: sessionFile,
  },
  stderr: 'pipe',
});

await client.connect(transport);

function textOf(result) {
  return (result.content || []).map((c) => c.text || '').join('\n');
}

try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check('découverte : 22 outils exposés', names.length === 22, `→ ${names.length}`);
  for (const name of [
    'pulse_health', 'pulse_whoami', 'pulse_list_conversations', 'pulse_get_conversation',
    'pulse_read_messages', 'pulse_search', 'pulse_list_contacts', 'pulse_find_people',
    'pulse_list_media', 'pulse_unread_summary', 'pulse_send_message', 'pulse_send_to',
    'pulse_reply_last', 'pulse_edit_message', 'pulse_delete_message',
    'pulse_react', 'pulse_mark_read', 'pulse_create_direct', 'pulse_create_group',
    'pulse_forward_message', 'pulse_star_message', 'pulse_pin_message',
  ]) {
    check(`outil présent : ${name}`, names.includes(name));
  }

  let r = await client.callTool({ name: 'pulse_health', arguments: {} });
  check('pulse_health : API joignable', textOf(r).includes('API Pulse joignable'));

  r = await client.callTool({ name: 'pulse_whoami', arguments: {} });
  check('pulse_whoami : compte connecté', textOf(r).includes('Assistant'), textOf(r).slice(0, 200));
  check('pulse_whoami : premier login', loginCount === 1, `→ ${loginCount}`);
  check('cache de session écrit', fs.existsSync(sessionFile));
  check('cache de session en 0600', (fs.statSync(sessionFile).mode & 0o777) === 0o600);

  r = await client.callTool({ name: 'pulse_list_conversations', arguments: {} });
  check('list_conversations : id et dernier message', textOf(r).includes('#10') && textOf(r).includes('Tu es là ?'));

  const beforeConv = convListCount;
  r = await client.callTool({ name: 'pulse_unread_summary', arguments: {} });
  check('unread_summary : non-lus', textOf(r).includes('Alice') && textOf(r).includes('non lu'), textOf(r));
  check('cache : unread_summary réutilise conversations_list', convListCount === beforeConv, `→ ${convListCount - beforeConv}`);

  r = await client.callTool({ name: 'pulse_send_to', arguments: { target: 'Alice', text: 'Message raccourci' } });
  check('send_to : contact résolu et message envoyé', textOf(r).includes('Message raccourci') && textOf(r).includes('Alice'), textOf(r));

  r = await client.callTool({ name: 'pulse_reply_last', arguments: { target: '#10', text: 'Réponse rapide' } });
  check('reply_last : citation du dernier message', textOf(r).includes('Réponse rapide') && textOf(r).includes('réponse à #42'), textOf(r));

  const afterWrite = convListCount;
  await client.callTool({ name: 'pulse_list_conversations', arguments: {} });
  check('écriture : cache invalidé', convListCount === afterWrite + 1, `→ ${convListCount - afterWrite}`);

  r = await client.callTool({ name: 'pulse_get_conversation', arguments: { conversationId: 10 } });
  check('get_conversation : membres listés', textOf(r).includes('Alice') && textOf(r).includes('Membres'));

  r = await client.callTool({ name: 'pulse_read_messages', arguments: { conversationId: 10, limit: 30 } });
  check('read_messages : transcript horodaté', textOf(r).includes('#41') && textOf(r).includes('Bonjour Alice'));
  check('read_messages : indicateur de pagination', textOf(r).includes('Début de la conversation'));

  r = await client.callTool({ name: 'pulse_search', arguments: { query: 'là' } });
  check('search globale : messages trouvés', textOf(r).includes('Tu es là ?'));

  r = await client.callTool({ name: 'pulse_list_contacts', arguments: {} });
  check('list_contacts : contact accepté', textOf(r).includes('Alice') && textOf(r).includes('Contacts acceptés'));

  r = await client.callTool({ name: 'pulse_find_people', arguments: { query: 'alice' } });
  check('find_people : conversation directe indiquée', textOf(r).includes('@alice'));

  r = await client.callTool({ name: 'pulse_list_media', arguments: { conversationId: 10 } });
  check('list_media : média listé', textOf(r).includes('photo.jpg'));

  r = await client.callTool({ name: 'pulse_send_message', arguments: { conversationId: 10, text: 'Message de test' } });
  check('send_message : message #43', textOf(r).includes('Message de test') && textOf(r).includes('#43'), textOf(r));

  r = await client.callTool({ name: 'pulse_send_message', arguments: { conversationId: 10, text: 'x', poll: { question: 'Q', options: ['a', 'b'] } } });
  check('send_message : texte + sondage refusé', r.isError === true);

  r = await client.callTool({ name: 'pulse_react', arguments: { messageId: 42, emoji: '👍' } });
  check('react : réaction appliquée', textOf(r).includes('👍'));

  r = await client.callTool({ name: 'pulse_delete_message', arguments: { messageId: 42 } });
  check('delete_message : suppression pour soi par défaut', textOf(r).includes('pour moi uniquement'));

  r = await client.callTool({ name: 'pulse_mark_read', arguments: { conversationId: 10 } });
  check('mark_read : dernier message ciblé', textOf(r).includes('#42'));

  r = await client.callTool({ name: 'pulse_create_group', arguments: { name: 'Équipe', memberIds: [2] } });
  check('create_group : identifiant retourné', textOf(r).includes('conversationId=11'));

  // 401 → le serveur doit se reconnecter tout seul et rejouer l'appel.
  validTokens = new Set();
  const before = loginCount;
  r = await client.callTool({ name: 'pulse_whoami', arguments: {} });
  check('reconnexion transparente sur 401', !r.isError && textOf(r).includes('Assistant'), textOf(r).slice(0, 200));
  check('reconnexion : nouveau login', loginCount === before + 1, `→ ${loginCount}`);

  // Mauvais identifiants → erreur propre, pas de crash.
  const bad = new Client({ name: 'pulse-mcp-test-bad', version: '1.0.0' });
  const badTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      PULSE_NO_DOTENV: '1',
      PULSE_API_URL: apiUrl,
      PULSE_LOGIN: 'assistant',
      PULSE_PASSWORD: 'mauvais',
      PULSE_SESSION_FILE: path.join(tmp, 'bad.json'),
    },
    stderr: 'pipe',
  });
  await bad.connect(badTransport);
  r = await bad.callTool({ name: 'pulse_whoami', arguments: {} });
  check('mauvais mot de passe : erreur explicite', r.isError === true && textOf(r).includes('incorrect'), textOf(r));
  await bad.close();

  // Mode lecture seule : les outils d'écriture disparaissent.
  const ro = new Client({ name: 'pulse-mcp-test-ro', version: '1.0.0' });
  const roTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      PULSE_NO_DOTENV: '1',
      PULSE_API_URL: apiUrl,
      PULSE_LOGIN: 'assistant',
      PULSE_PASSWORD: 'secret123',
      PULSE_SESSION_FILE: path.join(tmp, 'ro.json'),
      PULSE_READ_ONLY: '1',
    },
    stderr: 'pipe',
  });
  await ro.connect(roTransport);
  const roTools = (await ro.listTools()).tools.map((t) => t.name);
  check('lecture seule : 10 outils', roTools.length === 10, `→ ${roTools.length}`);
  check('lecture seule : send_message absent', !roTools.includes('pulse_send_message'));
  check('lecture seule : read_messages présent', roTools.includes('pulse_read_messages'));
  await ro.close();

  // Dry-run : l'outil d'écriture répond sans appeler l'API.
  const dry = new Client({ name: 'pulse-mcp-test-dry', version: '1.0.0' });
  const dryTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      PULSE_NO_DOTENV: '1',
      PULSE_API_URL: apiUrl,
      PULSE_LOGIN: 'assistant',
      PULSE_PASSWORD: 'secret123',
      PULSE_SESSION_FILE: path.join(tmp, 'dry.json'),
      PULSE_DRY_RUN: '1',
    },
    stderr: 'pipe',
  });
  await dry.connect(dryTransport);
  r = await dry.callTool({ name: 'pulse_send_message', arguments: { conversationId: 10, text: 'simulation' } });
  check('dry-run : aucun envoi', !r.isError && textOf(r).includes('dryRun') && textOf(r).includes('simulation'), textOf(r));
  await dry.close();

  // Génération d'un jeton : le mot de passe ne doit pas finir dans le fichier.
  const tokenEnv = path.join(tmp, 'token.env');
  fs.writeFileSync(tokenEnv, `PULSE_API_URL=${apiUrl}\nPULSE_LOGIN=\nPULSE_PASSWORD=\n`);

  const produced = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/pulse-token.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PULSE_ENV_FILE: tokenEnv,
        PULSE_NO_DOTENV: '1',
        PULSE_API_URL: apiUrl,
        PULSE_LOGIN: 'assistant',
        PULSE_PASSWORD: 'secret123',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  check('token : génération réussie', produced.code === 0, produced.stderr);
  const tokenFile = fs.readFileSync(tokenEnv, 'utf8');
  const tokenMatch = tokenFile.match(/^PULSE_API_TOKEN=(\S+)$/m);
  check('token : PULSE_API_TOKEN écrit', !!tokenMatch, tokenFile);
  check('token : mot de passe non enregistré', !tokenFile.includes('secret123'), tokenFile);
  check('token : permissions 600',
    (fs.statSync(tokenEnv).mode & 0o777) === 0o600,
    (fs.statSync(tokenEnv).mode & 0o777).toString(8),
  );

  // Le serveur MCP doit fonctionner avec le jeton d'accès seul (sans login/mot de passe).
  const tok = new Client({ name: 'pulse-mcp-test-token', version: '1.0.0' });
  const tokTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      PULSE_NO_DOTENV: '1',
      PULSE_API_URL: apiUrl,
      PULSE_API_TOKEN: tokenMatch[1],
      PULSE_SESSION_FILE: path.join(tmp, 'token-session.json'),
      PULSE_LOGIN: '',
      PULSE_PASSWORD: '',
    },
    stderr: 'pipe',
  });
  await tok.connect(tokTransport);
  r = await tok.callTool({ name: 'pulse_whoami', arguments: {} });
  check('jeton d’accès seul : authentification OK', !r.isError && textOf(r).includes('Assistant'), textOf(r));
  await tok.close();

  // Identité par session OpenCode : deux utilisateurs partagent le processus.
  const sessionDir = path.join(tmp, 'echo-sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  delegatedToken = 'pulse_delegated_test';
  validApiTokens.add(delegatedToken);
  const boundSession = 'ses_delegated';
  fs.writeFileSync(
    path.join(sessionDir, `${boundSession}.json`),
    JSON.stringify({ token: delegatedToken, apiUrl }),
  );
  fs.writeFileSync(
    path.join(sessionDir, 'ses_empty.json'),
    JSON.stringify({ token: '', apiUrl }),
  );

  const shared = new Client({ name: 'pulse-mcp-test-sessions', version: '1.0.0' });
  const sharedTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      PULSE_NO_DOTENV: '1',
      PULSE_API_URL: apiUrl,
      PULSE_API_TOKEN: tokenMatch[1],
      PULSE_SESSION_DIR: sessionDir,
      PULSE_SESSION_FILE: path.join(tmp, 'shared-session.json'),
      PULSE_LOGIN: '',
      PULSE_PASSWORD: '',
    },
    stderr: 'pipe',
  });
  await shared.connect(sharedTransport);

  r = await shared.callTool({
    name: 'pulse_whoami',
    arguments: {},
    _meta: { 'ai.opencode/sessionID': boundSession },
  });
  check(
    'session liée : compte délégué utilisé',
    !r.isError && textOf(r).includes('Bob') && !textOf(r).includes('Assistant'),
    textOf(r),
  );

  r = await shared.callTool({
    name: 'pulse_whoami',
    arguments: {},
    _meta: { 'ai.opencode/sessionID': 'ses_empty' },
  });
  check('session vide : pas de repli sur le compte admin', r.isError === true, textOf(r));

  r = await shared.callTool({
    name: 'pulse_whoami',
    arguments: {},
    _meta: { 'ai.opencode/sessionID': 'ses_unknown' },
  });
  check('session inconnue : repli sur le compte admin', !r.isError && textOf(r).includes('Assistant'), textOf(r));

  const { resources } = await shared.listResources();
  check(
    'instructions exposées en ressource',
    resources.some((res) => res.uri === 'pulse://instructions' && res.description?.includes('messagerie privée')),
  );
  await shared.close();

  console.log(`\n${passed} assertions réussies.`);
} finally {
  await client.close();
  api.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
