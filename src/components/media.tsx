import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { downloadOutline, documentOutline, pause, play, closeOutline } from 'ionicons/icons';
import { downloadMediaFile, useMediaUrl } from '../services/media';
import { durationLabel, fileSize } from '../services/utils';
import type { Media } from '../types';
import { IconButton, Modal, Spinner } from './ui';

/* ------------------------------------------------------------------ image */

export function MediaImage({
  media, onOpen, className = '',
}: {
  media: Media;
  onOpen?: () => void;
  className?: string;
}) {
  const url = useMediaUrl(media.id);
  const ratio = media.width && media.height ? media.width / media.height : 4 / 3;
  return (
    <button
      type="button"
      className={`media-image ${className}`}
      onClick={onOpen}
      aria-label="Ouvrir la photo"
      style={{ aspectRatio: `${Math.min(2.2, Math.max(0.65, ratio))}` }}
    >
      {url ? <img src={url} alt="" loading="lazy" /> : <span className="media-skeleton"><Spinner /></span>}
    </button>
  );
}

export function ImageViewer({
  media, open, onClose,
}: {
  media: Media | null;
  open: boolean;
  onClose: () => void;
}) {
  const url = useMediaUrl(media?.id);
  if (!media) return null;
  return (
    <Modal open={open} onClose={onClose} className="image-viewer" sheet={false}>
      <div className="image-viewer-body">
        <div className="image-viewer-bar">
          <span>{media.filename || 'Photo'}</span>
          <div>
            <IconButton
              icon={downloadOutline}
              label="Télécharger"
              onClick={() => void downloadMediaFile(media.id, media.filename || 'photo.jpg')}
            />
            <IconButton icon={closeOutline} label="Fermer" onClick={onClose} />
          </div>
        </div>
        {url ? <img src={url} alt={media.filename} className="image-viewer-img" /> : <Spinner size={34} />}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ voice */

const FALLBACK_BARS = [14, 26, 18, 38, 30, 22, 42, 28, 16, 34, 24, 44, 20, 32, 12, 40, 26, 18, 36, 22, 30, 14, 42, 24, 34, 18, 28, 40, 16, 30, 22, 36];

export function VoicePlayer({
  media, mine = false,
}: {
  media: Media;
  mine?: boolean;
}) {
  const url = useMediaUrl(media.id);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(media.duration || 0);
  const [speed, setSpeed] = useState(1);
  const [failed, setFailed] = useState(false);

  const bars = useMemo(() => {
    if (media.waveform?.length) {
      const w = media.waveform;
      if (w.length >= 32) return w.slice(0, 32);
      return Array.from({ length: 32 }, (_, i) => w[i % w.length]);
    }
    return FALLBACK_BARS;
  }, [media]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = speed;
  }, [speed]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a || !url) return;
    if (a.paused) {
      void a.play().then(() => setPlaying(true)).catch(() => setFailed(true));
    } else {
      a.pause();
      setPlaying(false);
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !total) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * (a.duration || total);
    setCurrent(a.currentTime);
  };

  const progress = total > 0 ? Math.min(1, current / total) : 0;

  return (
    <div className={`voice-player ${mine ? 'mine' : ''}`}>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setTotal(d);
          }}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onEnded={() => { setPlaying(false); setCurrent(0); }}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          onError={() => setFailed(true)}
        />
      )}
      <button type="button" className="voice-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Lire le message vocal'}>
        {!url ? <Spinner size={18} /> : <IonIcon icon={playing ? pause : play} />}
      </button>
      <div className="voice-main">
        <div className="voice-wave" onClick={seek} role="presentation">
          {bars.map((h, i) => (
            <i
              key={i}
              style={{ height: `${Math.max(12, Math.min(100, h))}%` }}
              className={i / bars.length <= progress ? 'played' : ''}
            />
          ))}
        </div>
        <div className="voice-meta">
          <span>{durationLabel(playing || current > 0 ? current : total)}</span>
          {failed && <span className="voice-error">Lecture impossible</span>}
        </div>
      </div>
      <button
        type="button"
        className="voice-speed"
        onClick={() => setSpeed((s) => (s === 1 ? 1.5 : s === 1.5 ? 2 : 1))}
        aria-label="Vitesse de lecture"
      >
        {speed}×
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------- file */

export function FileCard({ media, mine = false }: { media: Media; mine?: boolean }) {
  return (
    <button
      type="button"
      className={`file-card ${mine ? 'mine' : ''}`}
      onClick={() => void downloadMediaFile(media.id, media.filename || 'fichier')}
    >
      <span className="file-icon"><IonIcon icon={documentOutline} /></span>
      <span className="file-info">
        <strong>{media.filename || 'Fichier'}</strong>
        <span>{fileSize(media.size)}</span>
      </span>
      <IonIcon icon={downloadOutline} className="file-dl" />
    </button>
  );
}
