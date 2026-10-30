import React from 'react';
import { IonIcon } from '@ionic/react';
import {
  checkmarkDoneOutline, checkmarkOutline, ellipsisHorizontal, arrowRedoOutline,
  star, starOutline, imageOutline, micOutline, documentOutline, play,
  barChartOutline, locationOutline,
} from 'ionicons/icons';
import type { Conversation, Media, Message } from '../types';
import { avatarColors, formatTime, linkify } from '../services/utils';
import { Avatar } from './ui';
import { FileCard, MediaImage, VoicePlayer } from './media';
import { LocationCard, PollCard } from './MessageExtras';

interface MessageBubbleProps {
  message: Message;
  conversation: Conversation;
  meId: number;
  meUsername?: string;
  showName: boolean;
  showAvatar: boolean;
  contiguous: boolean;
  highlighted?: boolean;
  onAction: (m: Message) => void;
  onReply: (m: Message) => void;
  onReaction: (m: Message, emoji: string) => void;
  onJumpTo: (id: number) => void;
  onOpenImage: (m: Media) => void;
  onVotePoll?: (m: Message, optionIndex: number) => void;
  onStopLocation?: (m: Message) => void;
}

function Mentions({ text, meUsername }: { text: string; meUsername?: string }) {
  const parts = text.split(/(@[a-zA-Z0-9._]{2,24})/g);
  const me = (meUsername || '').toLowerCase();
  return (
    <>
      {parts.map((p, i) => {
        const isMention = p.startsWith('@') && p.length > 1;
        const isMe = isMention && me !== '' && p.slice(1).toLowerCase() === me;
        return isMention
          ? <span key={i} className={`mention ${isMe ? 'mention-me' : ''}`}>{p}</span>
          : <React.Fragment key={i}>{p}</React.Fragment>;
      })}
    </>
  );
}

function RichText({ text, meUsername }: { text: string; meUsername?: string }) {
  return (
    <>
      {linkify(text).map((part, i) => (
        part.type === 'link'
          ? <a key={i} href={part.value} target="_blank" rel="noreferrer noopener">{part.value}</a>
          : <Mentions key={i} text={part.value} meUsername={meUsername} />
      ))}
    </>
  );
}

function Ticks({ message }: { message: Message }) {
  if (!message.mine) return null;
  const others = message.otherCount ?? Math.max(0, message.deliveredCount);
  const read = others > 0 && message.readCount >= others;
  const delivered = others > 0 && message.deliveredCount >= others;
  if (read) return <IonIcon icon={checkmarkDoneOutline} className="ticks read" aria-label="Lu" />;
  return <IonIcon icon={delivered ? checkmarkDoneOutline : checkmarkOutline} className="ticks" aria-label={delivered ? 'Distribué' : 'Envoyé'} />;
}

export function MessageBubble({
  message, conversation, meId, meUsername, showName, showAvatar, contiguous, highlighted,
  onAction, onReply, onReaction, onJumpTo, onOpenImage, onVotePoll, onStopLocation,
}: MessageBubbleProps) {
  if (message.type === 'system') {
    return (
      <div className="system-msg">
        <span>{message.body}</span>
        <time>{formatTime(message.createdAt)}</time>
      </div>
    );
  }

  const mine = message.senderId === meId;
  const [c1, c2] = avatarColors(message.senderId);
  const deleted = message.deletedAt > 0;
  const grouped = new Map<string, { count: number; mine: boolean }>();
  for (const r of message.reactions) {
    const g = grouped.get(r.emoji) || { count: 0, mine: false };
    g.count++;
    if (r.userId === meId) g.mine = true;
    grouped.set(r.emoji, g);
  }

  const meta = (
    <span className="msg-meta">
      {message.forwarded && <IonIcon icon={arrowRedoOutline} className="meta-icon" aria-label="Transféré" />}
      {message.starred && <IonIcon icon={star} className="meta-icon starred" aria-label="Favori" />}
      {message.editedAt > 0 && !deleted && <em>modifié</em>}
      <time>{formatTime(message.createdAt)}</time>
      <Ticks message={message} />
    </span>
  );

  return (
    <div className={`msg-row ${mine ? 'mine' : 'theirs'} ${contiguous ? 'contiguous' : ''} ${highlighted ? 'highlighted' : ''}`}>
      {!mine && (
        <span className="msg-avatar">
          {showAvatar
            ? <Avatar id={message.senderId} name={message.senderName} avatarId={message.senderAvatarId} size={28} />
            : <span style={{ width: 28 }} />}
        </span>
      )}
      <div className="msg-col">
        {showName && !mine && conversation.type === 'group' && (
          <span className="msg-sender" style={{ color: c1 }}>{message.senderName}</span>
        )}
        <div
          className={`bubble ${mine ? 'mine' : 'theirs'} ${deleted ? 'deleted' : ''}`}
          onContextMenu={(e) => { e.preventDefault(); onAction(message); }}
        >
          {message.replyTo && (
            <button
              type="button"
              className="reply-quote"
              onClick={() => onJumpTo(message.replyTo!.id)}
            >
              <span className="reply-bar" />
              <span className="reply-body">
                <strong>{message.replyTo.senderId === meId ? 'Vous' : message.replyTo.senderName}</strong>
                <span>
                  {message.replyTo.deleted ? 'Message supprimé' : (
                    message.replyTo.type === 'image' ? <><IonIcon icon={imageOutline} /> Photo</> :
                    message.replyTo.type === 'voice' ? <><IonIcon icon={micOutline} /> Message vocal</> :
                    message.replyTo.type === 'file' ? <><IonIcon icon={documentOutline} /> Fichier</> :
                    message.replyTo.type === 'poll' ? <><IonIcon icon={barChartOutline} /> Sondage</> :
                    message.replyTo.type === 'location' ? <><IonIcon icon={locationOutline} /> Position</> :
                    message.replyTo.body
                  )}
                </span>
              </span>
            </button>
          )}

          {deleted ? (
            <p className="deleted-text">Message supprimé</p>
          ) : (
            <>
              {message.type === 'image' && message.media && (
                <MediaImage media={message.media} onOpen={() => onOpenImage(message.media!)} />
              )}
              {message.type === 'voice' && message.media && (
                <VoicePlayer media={message.media} mine={mine} />
              )}
              {message.type === 'file' && message.media && (
                <FileCard media={message.media} mine={mine} />
              )}
              {message.type === 'poll' && message.poll && (
                <PollCard
                  poll={message.poll}
                  onVote={(index) => onVotePoll?.(message, index)}
                />
              )}
              {message.type === 'location' && message.location && (
                <LocationCard
                  location={message.location}
                  mine={mine}
                  onStop={() => onStopLocation?.(message)}
                />
              )}
              {message.body && !['file', 'poll', 'location'].includes(message.type) && (
                <p className="bubble-text"><RichText text={message.body} meUsername={meUsername} /></p>
              )}
            </>
          )}

          <span className="bubble-foot">
            {meta}
            {!deleted && (
              <button type="button" className="bubble-more" aria-label="Actions du message" onClick={() => onAction(message)}>
                <IonIcon icon={ellipsisHorizontal} />
              </button>
            )}
          </span>
        </div>

        {grouped.size > 0 && (
          <div className={`reactions ${mine ? 'right' : ''}`}>
            {Array.from(grouped.entries()).map(([emoji, g]) => (
              <button
                key={emoji}
                type="button"
                className={`reaction ${g.mine ? 'mine' : ''}`}
                onClick={() => onReaction(message, emoji)}
                title={g.count > 1 ? `${g.count} réactions` : 'Réaction'}
              >
                <span>{emoji}</span>
                {g.count > 1 && <em>{g.count}</em>}
              </button>
            ))}
          </div>
        )}
      </div>
      {mine && (
        <button type="button" className="quick-reply" aria-label="Répondre" onClick={() => onReply(message)}>
          <IonIcon icon={arrowRedoOutline} />
        </button>
      )}
    </div>
  );
}
