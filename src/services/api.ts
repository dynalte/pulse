/**
 * Client de l'API PHP. Toutes les actions passent par ?action=… (comme
 * api-liste-courses.php). Auth : header X-Session-Token.
 */
import { settings } from './settings';
import type {
  AdminStats, Conversation, Invite, InviteInfo, Me, Media, MediaKind, Message,
  SearchResults, SyncResponse, User, UserRole, NotifPrefs, PrivacyPrefs,
} from '../types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function baseURL(): string {
  return settings.apiURL;
}

function endpoint(action: string): string {
  const base = baseURL();
  return `${base}${base.includes('?') ? '&' : '?'}action=${encodeURIComponent(action)}`;
}

function friendlyHttpError(status: number, detail: string): string {
  if (status === 401) return 'Session expirée. Veuillez vous reconnecter.';
  if (status === 403) return 'Action non autorisée.';
  if (status === 404) return 'Introuvable.';
  if (status === 413) return 'Fichier trop volumineux.';
  if (status === 429) return 'Trop de tentatives. Réessayez dans un instant.';
  if (status >= 500) return 'Le serveur a rencontré une erreur. Réessayez.';
  return detail || `Erreur HTTP ${status}.`;
}

interface RequestOptions {
  method?: string;
  public?: boolean;
  timeout?: number;
  raw?: boolean;
  body?: unknown;
  formData?: FormData;
}

async function request<T>(action: string, opts: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), opts.timeout ?? 20000);
  try {
    const headers: Record<string, string> = {};
    if (!opts.public && settings.token) headers['X-Session-Token'] = settings.token;
    let body: BodyInit | undefined;
    if (opts.formData) body = opts.formData;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(endpoint(action), {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (opts.raw) {
      if (!res.ok) throw new ApiError(friendlyHttpError(res.status, ''), res.status);
      return (await res.blob()) as unknown as T;
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(res.ok ? 'Réponse serveur illisible.' : `Erreur serveur (${res.status}).`, res.status);
    }
    if (!res.ok || !data || data.ok !== true) {
      const msg = typeof data?.error === 'string' ? data.error : '';
      if (res.status === 401) window.dispatchEvent(new CustomEvent('pulse:unauthorized'));
      throw new ApiError(friendlyHttpError(res.status, msg), res.status);
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === 'AbortError') throw new ApiError('Délai dépassé. Vérifiez votre connexion.', 0);
    throw new ApiError('Impossible de joindre le serveur. Vérifiez l’URL de l’API et votre connexion.', 0);
  } finally {
    window.clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ auth */

export const authApi = {
  bootstrapStatus: () => request<{ needsSetup: boolean; app: string; version: string }>('bootstrap_status', { public: true }),
  bootstrap: (name: string, email: string, username: string, password: string) =>
    request<{ token: string; user: Me }>('bootstrap', { public: true, body: { name, email, username, password } }),
  login: (login: string, password: string) =>
    request<{ token: string; user: Me }>('login', { public: true, body: { login, password } }),
  register: (inviteCode: string, name: string, email: string, username: string, password: string) =>
    request<{ token: string; user: Me }>('register', { public: true, body: { inviteCode, name, email, username, password } }),
  inviteInfo: (code: string) => request<{ invite: InviteInfo }>('invite_info', { public: true, body: { code } }),
  logout: () => request<{ ok: true }>('logout', { body: {} }),
};

/* --------------------------------------------------------------- account */

export const accountApi = {
  me: () => request<{ user: Me }>('me'),
  profileGet: (userId: number) => request<{ user: User; groups: Conversation[] }>('profile_get', { body: { userId } }),
  profileUpdate: (p: {
    name?: string; username?: string; email?: string; bio?: string; phone?: string;
    avatarId?: number | null; notif?: Partial<NotifPrefs>; privacy?: Partial<PrivacyPrefs>;
  }) => request<{ user: Me }>('profile_update', { body: p }),
  searchUsers: (q: string) => request<{ users: User[] }>('user_search', { body: { q } }),
  directory: () => request<{ users: User[] }>('directory', { body: {} }),
  heartbeat: () => request<{ now: number }>('heartbeat', { body: {} }),
  changePassword: (current: string, next: string) =>
    request<{ ok: true }>('password_change', { body: { current, next } }),
  block: (userId: number) => request<{ blocked: boolean }>('block_user', { body: { userId } }),
  unblock: (userId: number) => request<{ blocked: boolean }>('unblock_user', { body: { userId } }),
};

/* ----------------------------------------------------------- conversations */

export interface CreateGroupInput {
  name: string;
  description?: string;
  memberIds: number[];
  avatarId?: number | null;
}

export const chatApi = {
  list: (includeArchived = true) => request<{ conversations: Conversation[]; unreadTotal: number }>('conversations_list', { body: { includeArchived } }),
  get: (id: number) => request<{ conversation: Conversation; members: any[]; pin?: string }>('conversation_get', { body: { id } }),
  createDirect: (userId: number) =>
    request<{ conversation: Conversation }>('conversation_create_direct', { body: { userId } }),
  createGroup: (input: CreateGroupInput) =>
    request<{ conversation: Conversation }>('conversation_create_group', { body: input }),
  update: (id: number, p: { name?: string; description?: string; avatarId?: number | null; disappearingSeconds?: number; onlyAdminsCanPost?: number }) =>
    request<{ conversation: Conversation }>('conversation_update', { body: { id, ...p } }),
  addMembers: (id: number, userIds: number[]) =>
    request<{ conversation: Conversation }>('conversation_add_members', { body: { id, userIds } }),
  removeMember: (id: number, userId: number) =>
    request<{ ok: true }>('conversation_remove_member', { body: { id, userId } }),
  leave: (id: number) => request<{ ok: true }>('conversation_leave', { body: { id } }),
  setRole: (id: number, userId: number, role: 'admin' | 'member') =>
    request<{ ok: true }>('conversation_set_role', { body: { id, userId, role } }),
  mute: (id: number, until: number) => request<{ mutedUntil: number }>('conversation_mute', { body: { id, until } }),
  pin: (id: number, pinned: boolean) => request<{ ok: true }>('conversation_pin', { body: { id, pinned } }),
  archive: (id: number, archived: boolean) => request<{ ok: true }>('conversation_archive', { body: { id, archived } }),
  read: (id: number, messageId: number) => request<{ ok: true }>('conversation_read', { body: { id, messageId } }),
  clear: (id: number) => request<{ ok: true }>('conversation_clear', { body: { id } }),
  remove: (id: number) => request<{ ok: true }>('conversation_delete', { body: { id } }),
  rotateInvite: (id: number) => request<{ inviteCode: string }>('conversation_invite', { body: { id } }),
  resolveInvite: (code: string) => request<{ invite: InviteInfo }>('invite_info', { public: true, body: { code } }),
  joinInvite: (code: string) => request<{ conversation: Conversation }>('conversation_join', { body: { code } }),
  media: (id: number) => request<{ items: { messageId: number; createdAt: number; senderName: string; media: Media }[] }>('conversation_media', { body: { id } }),
};

/* ---------------------------------------------------------------- messages */

export const messageApi = {
  list: (conversationId: number, opts: { before?: number; after?: number; limit?: number; q?: string } = {}) =>
    request<{ messages: Message[]; hasMore: boolean; myLastRead: number; peerReads?: { userId: number; lastReadMessageId: number }[] }>(
      'messages_list',
      { body: { conversationId, ...opts } },
    ),
  send: (p: { conversationId: number; type: string; body?: string; mediaId?: number | null; replyTo?: number | null }) =>
    request<{ message: Message; conversation: Conversation }>('message_send', { body: p, timeout: 30000 }),
  edit: (messageId: number, body: string) => request<{ message: Message }>('message_edit', { body: { messageId, body } }),
  remove: (messageId: number, forEveryone = true) =>
    request<{ ok: true; messageId: number }>('message_delete', { body: { messageId, forEveryone } }),
  forward: (messageId: number, conversationIds: number[]) =>
    request<{ messages: Message[] }>('message_forward', { body: { messageId, conversationIds } }),
  react: (messageId: number, emoji: string) =>
    request<{ messageId: number; reactions: { userId: number; name: string; emoji: string }[] }>('message_react', { body: { messageId, emoji } }),
  star: (messageId: number, starred: boolean) => request<{ ok: true }>('message_star', { body: { messageId, starred } }),
  starred: () => request<{ messages: (Message & { conversationTitle: string })[] }>('messages_starred'),
  info: (messageId: number) =>
    request<{ delivered: { id: number; name: string; at: number }[]; read: { id: number; name: string; at: number }[] }>('message_info', { body: { messageId } }),
  search: (q: string, conversationId?: number) =>
    request<{ messages: (Message & { conversationTitle: string })[] }>('search_messages', { body: { q, conversationId } }),
  searchAll: (q: string) => request<SearchResults>('search', { body: { q } }),
  typing: (conversationId: number, typing: boolean) =>
    request<{ ok: true }>('typing', { body: { conversationId, typing } }),
  sync: (p: { since?: number; conversationId?: number; afterMessageId?: number; updatesSince?: number; presence?: number[] }) =>
    request<SyncResponse>('sync', { body: p, timeout: 15000 }),
};

/* ------------------------------------------------------------------- media */

const mediaCache = new Map<number, Promise<Blob>>();

export function mediaBlob(id: number): Promise<Blob> {
  let p = mediaCache.get(id);
  if (!p) {
    p = request<Blob>('media_get', { body: { id }, raw: true, timeout: 60000 });
    p.catch(() => mediaCache.delete(id));
    mediaCache.set(id, p);
  }
  return p;
}

export function clearMediaCache() {
  mediaCache.clear();
}

export function uploadMedia(
  file: Blob,
  kind: MediaKind,
  extra: { filename?: string; duration?: number; width?: number; height?: number; waveform?: number[] } = {},
): Promise<{ media: Media }> {
  const fd = new FormData();
  fd.append('file', file, extra.filename || (kind === 'image' ? 'photo.jpg' : kind === 'voice' ? 'vocal.webm' : 'fichier'));
  fd.append('kind', kind);
  if (extra.duration) fd.append('duration', String(extra.duration));
  if (extra.width) fd.append('width', String(extra.width));
  if (extra.height) fd.append('height', String(extra.height));
  if (extra.waveform?.length) fd.append('waveform', JSON.stringify(extra.waveform));
  return request<{ media: Media }>('media_upload', { formData: fd, timeout: 120000 });
}

/* -------------------------------------------------------------------- push */

export const pushApi = {
  key: () => request<{ publicKey: string; enabled: boolean }>('push_key', { public: true }),
  subscribe: (subscription: PushSubscriptionJSON, userAgent: string) =>
    request<{ ok: true; devices: number; publicKey?: string }>('push_subscribe', { body: { subscription, userAgent } }),
  unsubscribe: (endpoint: string) => request<{ ok: true }>('push_unsubscribe', { body: { endpoint } }),
  test: () => request<{ ok: boolean; sent: number; error?: string }>('push_test', { body: {}, timeout: 20000 }),
};

/* ---------------------------------------------------------------- invitations */

export const inviteApi = {
  list: () => request<{ invites: Invite[] }>('invites_list'),
  create: (p: { email?: string; note?: string; maxUses?: number; expiresIn?: number; role?: UserRole }) =>
    request<{ invite: Invite; link: string }>('invite_create', { body: p }),
  revoke: (id: number) => request<{ ok: true }>('invite_revoke', { body: { id } }),
};

/* ------------------------------------------------------------------- admin */

export const adminApi = {
  users: (q = '') => request<{ users: User[] }>('admin_users', { body: { q } }),
  updateUser: (userId: number, p: { role?: UserRole; active?: boolean }) =>
    request<{ user: User }>('admin_user_update', { body: { userId, ...p } }),
  stats: () => request<{ stats: AdminStats }>('admin_stats'),
};
