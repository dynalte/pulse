import React, { useEffect, useMemo, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { checkmarkCircle, ellipseOutline, searchOutline, personAddOutline } from 'ionicons/icons';
import { accountApi, chatApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { lastSeenLabel } from '../services/utils';
import type { Conversation, User } from '../types';
import { Avatar, EmptyState, Modal, Spinner } from './ui';

export function AddMembersModal({
  open, conversationId, existingIds, onClose, onAdded,
}: {
  open: boolean;
  conversationId: number;
  existingIds: number[];
  onClose: () => void;
  onAdded: (c: Conversation) => void;
}) {
  const { toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setQ('');
    setLoading(true);
    accountApi.directory()
      .then((res) => setUsers(res.users))
      .catch((e) => toast({ title: 'Annuaire indisponible', body: e.message, tone: 'error' }))
      .finally(() => setLoading(false));
  }, [open, toast]);

  const available = useMemo(() => {
    const set = new Set(existingIds);
    const needle = q.trim().toLowerCase();
    return users
      .filter((u) => !set.has(u.id))
      .filter((u) => !needle || u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle));
  }, [users, existingIds, q]);

  const toggle = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const res = await chatApi.addMembers(conversationId, selected);
      onAdded(res.conversation);
      toast({ title: `${selected.length} membre${selected.length > 1 ? 's' : ''} ajouté${selected.length > 1 ? 's' : ''}`, tone: 'success' });
      onClose();
    } catch (e) {
      toast({ title: 'Ajout impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ajouter des membres"
      footer={(
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Annuler</button>
          <button type="button" className="btn primary" disabled={busy || !selected.length} onClick={() => void submit()}>
            {busy ? <Spinner size={18} /> : <IonIcon icon={personAddOutline} />}
            Ajouter {selected.length > 0 ? `(${selected.length})` : ''}
          </button>
        </>
      )}
    >
      <div className="search-box">
        <IonIcon icon={searchOutline} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un membre…" autoFocus />
      </div>
      <div className="picker-list">
        {loading && <div className="center-pad"><Spinner /></div>}
        {!loading && available.length === 0 && (
          <EmptyState icon={<IonIcon icon={personAddOutline} />} title="Personne à ajouter" text="Tous les membres connus sont déjà dans ce groupe, ou aucun compte ne correspond." />
        )}
        {available.map((u) => {
          const on = selected.includes(u.id);
          return (
            <button key={u.id} type="button" className={`picker-row ${on ? 'selected' : ''}`} onClick={() => toggle(u.id)}>
              <Avatar id={u.id} name={u.name} avatarId={u.avatarId} size={42} online={u.online} />
              <span className="picker-info">
                <strong>{u.name}</strong>
                <em>@{u.username} · {u.online ? 'en ligne' : lastSeenLabel(u.lastSeen)}</em>
              </span>
              <IonIcon icon={on ? checkmarkCircle : ellipseOutline} className={on ? 'check on' : 'check'} />
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
