import React, { useEffect, useRef, useState } from 'react';
import { IonIcon } from '@ionic/react';
import {
  cameraOutline, copyOutline, createOutline, exitOutline, linkOutline, notificationsOffOutline,
  peopleOutline, personRemoveOutline, shieldCheckmarkOutline, trashOutline, shareSocialOutline,
  checkmarkOutline, closeOutline, imagesOutline, downloadOutline, personAddOutline, banOutline,
} from 'ionicons/icons';
import { chatApi } from '../services/api';
import { uploadMedia } from '../services/api';
import { useApp } from '../context/AppContext';
import { prepareImage } from '../services/image';
import { copyText, durationLabel, formatDayLabel, lastSeenLabel } from '../services/utils';
import { shareInvite, inviteLink } from './InviteManager';
import { AddMembersModal } from './AddMembersModal';
import { Avatar, ConfirmDialog, IconButton, Modal, Spinner, Tag, Toggle } from './ui';
import { ImageViewer } from './media';
import type { Conversation, ConversationMember, Media } from '../types';

const TTL_OPTIONS = [
  { value: 0, label: 'Désactivés' },
  { value: 86400, label: '24 heures' },
  { value: 604800, label: '7 jours' },
  { value: 7776000, label: '90 jours' },
];

export function GroupInfoModal({
  conversation, open, onClose, onUpdated, onLeft, onOpenUser,
}: {
  conversation: Conversation | null;
  open: boolean;
  onClose: () => void;
  onUpdated: (c: Conversation) => void;
  onLeft: (reason: 'leave' | 'clear' | 'delete') => void;
  onOpenUser: (id: number) => void;
}) {
  const { me, toast } = useApp();
  const [conv, setConv] = useState<Conversation | null>(conversation);
  const [editName, setEditName] = useState(false);
  const [name, setName] = useState('');
  const [editDesc, setEditDesc] = useState(false);
  const [desc, setDesc] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [memberAction, setMemberAction] = useState<ConversationMember | null>(null);
  const [confirm, setConfirm] = useState<'leave' | 'remove' | 'clear' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [media, setMedia] = useState<{ messageId: number; media: Media; createdAt: number; senderName: string }[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [viewer, setViewer] = useState<Media | null>(null);
  const avatarInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setConv(conversation);
    if (conversation) {
      setName(conversation.title);
      setDesc(conversation.description);
    }
  }, [conversation]);

  useEffect(() => {
    if (!open || !conv) return;
    let alive = true;
    setMediaLoading(true);
    chatApi.media(conv.id)
      .then((res) => { if (alive) setMedia(res.items.filter((x) => x.media.kind === 'image')); })
      .catch(() => undefined)
      .finally(() => { if (alive) setMediaLoading(false); });
    return () => { alive = false; };
  }, [open, conv?.id]);

  if (!open || !conv) return null;
  const myRole = conv.myRole;
  const canEdit = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';
  const now = Date.now() / 1000;

  const apply = (c: Conversation) => {
    setConv(c);
    onUpdated(c);
  };

  const saveName = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await chatApi.update(conv.id, { name: name.trim() });
      apply(res.conversation);
      setEditName(false);
      toast({ title: 'Nom du groupe mis à jour', tone: 'success' });
    } catch (e) {
      toast({ title: 'Modification impossible', body: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); }
  };

  const saveDesc = async () => {
    setBusy(true);
    try {
      const res = await chatApi.update(conv.id, { description: desc.trim() });
      apply(res.conversation);
      setEditDesc(false);
      toast({ title: 'Description mise à jour', tone: 'success' });
    } catch (e) {
      toast({ title: 'Modification impossible', body: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); }
  };

  const uploadAvatar = async (file: File) => {
    setBusy(true);
    try {
      const img = await prepareImage(file);
      const res = await uploadMedia(img.blob, 'image', { filename: img.filename, width: img.width, height: img.height });
      const upd = await chatApi.update(conv.id, { avatarId: res.media.id });
      apply(upd.conversation);
      toast({ title: 'Photo du groupe mise à jour', tone: 'success' });
    } catch (e) {
      toast({ title: 'Photo impossible', body: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); }
  };

  const setMute = async (seconds: number) => {
    try {
      const until = seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0;
      const res = await chatApi.mute(conv.id, until);
      apply({ ...conv, mutedUntil: res.mutedUntil });
      toast({ title: seconds > 0 ? 'Notifications coupées' : 'Notifications réactivées', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const setTtl = async (value: number) => {
    try {
      const res = await chatApi.update(conv.id, { disappearingSeconds: value });
      apply(res.conversation);
      toast({ title: 'Messages éphémères mis à jour', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const setOnlyAdmins = async (v: boolean) => {
    try {
      const res = await chatApi.update(conv.id, { onlyAdminsCanPost: v ? 1 : 0 });
      apply(res.conversation);
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const regenerateInvite = async () => {
    try {
      const res = await chatApi.rotateInvite(conv.id);
      apply({ ...conv, inviteCode: res.inviteCode });
      toast({ title: 'Nouveau lien créé', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const toggleRole = async (m: ConversationMember) => {
    try {
      await chatApi.setRole(conv.id, m.id, m.role === 'admin' ? 'member' : 'admin');
      const refreshed = await chatApi.get(conv.id);
      apply(refreshed.conversation);
      toast({ title: m.role === 'admin' ? 'Rôle administrateur retiré' : 'Nommé administrateur', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
    setMemberAction(null);
  };

  const removeMember = async () => {
    if (!memberAction) return;
    setBusy(true);
    try {
      await chatApi.removeMember(conv.id, memberAction.id);
      const refreshed = await chatApi.get(conv.id);
      apply(refreshed.conversation);
      toast({ title: 'Membre retiré du groupe', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
      setMemberAction(null);
      setConfirm(null);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      await chatApi.leave(conv.id);
      toast({ title: 'Vous avez quitté le groupe', tone: 'success' });
      onLeft('leave');
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); setConfirm(null); }
  };

  const clearChat = async () => {
    setBusy(true);
    try {
      await chatApi.clear(conv.id);
      toast({ title: 'Conversation vidée', tone: 'success' });
      onLeft('clear');
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); setConfirm(null); }
  };

  const deleteChat = async () => {
    setBusy(true);
    try {
      await chatApi.remove(conv.id);
      toast({ title: 'Conversation supprimée pour vous', tone: 'success' });
      onLeft('delete');
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); setConfirm(null); }
  };

  const mutedLabel = conv.mutedUntil > now
    ? `Coupées jusqu’au ${new Date(conv.mutedUntil * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`
    : 'Notifications actives';

  return (
    <>
      <Modal open={open} onClose={onClose} title="Infos du groupe" className="group-info" wide>
        <div className="group-hero">
          <button type="button" className="avatar-edit" onClick={() => canEdit && avatarInput.current?.click()} disabled={!canEdit}>
            <Avatar id={conv.id + 3} name={conv.title} avatarId={conv.avatarId} size={96} group />
            {canEdit && <span className="avatar-edit-badge"><IonIcon icon={cameraOutline} /></span>}
          </button>
          <input
            ref={avatarInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); e.target.value = ''; }}
          />
          {editName ? (
            <div className="inline-edit">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
              <IconButton icon={checkmarkOutline} label="Enregistrer" variant="soft" onClick={() => void saveName()} disabled={busy} />
              <IconButton icon={closeOutline} label="Annuler" onClick={() => { setEditName(false); setName(conv.title); }} />
            </div>
          ) : (
            <h2>
              {conv.title}
              {canEdit && <IconButton icon={createOutline} label="Modifier le nom" onClick={() => setEditName(true)} />}
            </h2>
          )}
          <p className="group-sub">
            <IonIcon icon={peopleOutline} /> {conv.memberCount} membres
            {conv.createdAt ? ` · créé le ${formatDayLabel(conv.createdAt)}` : ''}
          </p>
          <div className="group-tags">
            {myRole === 'owner' && <Tag tone="accent">Vous êtes propriétaire</Tag>}
            {myRole === 'admin' && <Tag tone="accent">Administrateur</Tag>}
            {conv.onlyAdminsCanPost === 1 && <Tag>Écriture réservée aux admins</Tag>}
            {conv.disappearingSeconds > 0 && <Tag>Messages éphémères</Tag>}
          </div>
        </div>

        <div className="group-section">
          <div className="section-head">
            <h3>À propos</h3>
            {canEdit && !editDesc && <button type="button" className="text-btn" onClick={() => setEditDesc(true)}>Modifier</button>}
          </div>
          {editDesc ? (
            <div className="inline-edit desc">
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} rows={3} autoFocus />
              <div className="inline-actions">
                <button type="button" className="btn small ghost" onClick={() => { setEditDesc(false); setDesc(conv.description); }}>Annuler</button>
                <button type="button" className="btn small primary" onClick={() => void saveDesc()} disabled={busy}>Enregistrer</button>
              </div>
            </div>
          ) : (
            <p className={conv.description ? 'group-desc' : 'group-desc muted'}>
              {conv.description || 'Aucune description. Ajoutez-en une pour présenter le groupe.'}
            </p>
          )}
        </div>

        <div className="group-section">
          <div className="section-head">
            <h3>Membres <span className="count">{conv.memberCount}</span></h3>
            <button type="button" className="text-btn" onClick={() => setAddOpen(true)}><IonIcon icon={personAddOutline} /> Ajouter</button>
          </div>
          <div className="member-list">
            {conv.members.map((m) => (
              <div key={m.id} className="member-row">
                <button type="button" className="member-main" onClick={() => onOpenUser(m.id)}>
                  <Avatar id={m.id} name={m.name} avatarId={m.avatarId} size={40} online={m.online} />
                  <span>
                    <strong>{m.name}{m.id === me?.id ? ' (vous)' : ''}</strong>
                    <em>@{m.username} · {m.online ? 'en ligne' : lastSeenLabel(m.lastSeen)}</em>
                  </span>
                </button>
                {m.role !== 'member' && <Tag tone="accent">{m.role === 'owner' ? 'Propriétaire' : 'Admin'}</Tag>}
                {(isOwner || (canEdit && m.role === 'member')) && m.id !== me?.id && m.role !== 'owner' && (
                  <IconButton icon={m.role === 'admin' ? shieldCheckmarkOutline : personRemoveOutline} label="Gérer le membre" onClick={() => setMemberAction(m)} />
                )}
              </div>
            ))}
          </div>
        </div>

        {canEdit && (
          <div className="group-section">
            <h3>Lien d’invitation</h3>
            <div className="invite-link-card">
              <code>{conv.inviteCode || 'Aucun lien'}</code>
              <div className="invite-link-actions">
                {conv.inviteCode && (
                  <>
                    <button type="button" className="icon-btn soft" title="Copier" onClick={async () => {
                      const ok = await copyText(inviteLink(conv.inviteCode));
                      toast({ title: ok ? 'Lien copié' : 'Copie impossible', tone: ok ? 'success' : 'error' });
                    }}><IonIcon icon={copyOutline} /></button>
                    <button type="button" className="icon-btn soft" title="Partager" onClick={async () => {
                      await shareInvite(conv.inviteCode, conv.title);
                    }}><IonIcon icon={shareSocialOutline} /></button>
                  </>
                )}
                <button type="button" className="btn small ghost" onClick={() => void regenerateInvite()}>
                  <IonIcon icon={linkOutline} /> {conv.inviteCode ? 'Renouveler' : 'Générer'}
                </button>
              </div>
            </div>
            <p className="muted small">Toute personne disposant de ce lien et d’un compte peut rejoindre le groupe.</p>
          </div>
        )}

        <div className="group-section">
          <h3>Préférences</h3>
          <div className="settings-line">
            <div><strong>Notifications</strong><span>{mutedLabel}</span></div>
            <div className="chip-row">
              <button type="button" className={`chip ${conv.mutedUntil <= now ? 'active' : ''}`} onClick={() => void setMute(0)}>Actives</button>
              <button type="button" className={`chip ${conv.mutedUntil > now ? 'active' : ''}`} onClick={() => void setMute(7 * 86400)}><IonIcon icon={notificationsOffOutline} /> 7 j</button>
            </div>
          </div>
          {canEdit && (
            <>
              <div className="settings-line">
                <div><strong>Messages éphémères</strong><span>Suppression automatique après lecture.</span></div>
                <select value={conv.disappearingSeconds} onChange={(e) => void setTtl(Number(e.target.value))}>
                  {TTL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <Toggle
                checked={conv.onlyAdminsCanPost === 1}
                onChange={(v) => void setOnlyAdmins(v)}
                label="Écriture réservée aux administrateurs"
                description="Les autres membres ne pourront plus envoyer de messages."
              />
            </>
          )}
        </div>

        <div className="group-section">
          <div className="section-head"><h3>Médias partagés</h3><span className="muted small">{media.length}</span></div>
          {mediaLoading && <div className="center-pad"><Spinner /></div>}
          {!mediaLoading && media.length === 0 && <p className="muted small">Aucune photo partagée pour l’instant.</p>}
          {media.length > 0 && (
            <div className="media-grid">
              {media.slice(0, 12).map((item) => (
                <button key={item.messageId} type="button" onClick={() => setViewer(item.media)}>
                  <MediaThumb media={item.media} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="group-section danger-zone">
          <button type="button" className="danger-link" onClick={() => setConfirm('clear')}>
            <IonIcon icon={trashOutline} /> Vider la conversation
          </button>
          <button type="button" className="danger-link" onClick={() => setConfirm('delete')}>
            <IonIcon icon={banOutline} /> Supprimer la conversation pour moi
          </button>
          <button type="button" className="danger-link" onClick={() => setConfirm('leave')}>
            <IonIcon icon={exitOutline} /> Quitter le groupe
          </button>
        </div>
      </Modal>

      <AddMembersModal
        open={addOpen}
        conversationId={conv.id}
        existingIds={conv.members.map((m) => m.id)}
        onClose={() => setAddOpen(false)}
        onAdded={(c) => { apply(c); setAddOpen(false); }}
      />

      <Modal open={!!memberAction} onClose={() => setMemberAction(null)} title={memberAction?.name} className="action-sheet">
        <div className="sheet-actions">
          {isOwner && memberAction && memberAction.role !== 'owner' && (
            <button type="button" className="sheet-action" onClick={() => void toggleRole(memberAction)}>
              <IonIcon icon={shieldCheckmarkOutline} />
              <span>{memberAction.role === 'admin' ? 'Retirer le rôle d’administrateur' : 'Nommer administrateur'}</span>
            </button>
          )}
          {memberAction && memberAction.role !== 'owner' && (
            <button type="button" className="sheet-action danger" onClick={() => setConfirm('remove')}>
              <IonIcon icon={personRemoveOutline} />
              <span>Retirer du groupe</span>
            </button>
          )}
        </div>
        <button type="button" className="sheet-cancel" onClick={() => setMemberAction(null)}>Annuler</button>
      </Modal>

      <ConfirmDialog
        open={confirm === 'leave'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void leave()}
        title="Quitter le groupe ?"
        message={isOwner ? 'Vous êtes propriétaire : le rôle sera transmis à un autre membre.' : 'Vous ne recevrez plus les messages de ce groupe.'}
        confirmLabel="Quitter"
        danger
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        onClose={() => { setConfirm(null); setMemberAction(null); }}
        onConfirm={() => void removeMember()}
        title="Retirer ce membre ?"
        message={`${memberAction?.name || 'Ce membre'} ne pourra plus lire ni envoyer de messages dans ce groupe.`}
        confirmLabel="Retirer"
        danger
      />
      <ConfirmDialog
        open={confirm === 'clear'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void clearChat()}
        title="Vider la conversation ?"
        message="Les messages seront supprimés pour vous uniquement."
        confirmLabel="Vider"
        danger
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void deleteChat()}
        title="Supprimer la conversation ?"
        message="La conversation disparaîtra de votre liste. Elle réapparaîtra si un nouveau message arrive."
        confirmLabel="Supprimer"
        danger
      />

      <ImageViewer media={viewer} open={!!viewer} onClose={() => setViewer(null)} />
    </>
  );
}

function MediaThumb({ media }: { media: Media }) {
  // Réutilise le cache d'objets médias via MediaImage en miniature.
  return <ThumbInner media={media} />;
}

import { useMediaUrl } from '../services/media';
function ThumbInner({ media }: { media: Media }) {
  const url = useMediaUrl(media.id);
  return url ? <img src={url} alt="" loading="lazy" /> : <span className="thumb-skeleton"><Spinner size={16} /></span>;
}
