import React, { useCallback, useEffect, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { addOutline, copyOutline, linkOutline, mailOutline, shareSocialOutline, trashOutline, personAddOutline } from 'ionicons/icons';
import { inviteApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { copyText, formatListTime } from '../services/utils';
import type { Invite } from '../types';
import { ConfirmDialog, Field, Modal, Spinner, Tag } from './ui';

export function inviteLink(code: string): string {
  return `${window.location.origin}${window.location.pathname}#/invite/${code}`;
}

export async function shareInvite(code: string, note = ''): Promise<'shared' | 'copied' | 'failed'> {
  const url = inviteLink(code);
  const text = `Rejoins-moi sur Pulse${note ? ` — ${note}` : ''} : ${url}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Invitation Pulse', text, url });
      return 'shared';
    } catch {
      /* annulé ou non supporté */
    }
  }
  return (await copyText(text)) ? 'copied' : 'failed';
}

export function InviteManager({ showCreate = true }: { showCreate?: boolean }) {
  const { me, toast } = useApp();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [revokeId, setRevokeId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: '', note: '', maxUses: '1', days: '7', role: 'member' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await inviteApi.list();
      setInvites(res.invites);
    } catch (e) {
      toast({ title: 'Invitations indisponibles', body: (e as Error).message, tone: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await inviteApi.create({
        email: form.email.trim(),
        note: form.note.trim(),
        maxUses: Number(form.maxUses) || 1,
        expiresIn: Math.max(1, Number(form.days) || 7) * 86400,
        role: form.role === 'admin' && me?.role === 'admin' ? 'admin' : 'member',
      });
      setOpen(false);
      setForm({ email: '', note: '', maxUses: '1', days: '7', role: 'member' });
      await load();
      const mode = await shareInvite(res.invite.code, res.invite.note);
      toast({
        title: mode === 'shared' ? 'Invitation partagée' : 'Invitation créée',
        body: `Code ${res.invite.code}${mode === 'copied' ? ' — lien copié' : ''}`,
        tone: 'success',
      });
    } catch (err) {
      toast({ title: 'Création impossible', body: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revokeId) return;
    setBusy(true);
    try {
      await inviteApi.revoke(revokeId);
      await load();
      toast({ title: 'Invitation révoquée', tone: 'success' });
    } catch (e) {
      toast({ title: 'Révocation impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
      setRevokeId(null);
    }
  };

  const now = Date.now() / 1000;

  return (
    <div className="invite-manager">
      {showCreate && (
        <button type="button" className="invite-cta" onClick={() => setOpen(true)}>
          <span className="invite-cta-icon"><IonIcon icon={personAddOutline} /></span>
          <span>
            <strong>Inviter quelqu’un</strong>
            <em>Créez un lien d’inscription à usage unique.</em>
          </span>
          <IonIcon icon={addOutline} />
        </button>
      )}

      <div className="invite-list">
        {loading && <div className="center-pad"><Spinner /></div>}
        {!loading && invites.length === 0 && (
          <p className="muted small">Aucune invitation pour l’instant.</p>
        )}
        {invites.map((inv) => {
          const expired = inv.expiresAt > 0 && inv.expiresAt < now;
          const used = inv.uses >= inv.maxUses;
          return (
            <div key={inv.id} className={`invite-row ${used || expired ? 'spent' : ''}`}>
              <span className="invite-icon"><IonIcon icon={linkOutline} /></span>
              <div className="invite-info">
                <strong>Code {inv.code}</strong>
                <span>
                  {inv.email ? `${inv.email} · ` : ''}
                  {inv.note || 'Invitation Pulse'}
                </span>
                <em>
                  {used ? 'Utilisée' : expired ? 'Expirée' : `Expire le ${new Date(inv.expiresAt * 1000).toLocaleDateString('fr-FR')}`}
                  {' · '}{inv.uses}/{inv.maxUses} utilisation{inv.maxUses > 1 ? 's' : ''}
                  {inv.creatorName ? ` · par ${inv.creatorName}` : ''}
                  {' · '}{formatListTime(inv.createdAt)}
                </em>
              </div>
              {!used && !expired && (
                <div className="invite-tools">
                  <button type="button" className="icon-btn soft" title="Copier le lien" onClick={async () => {
                    const ok = await copyText(inviteLink(inv.code));
                    toast({ title: ok ? 'Lien copié' : 'Copie impossible', tone: ok ? 'success' : 'error' });
                  }}>
                    <IonIcon icon={copyOutline} />
                  </button>
                  <button type="button" className="icon-btn soft" title="Partager" onClick={async () => {
                    await shareInvite(inv.code, inv.note);
                  }}>
                    <IonIcon icon={shareSocialOutline} />
                  </button>
                </div>
              )}
              {inv.role === 'admin' && <Tag tone="accent">Admin</Tag>}
              {(me?.role === 'admin' || inv.createdBy === me?.id) && !used && (
                <button type="button" className="icon-btn danger" title="Révoquer" onClick={() => setRevokeId(inv.id)}>
                  <IonIcon icon={trashOutline} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Nouvelle invitation">
        <form onSubmit={submit} className="form-stack">
          <Field label="E-mail (optionnel)" hint="Si renseigné, l’invitation sera réservée à cette adresse.">
            <div className="input-with-icon">
              <IonIcon icon={mailOutline} />
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="prenom@exemple.fr"
                autoComplete="email"
              />
            </div>
          </Field>
          <Field label="Petit mot (optionnel)">
            <input
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Pour rejoindre notre groupe…"
              maxLength={120}
            />
          </Field>
          <div className="form-grid-2">
            <Field label="Utilisations">
              <input type="number" min={1} max={100} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
            </Field>
            <Field label="Validité (jours)">
              <input type="number" min={1} max={60} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
            </Field>
          </div>
          {me?.role === 'admin' && (
            <Field label="Rôle du nouveau compte">
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">Membre</option>
                <option value="admin">Administrateur</option>
              </select>
            </Field>
          )}
          <button type="submit" className="btn primary block" disabled={busy}>
            {busy ? <Spinner size={18} /> : <IonIcon icon={personAddOutline} />}
            Créer et partager
          </button>
        </form>
      </Modal>

      <ConfirmDialog
        open={revokeId !== null}
        onClose={() => setRevokeId(null)}
        onConfirm={() => void revoke()}
        title="Révoquer cette invitation ?"
        message="Le lien ne pourra plus être utilisé pour créer un compte."
        confirmLabel="Révoquer"
        danger
      />
    </div>
  );
}
