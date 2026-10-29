import React, { useEffect, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { documentOutline, imageOutline, micOutline, star, starOutline, timeOutline } from 'ionicons/icons';
import { chatApi, messageApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { durationLabel, fileSize, formatListTime, previewText } from '../services/utils';
import type { Media, Message } from '../types';
import { Avatar, EmptyState, Modal, Spinner } from './ui';
import { ImageViewer } from './media';
import { useMediaUrl } from '../services/media';

export function ConversationMediaModal({
  conversationId, open, onClose,
}: {
  conversationId: number;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useApp();
  const [items, setItems] = useState<{ messageId: number; media: Media; createdAt: number; senderName: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'images' | 'files' | 'voice'>('images');
  const [viewer, setViewer] = useState<Media | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    chatApi.media(conversationId)
      .then((res) => { if (alive) setItems(res.items); })
      .catch((e) => toast({ title: 'Médias indisponibles', body: e.message, tone: 'error' }))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, conversationId, toast]);

  const images = items.filter((i) => i.media.kind === 'image');
  const files = items.filter((i) => i.media.kind === 'file');
  const voices = items.filter((i) => i.media.kind === 'voice');

  return (
    <>
      <Modal open={open} onClose={onClose} title="Médias et documents" wide>
        <div className="tabs">
          <button type="button" className={tab === 'images' ? 'active' : ''} onClick={() => setTab('images')}>
            <IonIcon icon={imageOutline} /> Photos <span>{images.length}</span>
          </button>
          <button type="button" className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            <IonIcon icon={documentOutline} /> Fichiers <span>{files.length}</span>
          </button>
          <button type="button" className={tab === 'voice' ? 'active' : ''} onClick={() => setTab('voice')}>
            <IonIcon icon={micOutline} /> Vocaux <span>{voices.length}</span>
          </button>
        </div>
        {loading && <div className="center-pad"><Spinner /></div>}
        {!loading && tab === 'images' && (
          images.length === 0
            ? <EmptyState icon={<IonIcon icon={imageOutline} />} title="Aucune photo" text="Les photos partagées apparaîtront ici." />
            : (
              <div className="media-grid large">
                {images.map((i) => (
                  <button key={i.messageId} type="button" onClick={() => setViewer(i.media)}>
                    <MediaThumb media={i.media} />
                  </button>
                ))}
              </div>
            )
        )}
        {!loading && tab === 'files' && (
          files.length === 0
            ? <EmptyState icon={<IonIcon icon={documentOutline} />} title="Aucun fichier" />
            : (
              <div className="file-list">
                {files.map((i) => (
                  <div key={i.messageId} className="file-row">
                    <span className="file-icon"><IonIcon icon={documentOutline} /></span>
                    <span><strong>{i.media.filename}</strong><em>{fileSize(i.media.size)} · {i.senderName} · {formatListTime(i.createdAt)}</em></span>
                  </div>
                ))}
              </div>
            )
        )}
        {!loading && tab === 'voice' && (
          voices.length === 0
            ? <EmptyState icon={<IonIcon icon={micOutline} />} title="Aucun vocal" />
            : (
              <div className="file-list">
                {voices.map((i) => (
                  <div key={i.messageId} className="file-row">
                    <span className="file-icon"><IonIcon icon={micOutline} /></span>
                    <span><strong>Message vocal</strong><em>{durationLabel(i.media.duration)} · {i.senderName} · {formatListTime(i.createdAt)}</em></span>
                  </div>
                ))}
              </div>
            )
        )}
      </Modal>
      <ImageViewer media={viewer} open={!!viewer} onClose={() => setViewer(null)} />
    </>
  );
}

function MediaThumb({ media }: { media: Media }) {
  const url = useMediaUrl(media.id);
  return url ? <img src={url} alt="" loading="lazy" /> : <span className="thumb-skeleton"><Spinner size={16} /></span>;
}

export function StarredModal({
  open, onClose, onOpenMessage,
}: {
  open: boolean;
  onClose: () => void;
  onOpenMessage: (conversationId: number, messageId: number) => void;
}) {
  const { toast } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    messageApi.starred()
      .then((res) => { if (alive) setMessages(res.messages); })
      .catch((e) => toast({ title: 'Favoris indisponibles', body: e.message, tone: 'error' }))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, toast]);

  return (
    <Modal open={open} onClose={onClose} title="Messages favoris" wide>
      {loading && <div className="center-pad"><Spinner /></div>}
      {!loading && messages.length === 0 && (
        <EmptyState icon={<IonIcon icon={starOutline} />} title="Aucun favori" text="Appuyez sur ⋯ sur un message puis « Ajouter aux favoris » pour le retrouver ici." />
      )}
      <div className="starred-list">
        {messages.map((m) => (
          <button
            key={m.id}
            type="button"
            className="starred-row"
            onClick={() => { onClose(); onOpenMessage(m.conversationId, m.id); }}
          >
            <Avatar id={m.senderId} name={m.senderName} avatarId={m.senderAvatarId} size={38} />
            <span>
              <strong>{m.conversationTitle || 'Conversation'}</strong>
              <em>{m.senderName} · {previewText(m.type, m.body)}</em>
              <small><IonIcon icon={timeOutline} /> {formatListTime(m.createdAt)}</small>
            </span>
            <IonIcon icon={star} className="meta-icon starred" />
          </button>
        ))}
      </div>
    </Modal>
  );
}
