/**
 * Proposition d'activation des notifications à la première connexion.
 * Affichée une seule fois par compte et par appareil : elle disparaît dès que
 * l'utilisateur active les notifications ou choisit « Plus tard ».
 */
import React, { useCallback, useEffect, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { notificationsOutline } from 'ionicons/icons';
import { useApp } from '../context/AppContext';
import { currentPushEndpoint, enablePush, pushSupported } from '../services/notifications';
import { markNotifPromptSeen, notifPromptSeen } from '../services/settings';
import { Modal, Spinner } from './ui';

export default function NotificationPrompt() {
  const { me, toast, updateNotif, refreshMe } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const userId = me?.id ?? 0;

  useEffect(() => {
    setOpen(false);
    if (!userId) return undefined;
    if (!pushSupported() || !window.isSecureContext) return undefined;
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return undefined;
    if (notifPromptSeen(userId)) return undefined;

    let alive = true;
    let attempts = 0;
    let endpointChecks = 0;
    let timer = 0;

    const check = async () => {
      const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
      if (!alive) return;
      if (!reg) {
        // Premier chargement : le service worker peut être encore en installation.
        if (attempts++ < 4) timer = window.setTimeout(() => void check(), 800);
        return;
      }
      const endpoint = await currentPushEndpoint();
      if (!alive) return;
      if (endpoint) {
        // Déjà abonné sur cet appareil (abonnement automatique de connexion).
        markNotifPromptSeen(userId, 'enabled');
        return;
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return;
      if (endpointChecks++ < 1) {
        // Laisse à l'abonnement automatique de connexion le temps d'aboutir.
        timer = window.setTimeout(() => void check(), 1100);
        return;
      }
      setOpen(true);
    };

    timer = window.setTimeout(() => void check(), 900);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [userId]);

  const later = useCallback(() => {
    if (userId) markNotifPromptSeen(userId, 'later');
    setOpen(false);
  }, [userId]);

  const accept = useCallback(async () => {
    if (!userId) return;
    setBusy(true);
    try {
      const res = await enablePush();
      markNotifPromptSeen(userId, res.ok ? 'enabled' : 'later');
      setOpen(false);
      if (!res.ok) {
        toast({ title: 'Notifications non activées', body: res.reason, tone: 'error' });
        return;
      }
      if (me && !me.notif.enabled) await updateNotif({ enabled: true });
      await refreshMe();
      toast({
        title: 'Notifications activées',
        body: 'Vous recevrez une alerte à chaque nouveau message, même application fermée.',
        tone: 'success',
      });
    } catch (e) {
      markNotifPromptSeen(userId, 'later');
      setOpen(false);
      toast({ title: 'Activation impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }, [userId, me, toast, updateNotif, refreshMe]);

  if (!me) return null;

  return (
    <Modal
      open={open}
      title="Activer les notifications ?"
      onClose={later}
      footer={(
        <>
          <button type="button" className="btn ghost" onClick={later} disabled={busy}>Plus tard</button>
          <button type="button" className="btn primary" onClick={() => void accept()} disabled={busy}>
            {busy ? <Spinner size={18} /> : <IonIcon icon={notificationsOutline} />} Activer
          </button>
        </>
      )}
    >
      <div className="notif-prompt">
        <span className="notif-prompt-icon"><IonIcon icon={notificationsOutline} /></span>
        <p>
          <strong>Ne manquez plus aucun message.</strong>
          {' '}Autorisez Pulse à vous prévenir, même quand l’application est fermée.
        </p>
        <ul>
          <li>Messages privés, groupes et mentions</li>
          <li>Son et badge personnalisables dans les réglages</li>
          <li>Aucune publicité, aucune donnée revendue</li>
        </ul>
        <p className="notif-prompt-foot">
          Vous pourrez modifier ou désactiver ce réglage à tout moment dans
          {' '}<strong>Réglages → Notifications</strong>.
        </p>
      </div>
    </Modal>
  );
}
