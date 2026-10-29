import React, { useEffect, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { checkmarkDoneOutline, checkmarkOutline, timeOutline } from 'ionicons/icons';
import { messageApi } from '../services/api';
import { useApp } from '../context/AppContext';
import type { Message } from '../types';
import { Modal, Spinner } from './ui';
import { formatTime } from '../services/utils';
import { Avatar } from './ui';

interface InfoUser { id: number; name: string; at: number }

export function MessageInfoModal({ message, open, onClose }: { message: Message | null; open: boolean; onClose: () => void }) {
  const { toast } = useApp();
  const [delivered, setDelivered] = useState<InfoUser[]>([]);
  const [read, setRead] = useState<InfoUser[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !message) return;
    let alive = true;
    setLoading(true);
    messageApi.info(message.id)
      .then((res) => {
        if (!alive) return;
        setDelivered(res.delivered);
        setRead(res.read);
      })
      .catch((e) => toast({ title: 'Informations indisponibles', body: e.message, tone: 'error' }))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, message, toast]);

  return (
    <Modal open={open} onClose={onClose} title="Informations du message">
      {loading && <div className="center-pad"><Spinner /></div>}
      {!loading && (
        <>
          <div className="info-section">
            <h4><IonIcon icon={checkmarkDoneOutline} /> Lu par</h4>
            {read.length === 0 && <p className="muted small">Personne pour l’instant.</p>}
            {read.map((u) => (
              <div key={u.id} className="info-row">
                <Avatar id={u.id} name={u.name} size={34} />
                <span><strong>{u.name}</strong><em>{u.at ? formatTime(u.at) : ''}</em></span>
                <IonIcon icon={checkmarkDoneOutline} className="ticks read" />
              </div>
            ))}
          </div>
          <div className="info-section">
            <h4><IonIcon icon={checkmarkOutline} /> Distribué</h4>
            {delivered.length === 0 && <p className="muted small">Aucune distribution enregistrée.</p>}
            {delivered.map((u) => (
              <div key={u.id} className="info-row">
                <Avatar id={u.id} name={u.name} size={34} />
                <span><strong>{u.name}</strong><em>{u.at ? formatTime(u.at) : ''}</em></span>
                <IonIcon icon={checkmarkOutline} className="ticks" />
              </div>
            ))}
          </div>
          <p className="muted small"><IonIcon icon={timeOutline} /> Les horodatages sont approximatifs.</p>
        </>
      )}
    </Modal>
  );
}
