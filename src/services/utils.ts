/** Petites fonctions utilitaires d'affichage (français). */

export function initials(name: string): string {
  const cleaned = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() || name;
  const parts = cleaned.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = [
  ['#12c2a0', '#0e8f9a'],
  ['#6a5cff', '#9a4bff'],
  ['#ff7a59', '#e5484d'],
  ['#2f8df6', '#3ddad7'],
  ['#f4b740', '#ef7b45'],
  ['#ec4899', '#8b5cf6'],
  ['#22c55e', '#14b8a6'],
  ['#f43f5e', '#fb923c'],
];

export function avatarColors(id: number): [string, string] {
  return AVATAR_COLORS[Math.abs(id) % AVATAR_COLORS.length] as [string, string];
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function formatTime(ts: number): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

export function formatDayLabel(ts: number): string {
  const now = Date.now() / 1000;
  if (isSameDay(ts, now)) return "Aujourd'hui";
  if (isSameDay(ts, now - 86400)) return 'Hier';
  const d = new Date(ts * 1000);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  const s = d.toLocaleDateString('fr-FR', opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatListTime(ts: number): string {
  if (!ts) return '';
  const now = Date.now() / 1000;
  if (isSameDay(ts, now)) return formatTime(ts);
  if (isSameDay(ts, now - 86400)) return 'Hier';
  const d = new Date(ts * 1000);
  const diff = now - ts;
  if (diff < 7 * 86400) return d.toLocaleDateString('fr-FR', { weekday: 'short' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: d.getFullYear() !== new Date().getFullYear() ? '2-digit' : undefined });
}

export function lastSeenLabel(ts: number): string {
  if (!ts) return 'Hors ligne';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (isSameDay(ts, Date.now() / 1000)) return `aujourd'hui à ${formatTime(ts)}`;
  if (isSameDay(ts, Date.now() / 1000 - 86400)) return `hier à ${formatTime(ts)}`;
  return `le ${new Date(ts * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} à ${formatTime(ts)}`;
}

export function durationLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fileSize(bytes: number): string {
  if (!bytes) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function nowSeconds(): number {
  return Date.now() / 1000;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n > 1 ? pluralForm || singular + 's' : singular}`;
}

/** Échappe le HTML pour les extraits de recherche (rendus via dangerouslySetInnerHTML). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function highlight(text: string, query: string): string {
  const safe = escapeHtml(text);
  const q = query.trim();
  if (!q) return safe;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

export function previewText(type: string, body: string, deleted = false): string {
  if (deleted) return 'Message supprimé';
  switch (type) {
    case 'image':
      return body ? `📷 ${body}` : '📷 Photo';
    case 'voice':
      return '🎤 Message vocal';
    case 'file':
      return `📎 ${body || 'Fichier'}`;
    case 'system':
      return body;
    default:
      return body;
  }
}

export function linkify(text: string): { type: 'text' | 'link'; value: string }[] {
  const urlRe = /(https?:\/\/[^\s<]+)/gi;
  const out: { type: 'text' | 'link'; value: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text))) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'link', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

export function groupMessagesByDay<T extends { createdAt: number }>(messages: T[]): { day: number; items: T[] }[] {
  const groups: { day: number; items: T[] }[] = [];
  for (const m of messages) {
    const d = new Date(m.createdAt * 1000);
    d.setHours(0, 0, 0, 0);
    const day = d.getTime() / 1000;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(m);
    else groups.push({ day, items: [m] });
  }
  return groups;
}

export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}

export function isMobileViewport(): boolean {
  return window.matchMedia('(max-width: 899px)').matches;
}

/** Joue un petit son de notification (WebAudio, aucun fichier requis). */
export function playNotificationSound(volume = 0.12) {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.24);
    setTimeout(() => void ctx.close(), 400);
  } catch {
    /* silencieux */
  }
}
