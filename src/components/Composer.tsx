import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IonIcon } from '@ionic/react';
import {
  attachOutline, barChartOutline, clipboardOutline, closeCircle, documentOutline, happyOutline, imageOutline,
  locationOutline, micOutline, send, stopCircleOutline, trashOutline, createOutline,
} from 'ionicons/icons';
import { uploadMedia } from '../services/api';
import { useApp } from '../context/AppContext';
import { localPreview, prepareImage } from '../services/image';
import { VoiceRecorder, recordingSupported } from '../services/voice';
import { draftKey } from '../services/settings';
import { durationLabel, previewText } from '../services/utils';
import type { Conversation, Message, MessageType } from '../types';
import { EmojiPicker } from './EmojiPicker';
import { ActionSheet, IconButton, Spinner } from './ui';
import { useClickOutside } from '../services/hooks';
import { LocationShareModal, PollComposerModal } from './ComposerExtras';

interface SendPayload {
  type: MessageType;
  body?: string;
  mediaId?: number;
  poll?: {
    question: string;
    kind?: 'choice' | 'dates';
    multiple?: boolean;
    options: (string | { text: string; at?: number })[];
  };
  location?: { lat: number; lng: number; accuracy?: number; liveSeconds?: number };
}

interface PendingImage {
  file: File;
  url: string;
}

/** Images présentes dans le presse-papiers (capture d'écran, copie de fichier…). */
function imagesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!files.length) {
    for (const file of Array.from(data.files || [])) {
      if (file.type.startsWith('image/')) files.push(file);
    }
  }
  return files;
}

export function Composer({
  conversation, replyTo, editing, disabledReason, onSend, onTyping, onSent, onCancelContext,
}: {
  conversation: Conversation;
  replyTo: Message | null;
  editing: Message | null;
  disabledReason?: string;
  onSend: (payload: SendPayload) => Promise<boolean>;
  onTyping: (typing: boolean) => void;
  onSent: () => void;
  onCancelContext: () => void;
}) {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [recLevel, setRecLevel] = useState(4);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recTimer = useRef<number | null>(null);
  const typingTimer = useRef<number | null>(null);
  const lastTypingSent = useRef(0);
  const pasteFilesRef = useRef<(files: File[]) => void>(() => {});
  const pendingRef = useRef<PendingImage[]>([]);
  const emojiWrap = useClickOutside<HTMLDivElement>(() => setEmojiOpen(false));
  const disabled = !!disabledReason;
  const keepFocusRef = useRef(false);
  const composerBusy = disabled || sending || !!uploading;

  // Brouillon + édition.
  useEffect(() => {
    const draft = localStorage.getItem(draftKey(conversation.id)) || '';
    setText(draft);
    setPending((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
    setEmojiOpen(false);
    setRecording(false);
    return () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    };
  }, [conversation.id]);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    if (editing) {
      setText(editing.body);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  useEffect(() => {
    try {
      if (text) localStorage.setItem(draftKey(conversation.id), text);
      else localStorage.removeItem(draftKey(conversation.id));
    } catch {
      /* ignore */
    }
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(160, Math.max(24, el.scrollHeight))}px`;
    }
  }, [text, conversation.id]);

  useEffect(() => () => {
    recorderRef.current?.cancel();
    if (recTimer.current) window.clearInterval(recTimer.current);
    pendingRef.current.forEach((p) => URL.revokeObjectURL(p.url));
  }, []);

  // Sur ordinateur (souris), la zone de saisie est désactivée pendant l'envoi,
  // ce qui lui fait perdre le focus : on le rend ensuite pour pouvoir enchaîner.
  useEffect(() => {
    if (composerBusy || !keepFocusRef.current) return;
    keepFocusRef.current = false;
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [composerBusy]);

  const refocusComposer = () => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    // Pas de refocus sur mobile/tactile pour ne pas rouvrir le clavier.
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) keepFocusRef.current = true;
  };

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSent.current > 2200) {
      lastTypingSent.current = now;
      onTyping(true);
    }
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => onTyping(false), 2600);
  }, [onTyping]);

  const doSendText = async () => {
    if (pending.length) {
      await sendPending();
      return;
    }
    const body = text.trim();
    if (!body || sending || disabled) return;
    refocusComposer();
    setSending(true);
    try {
      const ok = await onSend({ type: 'text', body });
      if (ok) {
        setText('');
        onSent();
        onTyping(false);
      }
    } finally {
      setSending(false);
    }
  };

  const sendFile = async (file: File, kind: 'image' | 'file') => {
    if (disabled) return;
    setEmojiOpen(false);
    setUploading(kind === 'image' ? 'Envoi de la photo…' : 'Envoi du fichier…');
    try {
      let mediaId: number;
      if (kind === 'image') {
        const img = await prepareImage(file);
        const res = await uploadMedia(img.blob, 'image', { filename: img.filename, width: img.width, height: img.height });
        mediaId = res.media.id;
      } else {
        const res = await uploadMedia(file, 'file', { filename: file.name });
        mediaId = res.media.id;
      }
      const caption = text.trim();
      const ok = await onSend({ type: kind, mediaId, body: caption || undefined });
      if (ok) {
        setText('');
        onSent();
      }
    } catch (e) {
      toast({ title: 'Envoi impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setUploading(null);
    }
  };

  const addPendingImages = (files: File[]) => {
    if (!files.length || disabled) return;
    if (editing) {
      toast({
        title: 'Modification en cours',
        body: 'Terminez ou annulez la modification avant d’ajouter une capture.',
        tone: 'error',
      });
      return;
    }
    setEmojiOpen(false);
    setPending((prev) => [
      ...prev,
      ...files.map((file) => ({ file, url: localPreview(file) })),
    ]);
  };

  const removePending = (target: PendingImage) => {
    setPending((prev) => {
      const next = prev.filter((p) => p !== target);
      if (next.length !== prev.length) URL.revokeObjectURL(target.url);
      return next;
    });
  };

  const sendPending = async () => {
    if (disabled || sending || uploading || !pending.length) return;
    refocusComposer();
    const images = pending;
    const caption = text.trim();
    setUploading(images.length > 1 ? `Envoi de ${images.length} photos…` : 'Envoi de la photo…');
    let sent = 0;
    try {
      for (const image of images) {
        const img = await prepareImage(image.file);
        const res = await uploadMedia(img.blob, 'image', {
          filename: img.filename,
          width: img.width,
          height: img.height,
        });
        const ok = await onSend({
          type: 'image',
          mediaId: res.media.id,
          body: sent === 0 && caption ? caption : undefined,
        });
        if (!ok) break;
        sent += 1;
      }
    } catch (e) {
      toast({ title: 'Envoi impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      if (sent > 0) {
        const done = images.slice(0, sent);
        done.forEach((p) => URL.revokeObjectURL(p.url));
        setPending((prev) => prev.filter((p) => !done.includes(p)));
        setText('');
        onSent();
      }
      setUploading(null);
    }
  };

  // Une capture collée (Ctrl+V / Maj+Ins) devient une pièce jointe en aperçu :
  // l'utilisateur garde la main pour écrire une légende puis envoyer.
  useEffect(() => {
    pasteFilesRef.current = (files) => addPendingImages(files);
  });

  useEffect(() => {
    if (disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      // Ne pas intercepter un collage destiné à un champ d'une modale ou d'un autre formulaire.
      if (document.querySelector('.modal-backdrop')) return;
      const target = event.target as HTMLElement | null;
      const field = target?.closest?.('input, textarea, [contenteditable="true"]');
      if (field && !field.closest('.composer-wrap')) return;
      const files = imagesFromClipboard(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      pasteFilesRef.current(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [disabled]);

  const pasteFromClipboard = async () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.read !== 'function') {
      toast({
        title: 'Collage indisponible',
        body: 'Utilisez Ctrl+V (ou Maj+Ins) pour coller votre capture.',
        tone: 'error',
      });
      return;
    }
    try {
      const items = await clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png';
        files.push(new File([blob], `capture.${ext}`, { type }));
      }
      if (!files.length) {
        toast({ title: 'Aucune capture', body: 'Le presse-papiers ne contient pas d’image.', tone: 'error' });
        return;
      }
      addPendingImages(files);
    } catch {
      toast({
        title: 'Collage impossible',
        body: 'Autorisez l’accès au presse-papiers, ou utilisez Ctrl+V (Maj+Ins).',
        tone: 'error',
      });
    }
  };

  const sendPoll = async (
    question: string,
    options: (string | { text: string; at?: number })[],
    kind: 'choice' | 'dates',
  ): Promise<boolean> => {
    if (disabled) return false;
    setUploading(kind === 'dates' ? 'Envoi du sondage de dates…' : 'Envoi du sondage…');
    try {
      const ok = await onSend({
        type: 'poll',
        body: question,
        poll: { question, kind, multiple: kind === 'dates', options },
      });
      if (ok) {
        setText('');
        onSent();
      }
      return ok;
    } finally {
      setUploading(null);
    }
  };

  const sendLocation = async (location: { lat: number; lng: number; accuracy: number; liveSeconds: number }): Promise<boolean> => {
    if (disabled) return false;
    setUploading('Partage de la position…');
    try {
      const ok = await onSend({ type: 'location', location });
      if (ok) onSent();
      return ok;
    } finally {
      setUploading(null);
    }
  };

  const startRecording = async () => {
    if (!recordingSupported()) {
      toast({ title: 'Micro indisponible', body: 'Ce navigateur ne prend pas en charge l’enregistrement audio.', tone: 'error' });
      return;
    }
    try {
      const rec = new VoiceRecorder();
      await rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setRecSeconds(0);
      setRecLevel(4);
      setEmojiOpen(false);
      recTimer.current = window.setInterval(() => {
        const elapsed = rec.elapsed();
        setRecSeconds(elapsed);
        setRecLevel(rec.waveformLevel());
        if (elapsed >= 300) void stopAndSendRecording();
      }, 100);
    } catch (e) {
      toast({ title: 'Micro inaccessible', body: (e as Error).message, tone: 'error' });
    }
  };

  const stopAndSendRecording = async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (recTimer.current) window.clearInterval(recTimer.current);
    recTimer.current = null;
    setRecording(false);
    try {
      const result = await rec.stop();
      recorderRef.current = null;
      if (result.duration < 0.7) {
        toast({ title: 'Message trop court', body: 'Maintenez l’enregistrement un peu plus longtemps.', tone: 'error' });
        return;
      }
      setUploading('Envoi du message vocal…');
      const res = await uploadMedia(result.blob, 'voice', {
        filename: result.mime.includes('mp4') ? 'vocal.m4a' : result.mime.includes('ogg') ? 'vocal.ogg' : 'vocal.webm',
        duration: result.duration,
        waveform: result.waveform,
      });
      const ok = await onSend({ type: 'voice', mediaId: res.media.id });
      if (ok) onSent();
    } catch (e) {
      toast({ title: 'Envoi impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setUploading(null);
    }
  };

  const cancelRecording = () => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    if (recTimer.current) window.clearInterval(recTimer.current);
    recTimer.current = null;
    setRecording(false);
    setRecSeconds(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void doSendText();
    }
    if (e.key === 'Escape') onCancelContext();
  };

  const pickEmoji = (emoji: string) => {
    const el = textareaRef.current;
    if (!el) {
      setText((t) => t + emoji);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  if (disabled) {
    return (
      <div className="composer-disabled">
        <IonIcon icon={closeCircle} />
        <span>{disabledReason}</span>
      </div>
    );
  }

  if (recording) {
    return (
      <div className="composer recording">
        <button type="button" className="rec-cancel" onClick={cancelRecording} aria-label="Annuler l’enregistrement">
          <IonIcon icon={trashOutline} />
        </button>
        <span className="rec-dot" />
        <span className="rec-time">{durationLabel(recSeconds)}</span>
        <div className="rec-bars">
          {Array.from({ length: 22 }).map((_, i) => (
            <i key={i} style={{ height: `${Math.max(10, ((recLevel + i * 7) % 90) + 10)}%` }} />
          ))}
        </div>
        <span className="rec-hint">Message vocal</span>
        <button type="button" className="rec-send" onClick={() => void stopAndSendRecording()} aria-label="Envoyer le vocal">
          <IonIcon icon={send} />
        </button>
      </div>
    );
  }

  return (
    <div className="composer-wrap">
      {(replyTo || editing) && (
        <div className={`composer-context ${editing ? 'editing' : ''}`}>
          <span className="context-bar" />
          <div className="context-text">
            <strong>
              {editing ? <><IonIcon icon={createOutline} /> Modification du message</> : `Réponse à ${replyTo?.senderName || ''}`}
            </strong>
            <span>{editing ? editing.body : replyTo ? previewText(replyTo.type, replyTo.body) : ''}</span>
          </div>
          <IconButton icon={closeCircle} label="Annuler" onClick={onCancelContext} />
        </div>
      )}
      {pending.length > 0 && (
        <div className="composer-attachments">
          {pending.map((item) => (
            <div className="composer-attachment" key={item.url}>
              <img src={item.url} alt="Capture collée" />
              <button type="button" onClick={() => removePending(item)} disabled={!!uploading} aria-label="Retirer la capture">
                <IonIcon icon={closeCircle} />
              </button>
            </div>
          ))}
        </div>
      )}
      {uploading && (
        <div className="upload-progress">
          <Spinner size={16} /> {uploading}
        </div>
      )}
      <div className="composer">
        <div className="emoji-anchor" ref={emojiWrap}>
          <IconButton icon={happyOutline} label="Emoji" onClick={() => setEmojiOpen((v) => !v)} active={emojiOpen} />
          {emojiOpen && <EmojiPicker onPick={pickEmoji} onClose={() => setEmojiOpen(false)} />}
        </div>
        <IconButton icon={attachOutline} label="Joindre" onClick={() => setAttachOpen(true)} />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); notifyTyping(); }}
          onKeyDown={onKeyDown}
          placeholder={
            editing
              ? 'Modifier votre message…'
              : pending.length
                ? 'Ajoutez une légende…'
                : 'Écrire un message…'
          }
          rows={1}
          disabled={sending || !!uploading}
        />
        {text.trim() || pending.length ? (
          <button type="button" className="send-btn" onClick={() => void doSendText()} disabled={sending || !!uploading} aria-label="Envoyer">
            {sending || uploading ? <Spinner size={20} /> : <IonIcon icon={send} />}
          </button>
        ) : (
          <button type="button" className="mic-btn" onClick={() => void startRecording()} disabled={sending || !!uploading} aria-label="Enregistrer un message vocal">
            <IonIcon icon={micOutline} />
          </button>
        )}
      </div>

      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void sendFile(f, 'image'); e.target.value = ''; }}
      />
      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void sendFile(f, 'file'); e.target.value = ''; }}
      />

      <ActionSheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        title="Joindre"
        actions={[
          { label: 'Photo', icon: imageOutline, onClick: () => imageInput.current?.click() },
          {
            label: 'Coller une capture',
            icon: clipboardOutline,
            onClick: () => void pasteFromClipboard(),
            hidden: typeof navigator === 'undefined' || typeof navigator.clipboard?.read !== 'function',
          },
          { label: 'Document', icon: documentOutline, onClick: () => fileInput.current?.click() },
          { label: 'Sondage', icon: barChartOutline, onClick: () => setPollOpen(true) },
          { label: 'Position', icon: locationOutline, onClick: () => setLocationOpen(true) },
        ]}
      />

      <PollComposerModal
        open={pollOpen}
        onClose={() => setPollOpen(false)}
        onSubmit={sendPoll}
      />
      <LocationShareModal
        open={locationOpen}
        onClose={() => setLocationOpen(false)}
        onSubmit={sendLocation}
      />
    </div>
  );
}
