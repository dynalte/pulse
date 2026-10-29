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
  const reg = await navigator.serviceWorker.ready;
  return reg;
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

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
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

export async function testPush(): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await pushApi.test();
    if (r.sent > 0) return { ok: true, message: 'Notification de test envoyée.' };
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
