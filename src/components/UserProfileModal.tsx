import React, { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import { chatbubbleOutline, copyOutline, banOutline, checkmarkCircle, peopleOutline, settingsOutline } from 'ionicons/icons';
import { accountApi, chatApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { copyText, formatTime, lastSeenLabel } from '../services/utils';
import type { User } from '../types';
import { Avatar, ConfirmDialog, IconButton, Modal, Spinner, Tag } from './ui';

interface CommonGroup {
  id: number;
  title: string;
  avatarId: number | null;
  memberCount: number;
}

export function UserProfileModal({
  userId, open, onClose, onOpenChat,
}: {
  userId: number | null;
  open: boolean;
  onClose: () => void;
  onOpenChat?: (id: number) => void;
}) {
  const { me, toast } = useApp();
  const history = useHistory();
  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<CommonGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !userId) return;
    let alive = true;
    setLoading(true);
    setUser(null);
    accountApi.profileGet(userId)
      .then((res) => {
        if (!alive) return;
        setUser(res.user);
        setGroups((res.groups as CommonGroup[]) || []);
      })
      .catch((e) => { if (alive) toast({ title: 'Profil indisponible', body: e.message, tone: 'error' }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, userId, toast]);

  if (!open || !userId) return null;
  const isSelf = me?.id === userId;

  const openChat = async (directId?: number | null) => {
    if (directId) {
      onClose();
      if (onOpenChat) onOpenChat(directId); else history.push(`/chat/${directId}`);
      return;
    }
    setBusy(true);
    try {
      const res = await chatApi.createDirect(userId);
      onClose();
      if (onOpenChat) onOpenChat(res.conversation.id); else history.push(`/chat/${res.conversation.id}`);
    } catch (e) {
      toast({ title: 'Conversation impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const block = async () => {
    if (!user) return;
    setBusy(true);
    try {
      if (user.blocked) await accountApi.unblock(user.id);
      else await accountApi.block(user.id);
      setUser({ ...user, blocked: !user.blocked });
      toast({ title: user.blocked ? 'Utilisateur débloqué' : 'Utilisateur bloqué', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} className="profile-modal" title="Profil">
        {loading && <div className="center-pad"><Spinner size={28} /></div>}
        {!loading && user && (
          <>
            <div className="profile-hero">
              <Avatar id={user.id} name={user.name} avatarId={user.avatarId} size={92} online={user.online} ring />
              <h2>{user.name}</h2>
              <p className="profile-username">@{user.username}</p>
              <div className="profile-presence">
                {user.online ? <Tag tone="accent">En ligne</Tag> : <span>{user.lastSeen ? `Vu ${lastSeenLabel(user.lastSeen)}` : 'Hors ligne'}</span>}
                {user.role === 'admin' && <Tag>Admin</Tag>}
              </div>
            </div>

            {user.bio && <p className="profile-bio">{user.bio}</p>}

            <div className="profile-facts">
              {user.phone && (
                <div><span>Téléphone</span><strong>{user.phone}</strong></div>
              )}
              <div><span>Membre depuis</span><strong>{user.createdAt ? new Date(user.createdAt * 1000).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : '—'}</strong></div>
              {user.email && <div><span>E-mail</span><strong>{user.email}</strong></div>}
              {user.username && (
                <button type="button" className="profile-copy" onClick={async () => {
                  const ok = await copyText('@' + user.username);
                  toast({ title: ok ? 'Identifiant copié' : 'Copie impossible', tone: ok ? 'success' : 'error' });
                }}>
                  <IonIcon icon={copyOutline} /> Copier l’identifiant
                </button>
              )}
            </div>

            {groups.length > 0 && (
              <div className="profile-groups">
                <h4><IonIcon icon={peopleOutline} /> Groupes en commun</h4>
                {groups.map((g) => (
                  <button key={g.id} type="button" className="mini-row" onClick={() => { onClose(); history.push(`/chat/${g.id}`); }}>
                    <Avatar id={g.id + 3} name={g.title} avatarId={g.avatarId} size={36} group />
                    <span><strong>{g.title}</strong><em>{g.memberCount} membres</em></span>
                  </button>
                ))}
              </div>
            )}

            {(user.blocked || user.blockedBy) && (
              <div className="notice danger">
                {user.blocked
                  ? 'Vous avez bloqué cette personne. Débloquez-la pour reprendre la discussion.'
                  : 'Cette personne vous a bloqué. Vous ne pouvez pas lui écrire.'}
              </div>
            )}

            <div className="profile-actions">
              {isSelf ? (
                <button type="button" className="btn primary block" onClick={() => { onClose(); history.push('/settings'); }}>
                  <IonIcon icon={settingsOutline} /> Modifier mon profil
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn primary block"
                    onClick={() => void openChat(user.directId)}
                    disabled={busy || user.blocked || user.blockedBy}
                  >
                    <IonIcon icon={chatbubbleOutline} /> Envoyer un message
                  </button>
                  <button type="button" className="btn ghost block" onClick={() => setConfirmBlock(true)} disabled={busy}>
                    <IonIcon icon={user.blocked ? checkmarkCircle : banOutline} />
                    {user.blocked ? 'Débloquer' : 'Bloquer'}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </Modal>
      <ConfirmDialog
        open={confirmBlock}
        onClose={() => setConfirmBlock(false)}
        onConfirm={() => void block()}
        title={user?.blocked ? 'Débloquer cette personne ?' : 'Bloquer cette personne ?'}
        message={user?.blocked
          ? 'Vous pourrez à nouveau échanger des messages.'
          : 'Elle ne pourra plus vous écrire en privé ni démarrer une conversation avec vous.'}
        confirmLabel={user?.blocked ? 'Débloquer' : 'Bloquer'}
        danger={!user?.blocked}
      />
    </>
  );
}
