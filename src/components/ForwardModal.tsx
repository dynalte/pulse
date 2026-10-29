import React, { useMemo, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { checkmarkCircle, ellipseOutline, searchOutline, arrowRedoOutline } from 'ionicons/icons';
import { messageApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { lastSeenLabel } from '../services/utils';
import type { Message } from '../types';
import { Avatar, EmptyState, Modal, Spinner } from './ui';

export function ForwardModal({
  message, open, onClose, onForwarded,
}: {
  message: Message | null;
  open: boolean;
  onClose: () => void;
  onForwarded?: () => void;
}) {
  const { conversations, toast } = useApp();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return conversations
      .filter((c) => !c.archived)
      .filter((c) => !needle || c.title.toLowerCase().includes(needle))
      .slice(0, 80);
  }, [conversations, q]);

  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    if (!message || !selected.length) return;
    setBusy(true);
    try {
      await messageApi.forward(message.id, selected);
      toast({ title: `Message transféré${selected.length > 1 ? ` dans ${selected.length} conversations` : ''}`, tone: 'success' });
      setSelected([]);
      onClose();
      onForwarded?.();
    } catch (e) {
      toast({ title: 'Transfert impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { setSelected([]); onClose(); }}
      title="Transférer le message"
      footer={(
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Annuler</button>
          <button type="button" className="btn primary" disabled={busy || !selected.length} onClick={() => void submit()}>
            {busy ? <Spinner size={18} /> : <IonIcon icon={arrowRedoOutline} />}
            Transférer {selected.length > 0 ? `(${selected.length})` : ''}
          </button>
        </>
      )}
    >
      <div className="search-box">
        <IonIcon icon={searchOutline} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une conversation…" autoFocus />
      </div>
      <div className="picker-list">
        {list.length === 0 && (
          <EmptyState icon={<IonIcon icon={arrowRedoOutline} />} title="Aucune conversation" text="Commencez une discussion avant de transférer un message." />
        )}
        {list.map((c) => {
          const on = selected.includes(c.id);
          return (
            <button key={c.id} type="button" className={`picker-row ${on ? 'selected' : ''}`} onClick={() => toggle(c.id)}>
              <Avatar id={c.id} name={c.title} avatarId={c.avatarId} size={42} group={c.type === 'group'} online={c.type === 'direct' && c.peer?.online} />
              <span className="picker-info">
                <strong>{c.title}</strong>
                <em>{c.type === 'group' ? `${c.memberCount} membres` : c.peer ? (c.peer.online ? 'en ligne' : lastSeenLabel(c.peer.lastSeen)) : 'Discussion'}</em>
              </span>
              <IonIcon icon={on ? checkmarkCircle : ellipseOutline} className={on ? 'check on' : 'check'} />
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
