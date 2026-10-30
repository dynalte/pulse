/**
 * Notifications Web Push (PWA). Le service worker (public/push-sw.js) affiche
 * les notifications reçues même app fermée ; l'API PHP chiffre le payload.
 */
import { pushApi } from './api';

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out as unknown as BufferSource;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  // VitePWA enregistre le SW ; en dev il n'y a pas de SW actif.
  // On borne l'attente : `ready` ne se résout jamais sans enregistrement.
  if (!('serviceWorker' in navigator)) throw new Error('Service worker indisponible sur ce navigateur.');
  let timer = 0;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('Service worker indisponible. Rechargez l’application puis réessayez.')), 5000);
      }),
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

/** Endpoint de l'abonnement push de CE navigateur ('' si aucun). */
export async function currentPushEndpoint(): Promise<string> {
  if (!pushSupported()) return '';
  try {
    const reg = await getRegistration();
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint || '';
  } catch {
    return '';
  }
}

/** Libellé lisible d'un appareil à partir de son User-Agent. */
export function describeDevice(ua: string): string {
  const s = ua || '';
  const platform =
    /iPhone/i.test(s) ? 'iPhone'
    : /iPad/i.test(s) ? 'iPad'
    : /iPod/i.test(s) ? 'iPod'
    : /Android/i.test(s) ? 'Android'
    : /CrOS/i.test(s) ? 'Chromebook'
    : /Macintosh|Mac OS X/i.test(s) ? 'Mac'
    : /Windows/i.test(s) ? 'Windows'
    : /Linux/i.test(s) ? 'Linux'
    : 'Appareil inconnu';
  const browser =
    /Edg\//i.test(s) ? 'Edge'
    : /OPR\//i.test(s) ? 'Opera'
    : /SamsungBrowser/i.test(s) ? 'Samsung Internet'
    : /Firefox|FxiOS/i.test(s) ? 'Firefox'
    : /Chrome|CriOS/i.test(s) ? 'Chrome'
    : /Safari/i.test(s) ? 'Safari'
    : '';
  return browser ? `${platform} · ${browser}` : platform;
}

export interface PushResult {
  ok: boolean;
  reason?: string;
}

export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) {
    return { ok: false, reason: 'Les notifications push ne sont pas disponibles sur ce navigateur. Sur iPhone, installez d’abord l’app sur l’écran d’accueil (iOS 16.4+).' };
  }
  if (!window.isSecureContext) {
    return { ok: false, reason: 'Les notifications nécessitent HTTPS.' };
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'Autorisation refusée. Activez les notifications dans les réglages du navigateur.' };
  }
  const { publicKey, enabled } = await pushApi.key();
  if (!enabled || !publicKey) {
    return { ok: false, reason: 'Le serveur n’a pas encore configuré les clés push (extension OpenSSL requise).' };
  }
  const reg = await getRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON() as PushSubscriptionJSON;
  await pushApi.subscribe(json, navigator.userAgent);
  return { ok: true };
}

export async function disablePush(): Promise<void> {  if (!pushSupported()) return;
  try {
    const reg = await getRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await pushApi.unsubscribe(sub.endpoint).catch(() => undefined);
      await sub.unsubscribe().catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}

export async function testPush(id?: number): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await pushApi.test(id);
    if (r.sent > 0) {
      return { ok: true, message: id ? 'Notification de test envoyée à cet appareil. Si rien ne s’affiche, vérifiez les autorisations du navigateur et du système.' : 'Notification de test envoyée.' };
    }
    return { ok: false, message: r.error || 'Aucun appareil abonné. Activez d’abord les notifications.' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Badge numérique sur l'icône PWA (Chrome/Android/desktop). */
export function setAppBadge(count: number) {
  try {
    const nav = navigator as any;
    if (!nav.setAppBadge) return;
    if (count > 0) void nav.setAppBadge(count);
    else void nav.clearAppBadge();
  } catch {
    /* ignore */
  }
}
