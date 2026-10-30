/**
 * Test fonctionnel de l'API Pulse (Node 18+).
 * Usage : node scripts/test-api.mjs  (API_URL surchargeable)
 * Suppose une base vierge (api/data/messagerie.sqlite absente).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL || 'http://127.0.0.1:8110/api-messagerie.php';
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

async function call(action, body, token, expectStatus = 200) {
  const res = await fetch(`${API}?action=${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Session-Token': token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (expectStatus !== null && res.status !== expectStatus) {
    throw new Error(`${action}: HTTP ${res.status} (attendu ${expectStatus}) ${text.slice(0, 300)}`);
  }
  return { status: res.status, data };
}

async function upload(token, blob, filename, kind, extra = {}) {
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('kind', kind);
  for (const [k, v] of Object.entries(extra)) fd.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
  const res = await fetch(`${API}?action=media_upload`, {
    method: 'POST',
    headers: { 'X-Session-Token': token },
    body: fd,
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`upload ${kind}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data.media;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = fs.readFileSync(path.join(ROOT, 'public/pwa-192x192.png'));

// WAV minimal (silence 0,2 s)
function wavBlob() {
  const sampleRate = 8000;
  const samples = 1600;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  return new Blob([buf], { type: 'audio/wav' });
}

console.log(`API : ${API}\n`);

// 1. Bootstrap
let r = await call('bootstrap_status');
check('bootstrap_status : installation nécessaire', r.data.needsSetup === true);
r = await call('bootstrap', { name: 'Alex Martin', email: 'alex@example.com', username: 'alex', password: 'motdepasse1' });
check('bootstrap crée l’admin', r.data.ok && r.data.user.role === 'admin' && r.data.token);
const admin = r.data.token;
const adminId = r.data.user.id;
r = await call('bootstrap', { name: 'X', email: 'x@example.com', username: 'xxx', password: 'motdepasse1' }, null, 403);
check('bootstrap verrouillé après création', r.status === 403);
r = await call('bootstrap_status');
check('bootstrap_status : prêt', r.data.needsSetup === false);

// 2. Login / throttle
r = await call('login', { login: 'alex@example.com', password: 'mauvais' }, null, 401);
check('login refuse un mauvais mot de passe', r.status === 401);
r = await call('login', { login: 'alex', password: 'motdepasse1' });
check('login par identifiant', r.data.ok && r.data.user.email === 'alex@example.com');

// 3. Invitation
r = await call('invite_create', { email: 'bob@example.com', note: 'Bob', expiresIn: 86400 }, admin);
check('création d’invitation', r.data.ok && r.data.invite.code);
const inviteBob = r.data.invite.code;
r = await call('invite_info', { code: inviteBob });
check('invite_info publique', r.data.invite.valid === true && r.data.invite.kind === 'account');
r = await call('register', { inviteCode: inviteBob, name: 'Bob Durand', email: 'bob@autre.com', username: 'bob', password: 'motdepasse2' }, null, 403);
check('invitation nominative : e-mail imposé', r.status === 403);
r = await call('register', { inviteCode: inviteBob, name: 'Bob Durand', email: 'bob@example.com', username: 'bob', password: 'motdepasse2' });
check('inscription sur invitation', r.data.ok && r.data.user.role === 'member');
const bob = r.data.token;
const bobId = r.data.user.id;
r = await call('register', { inviteCode: inviteBob, name: 'Bob 2', email: 'bob2@example.com', username: 'bob2', password: 'motdepasse2' }, null, 403);
check('invitation à usage unique', r.status === 403);
r = await call('invites_list', {}, bob);
check('un membre voit ses invitations', r.data.ok);

// 4. Recherche / profils
r = await call('user_search', { q: 'ale' }, bob);
check('recherche utilisateur', r.data.users.some((u) => u.id === adminId && u.username === 'alex'));
r = await call('user_search', { q: 'zzzz' }, bob);
check('recherche vide', r.data.users.length === 0);
r = await call('profile_get', { userId: adminId }, bob);
check('fiche utilisateur', r.data.user.name === 'Alex Martin' && r.data.user.isContact === true);

// 5. Conversation directe + message
r = await call('conversation_create_direct', { userId: bobId }, admin);
check('création conversation directe', r.data.conversation.type === 'direct');
const directId = r.data.conversation.id;
r = await call('conversation_create_direct', { userId: bobId }, admin);
check('conversation directe réutilisée', r.data.conversation.id === directId);
r = await call('message_send', { conversationId: directId, type: 'text', body: 'Salut Bob !' }, admin);
check('envoi message texte', r.data.message.body === 'Salut Bob !' && r.data.message.mine === true);
const msg1 = r.data.message.id;
r = await call('conversations_list', {}, bob);
check('Bob voit la conversation', r.data.conversations.length === 1 && r.data.unreadTotal === 1);
check('aperçu du dernier message', r.data.conversations[0].lastMessage.body === 'Salut Bob !');

r = await call('messages_list', { conversationId: directId }, bob);
check('Bob lit les messages', r.data.messages.length === 1);
r = await call('conversation_read', { id: directId, messageId: msg1 }, bob);
check('accusé de lecture', r.data.ok);
r = await call('message_info', { messageId: msg1 }, admin);
check('message info : lu par Bob', r.data.read.some((u) => u.id === bobId));
r = await call('conversations_list', {}, bob);
check('compteur non lus remis à zéro', r.data.unreadTotal === 0);

// 6. Typing
await call('typing', { conversationId: directId, typing: true }, bob);
r = await call('sync', { since: Math.floor(Date.now() / 1000) - 1, conversationId: directId, afterMessageId: 0 }, admin);
check('indicateur de saisie', r.data.typing.some((t) => t.userId === bobId));

// 7. Réponse, édition, réaction, favori
r = await call('message_send', { conversationId: directId, type: 'text', body: 'Ça va ?', replyTo: msg1 }, bob);
check('réponse à un message', r.data.message.replyTo && r.data.message.replyTo.id === msg1);
const msg2 = r.data.message.id;
r = await call('message_edit', { messageId: msg2, body: 'Ça va très bien ?' }, bob);
check('édition message', r.data.message.body === 'Ça va très bien ?' && r.data.message.editedAt > 0);
r = await call('message_react', { messageId: msg1, emoji: '👍' }, bob);
check('réaction', r.data.reactions.length === 1 && r.data.reactions[0].emoji === '👍');
r = await call('message_react', { messageId: msg1, emoji: '👍' }, bob);
check('réaction retirée (toggle)', r.data.reactions.length === 0);
r = await call('message_star', { messageId: msg1, starred: true }, bob);
check('favori', r.data.starred === true);
r = await call('messages_starred', {}, bob);
check('liste des favoris', r.data.messages.some((m) => m.id === msg1));

// Propagation des éditions/réactions via sync
const updatesSince = Math.floor(Date.now() / 1000) - 3;
r = await call('sync', { since: updatesSince, conversationId: directId, afterMessageId: 0, updatesSince }, admin);
check('sync propage éditions et réactions', r.data.updates.some((m) => m.id === msg2 && m.body === 'Ça va très bien ?'));

r = await call('directory', {}, bob);
check('annuaire des membres', r.data.users.length >= 1 && r.data.users.every((u) => u.id !== bobId));

// 8. Images / vocal / fichier
const image = await upload(bob, new Blob([PNG], { type: 'image/png' }), 'photo.png', 'image', { width: 192, height: 192 });
check('upload image', image.id > 0 && image.kind === 'image');
r = await call('message_send', { conversationId: directId, type: 'image', body: 'Ma photo', mediaId: image.id }, bob);
check('envoi image', r.data.message.media && r.data.message.media.id === image.id);
let mediaRes = await fetch(`${API}?action=media_get`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': admin }, body: JSON.stringify({ id: image.id }) });
check('image accessible au destinataire', mediaRes.ok && (await mediaRes.arrayBuffer()).byteLength > 100);
mediaRes = await fetch(`${API}?action=media_get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: image.id }) });
check('image protégée sans session', mediaRes.status === 401);
r = await call('conversation_media', { id: directId }, admin);
check('galerie média de la conversation', r.data.items.some((i) => i.media.id === image.id));

const voice = await upload(bob, wavBlob(), 'vocal.wav', 'voice', { duration: 0.2, waveform: [10, 40, 80, 30] });
check('upload vocal', voice.kind === 'voice' && voice.waveform.length === 4);
r = await call('message_send', { conversationId: directId, type: 'voice', mediaId: voice.id }, bob);
check('envoi vocal', r.data.message.type === 'voice');
const file = await upload(bob, new Blob(['bonjour'], { type: 'text/plain' }), 'note.txt', 'file');
r = await call('message_send', { conversationId: directId, type: 'file', mediaId: file.id }, bob);
check('envoi fichier', r.data.message.media.filename === 'note.txt');

// 9. Groupe
r = await call('conversation_create_group', { name: 'Les amis', description: 'Groupe de test', memberIds: [bobId] }, admin);
check('création groupe', r.data.conversation.type === 'group' && r.data.conversation.memberCount === 2);
const groupId = r.data.conversation.id;
r = await call('message_send', { conversationId: groupId, type: 'text', body: 'Bienvenue !' }, admin);
check('message de groupe', r.data.message.body === 'Bienvenue !');
r = await call('conversation_invite', { id: groupId }, admin);
check('lien d’invitation groupe', r.data.inviteCode && r.data.inviteCode.length >= 8);
const groupCode = r.data.inviteCode;

// 10. Charlie : invitation compte + join groupe
r = await call('invite_create', { email: 'charlie@example.com', maxUses: 1 }, admin);
const inviteCharlie = r.data.invite.code;
r = await call('register', { inviteCode: inviteCharlie, name: 'Charlie Petit', email: 'charlie@example.com', username: 'charlie', password: 'motdepasse3' });
const charlie = r.data.token;
const charlieId = r.data.user.id;
r = await call('invite_info', { code: groupCode }, charlie);
check('invite_info groupe', r.data.invite.kind === 'group' && r.data.invite.groupName === 'Les amis' && r.data.invite.needsAuth === false);
r = await call('conversation_join', { code: groupCode }, charlie);
check('rejoindre un groupe par lien', r.data.conversation.id === groupId && r.data.conversation.memberCount === 3);
r = await call('messages_list', { conversationId: groupId }, charlie);
check('nouveau membre : pas d’historique', !r.data.messages.some((m) => m.body === 'Bienvenue !'));
check('message système d’arrivée', r.data.messages.some((m) => m.type === 'system' && m.body.includes('a rejoint')));

// 11. Droits de groupe
r = await call('conversation_update', { id: groupId, onlyAdminsCanPost: 1 }, admin);
check('restriction aux admins', r.data.conversation.onlyAdminsCanPost === 1);
r = await call('message_send', { conversationId: groupId, type: 'text', body: 'Interdit' }, charlie, 403);
check('membre bloqué par la restriction', r.status === 403);
r = await call('conversation_set_role', { id: groupId, userId: charlieId, role: 'admin' }, admin);
check('promotion administrateur', r.data.ok);
r = await call('message_send', { conversationId: groupId, type: 'text', body: 'Merci !' }, charlie);
check('admin du groupe peut écrire', r.data.ok);
r = await call('conversation_update', { id: groupId, onlyAdminsCanPost: 0, name: 'Les amis (2)' }, admin);
check('renommage groupe', r.data.conversation.title === 'Les amis (2)');
r = await call('conversation_update', { id: groupId, disappearingSeconds: 86400 }, admin);
check('messages éphémères activés', r.data.conversation.disappearingSeconds === 86400);
r = await call('message_send', { conversationId: groupId, type: 'text', body: 'Éphémère' }, admin);
check('message éphémère horodaté', r.data.message.expiresAt > Math.floor(Date.now() / 1000));

// 12. Forward / recherche
r = await call('message_forward', { messageId: msg1, conversationIds: [groupId] }, bob);
check('transfert de message', r.data.messages.length === 1 && r.data.messages[0].forwarded === true);
r = await call('search', { q: 'Salut' }, bob);
check('recherche globale messages', r.data.messages.some((m) => m.body.includes('Salut')));
r = await call('search', { q: 'Les amis' }, bob);
check('recherche globale conversations', r.data.conversations.some((c) => c.id === groupId));
r = await call('search_messages', { q: 'photo', conversationId: directId }, admin);
check('recherche dans une conversation', r.data.messages.every((m) => m.conversationId === directId));

// 13. Mute / pin / archive
r = await call('conversation_mute', { id: directId, until: Math.floor(Date.now() / 1000) + 3600 }, bob);
check('sourdine', r.data.mutedUntil > 0);
r = await call('conversation_pin', { id: directId, pinned: true }, bob);
check('épinglage', r.data.pinned === 1);
r = await call('conversation_archive', { id: directId, archived: true }, bob);
check('archivage', r.data.archived === 1);
r = await call('conversations_list', { includeArchived: false }, bob);
check('archive masquée', !r.data.conversations.some((c) => c.id === directId));
r = await call('conversations_list', {}, bob);
check('archive visible avec option', r.data.conversations.some((c) => c.id === directId));
await call('conversation_archive', { id: directId, archived: false }, bob);

// 14. Profil, confidentialité, blocage
r = await call('profile_update', { bio: 'Toujours partant', phone: '+33 6 12 34 56 78', name: 'Bob D.' }, bob);
check('mise à jour profil', r.data.user.bio === 'Toujours partant' && r.data.user.name === 'Bob D.');
r = await call('profile_update', { privacy: { lastSeen: 'nobody', profilePhoto: 'nobody' } }, bob);
check('confidentialité', r.data.user.privacy.lastSeen === 'nobody');
r = await call('profile_get', { userId: bobId }, admin);
check('last seen masqué', r.data.user.lastSeen === 0 && r.data.user.online === false);
r = await call('profile_update', { privacy: { lastSeen: 'contacts', profilePhoto: 'contacts' } }, bob);
r = await call('profile_get', { userId: bobId }, admin);
check('last seen visible pour un contact', r.data.user.lastSeen > 0);

r = await call('block_user', { userId: adminId }, charlie);
check('blocage', r.data.blocked === true);
r = await call('conversation_create_direct', { userId: adminId }, charlie, 403);
check('blocage empêche la conversation', r.status === 403);
r = await call('unblock_user', { userId: adminId }, charlie);
check('déblocage', r.data.blocked === false);

// 15. Notifications / push
r = await call('profile_update', { notif: { preview: false, groups: false } }, bob);
check('préférences notifications', r.data.user.notif.preview === false && r.data.user.notif.groups === false);
r = await call('push_key');
check('clé VAPID publique', r.data.publicKey && r.data.publicKey.length > 40 && r.data.enabled === true);
r = await call('me', {}, bob);
check('me expose les préférences', r.data.user.notif.messages === true && r.data.user.unreadTotal >= 0);

// 16. Suppression, favoris, info
r = await call('message_delete', { messageId: msg2, forEveryone: true }, bob);
check('suppression pour tous', r.data.ok);
r = await call('messages_list', { conversationId: directId }, admin);
const deleted = r.data.messages.find((m) => m.id === msg2);
check('message supprimé visible comme tel', deleted && deleted.deletedAt > 0 && deleted.body === '');
r = await call('message_delete', { messageId: msg1, forEveryone: false }, bob);
r = await call('messages_list', { conversationId: directId }, bob);
check('suppression pour moi', !r.data.messages.some((m) => m.id === msg1));

// 17. Quitter groupe / réintégrer
r = await call('conversation_leave', { id: groupId }, charlie);
check('quitter le groupe', r.data.ok);
r = await call('conversation_join', { code: groupCode }, charlie);
check('réintégrer le groupe', r.data.conversation.memberCount === 3);
r = await call('conversation_leave', { id: groupId }, charlie);

// 18. Admin
r = await call('admin_users', {}, admin);
check('liste admin', r.data.users.length === 3 && r.data.users.some((u) => u.email === 'charlie@example.com'));
r = await call('admin_stats', {}, admin);
check('statistiques admin', r.data.stats.users === 3 && r.data.stats.messages > 0);
r = await call('admin_users', {}, bob, 403);
check('admin protégé', r.status === 403);
r = await call('admin_user_update', { userId: charlieId, active: false }, admin);
check('désactivation compte', r.data.user.active === false);
r = await call('login', { login: 'charlie', password: 'motdepasse3' }, null, 403);
check('compte désactivé ne peut plus se connecter', r.status === 403);
r = await call('admin_user_update', { userId: charlieId, active: true }, admin);
check('réactivation compte', r.data.user.active === true);

// 19. Invitation révoquée
r = await call('invite_create', { email: 'dave@example.com' }, admin);
const revoked = r.data.invite.code;
await call('invite_revoke', { id: r.data.invite.id }, admin);
r = await call('invite_info', { code: revoked });
check('invitation révoquée', r.data.invite.valid === false);

// 20. Changement de mot de passe
r = await call('password_change', { current: 'motdepasse2', next: 'nouveaupass2' }, bob);
check('changement mot de passe', r.data.ok);
r = await call('login', { login: 'bob', password: 'nouveaupass2' });
check('connexion nouveau mot de passe', r.data.ok);
r = await call('login', { login: 'bob', password: 'motdepasse2' }, null, 401);
check('ancien mot de passe refusé', r.status === 401);

// 21. Logout
r = await call('logout', {}, bob);
check('déconnexion', r.data.ok);
r = await call('me', {}, bob, 401);
check('jeton révoqué', r.status === 401);

console.log(`\n${passed} tests réussis.`);
