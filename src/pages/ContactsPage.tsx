import React, { useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  addOutline, chatbubbleOutline, chevronForwardOutline, personAddOutline, peopleOutline,
  searchOutline, closeOutline, checkmarkCircle,
} from 'ionicons/icons';
import { accountApi, chatApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useDebouncedValue } from '../services/hooks';
import { lastSeenLabel } from '../services/utils';
import type { User } from '../types';
import { Avatar, EmptyState, Spinner, Tag, Segmented } from '../components/ui';
import { UserProfileModal } from '../components/UserProfileModal';
import { InviteManager } from '../components/InviteManager';

export default function ContactsPage() {
  const { me, conversations, toast } = useApp();
  const history = useHistory();
  const [tab, setTab] = useState<'directory' | 'invites'>('directory');
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q, 320);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const req = debounced.trim() ? accountApi.searchUsers(debounced.trim()) : accountApi.directory();
    req
      .then((res) => { if (alive) setUsers(res.users); })
      .catch((e) => { if (alive) toast({ title: 'Annuaire indisponible', body: e.message, tone: 'error' }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [debounced, toast]);

  const groups = useMemo(() => conversations.filter((c) => c.type === 'group' && !c.archived), [conversations]);

  if (!me) return null;

  const startChat = async (u: User) => {
    setBusyId(u.id);
    try {
      if (u.directId) {
        history.push(`/chat/${u.directId}`);
        return;
      }
      const res = await chatApi.createDirect(u.id);
      history.push(`/chat/${res.conversation.id}`);
    } catch (e) {
      toast({ title: 'Conversation impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const online = users.filter((u) => u.online).length;

  return (
    <div className="page contacts-page">
      <header className="page-head">
        <div>
          <h1>Contacts</h1>
          <p className="page-sub">{users.length} membre{users.length > 1 ? 's' : ''}{online > 0 ? ` · ${online} en ligne` : ''}</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="btn ghost small" onClick={() => setTab('invites')}>
            <IonIcon icon={personAddOutline} /> Inviter
          </button>
          <button type="button" className="btn primary small" onClick={() => history.push('/new-group')}>
            <IonIcon icon={peopleOutline} /> Nouveau groupe
          </button>
        </div>
      </header>

      <div className="page-tabs">
        <button type="button" className={tab === 'directory' ? 'active' : ''} onClick={() => setTab('directory')}>Annuaire</button>
        <button type="button" className={tab === 'invites' ? 'active' : ''} onClick={() => setTab('invites')}>Invitations</button>
      </div>

      {tab === 'directory' && (
        <>
          {groups.length > 0 && !q && (
            <section className="page-section">
              <div className="section-head"><h3>Mes groupes</h3></div>
              <div className="group-strip">
                {groups.map((g) => (
                  <button key={g.id} type="button" className="group-card" onClick={() => history.push(`/chat/${g.id}`)}>
                    <Avatar id={g.id + 3} name={g.title} avatarId={g.avatarId} size={46} group />
                    <span><strong>{g.title}</strong><em>{g.memberCount} membres</em></span>
                    <IonIcon icon={chevronForwardOutline} />
                  </button>
                ))}
                <button type="button" className="group-card new" onClick={() => history.push('/new-group')}>
                  <span className="group-card-plus"><IonIcon icon={addOutline} /></span>
                  <span><strong>Créer un groupe</strong><em>Discussion à plusieurs</em></span>
                </button>
              </div>
            </section>
          )}

          <div className="page-section">
            <div className="search-box large">
              <IonIcon icon={searchOutline} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Rechercher un nom, @identifiant…"
                autoFocus
              />
              {q && <button type="button" className="clear-btn" onClick={() => setQ('')}><IonIcon icon={closeOutline} /></button>}
              {loading && <Spinner size={16} />}
            </div>

            {!loading && users.length === 0 && (
              <EmptyState
                icon={<IonIcon icon={personAddOutline} />}
                title={q ? 'Aucun membre trouvé' : 'Aucun autre membre'}
                text={q ? 'Essayez un autre nom ou identifiant.' : 'Invitez vos proches : leur compte sera créé sur invitation.'}
                action={!q ? (
                  <button type="button" className="btn primary" onClick={() => setTab('invites')}>
                    <IonIcon icon={personAddOutline} /> Créer une invitation
                  </button>
                ) : undefined}
              />
            )}

            <div className="people-list">
              {users.map((u) => (
                <div key={u.id} className="person-row">
                  <button type="button" className="person-main" onClick={() => setProfileId(u.id)}>
                    <Avatar id={u.id} name={u.name} avatarId={u.avatarId} size={48} online={u.online} />
                    <span className="person-info">
                      <strong>{u.name}{u.role === 'admin' && <Tag>Admin</Tag>}</strong>
                      <em>@{u.username} · {u.online ? <span className="online-text">en ligne</span> : lastSeenLabel(u.lastSeen)}</em>
                      {u.bio && <span className="person-bio">{u.bio}</span>}
                    </span>
                  </button>
                  <div className="person-actions">
                    <button
                      type="button"
                      className="btn small soft"
                      onClick={() => void startChat(u)}
                      disabled={busyId === u.id || u.blocked || u.blockedBy}
                    >
                      {busyId === u.id ? <Spinner size={16} /> : <IonIcon icon={chatbubbleOutline} />}
                      <span>{u.hasDirect ? 'Ouvrir' : 'Message'}</span>
                    </button>
                    <button type="button" className="icon-btn soft" title="Profil" onClick={() => setProfileId(u.id)}>
                      <IonIcon icon={chevronForwardOutline} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {tab === 'invites' && (
        <div className="page-section invites-section">
          <div className="info-banner">
            <IonIcon icon={checkmarkCircle} />
            <p>
              Pulse est une messagerie privée : le premier compte est administrateur, tous les autres sont créés
              avec un <strong>lien d’invitation</strong>. Un lien peut être à usage unique, nominatif et expirer automatiquement.
            </p>
          </div>
          <InviteManager />
        </div>
      )}

      <UserProfileModal userId={profileId} open={!!profileId} onClose={() => setProfileId(null)} />
    </div>
  );
}
