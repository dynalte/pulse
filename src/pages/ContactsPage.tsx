import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  addOutline, chatbubbleOutline, chevronForwardOutline, personAddOutline, peopleOutline,
  searchOutline, closeOutline, checkmarkCircle, closeCircle, hourglassOutline,
} from 'ionicons/icons';
import { accountApi, chatApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useDebouncedValue } from '../services/hooks';
import { lastSeenLabel } from '../services/utils';
import type { ContactRequest, User } from '../types';
import { Avatar, EmptyState, Spinner, Tag, Badge } from '../components/ui';
import { UserProfileModal } from '../components/UserProfileModal';
import { InviteManager } from '../components/InviteManager';

type Tab = 'contacts' | 'invites';

export default function ContactsPage() {
  const { me, conversations, toast, refreshMe, contactRequests } = useApp();
  const history = useHistory();
  const [tab, setTab] = useState<Tab>('contacts');
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q, 320);
  const [contacts, setContacts] = useState<User[]>([]);
  const [incoming, setIncoming] = useState<ContactRequest[]>([]);
  const [outgoing, setOutgoing] = useState<ContactRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchResults, setSearchResults] = useState<User[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const [c, r] = await Promise.all([accountApi.contacts(), accountApi.contactRequests()]);
      setContacts(c.users);
      setIncoming(r.incoming);
      setOutgoing(r.outgoing);
    } catch (e) {
      toast({ title: 'Contacts indisponibles', body: (e as Error).message, tone: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (tab === 'contacts') void loadContacts();
  }, [tab, contactRequests, loadContacts]);

  useEffect(() => {
    const needle = debounced.trim();
    if (!needle) {
      setSearchResults(null);
      setSearching(false);
      return undefined;
    }
    let alive = true;
    setSearching(true);
    accountApi.searchUsers(needle)
      .then((res) => { if (alive) setSearchResults(res.users); })
      .catch(() => { if (alive) setSearchResults([]); })
      .finally(() => { if (alive) setSearching(false); });
    return () => { alive = false; };
  }, [debounced]);

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

  const requestContact = async (u: User) => {
    setBusyId(u.id);
    try {
      const res = await accountApi.requestContact(u.id);
      if (res.status === 'accepted') {
        toast({ title: 'Contact ajouté', body: `${u.name} fait maintenant partie de vos contacts.`, tone: 'success' });
      } else {
        toast({ title: 'Demande envoyée', body: `${u.name} doit l’accepter pour devenir contact.`, tone: 'success' });
      }
      setSearchResults((prev) => prev?.map((row) => (
        row.id === u.id
          ? { ...row, contactStatus: res.status === 'accepted' ? 'accepted' : 'pending_out', contactRequestId: res.requestId }
          : row
      )) ?? prev);
      await loadContacts();
      await refreshMe();
    } catch (e) {
      toast({ title: 'Demande impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const acceptRequest = async (req: ContactRequest) => {
    setBusyId(req.user.id);
    try {
      await accountApi.acceptContact(req.id);
      toast({ title: 'Demande acceptée', body: `${req.user.name} est maintenant dans vos contacts.`, tone: 'success' });
      setSearchResults((prev) => prev?.map((row) => (
        row.id === req.user.id ? { ...row, contactStatus: 'accepted', isContact: true, contactRequestId: null } : row
      )) ?? prev);
      await loadContacts();
      await refreshMe();
    } catch (e) {
      toast({ title: 'Acceptation impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const declineRequest = async (req: ContactRequest) => {
    setBusyId(req.user.id);
    try {
      await accountApi.declineContact(req.id);
      setIncoming((prev) => prev.filter((r) => r.id !== req.id));
      setSearchResults((prev) => prev?.map((row) => (
        row.id === req.user.id ? { ...row, contactStatus: 'none', contactRequestId: null } : row
      )) ?? prev);
      await refreshMe();
    } catch (e) {
      toast({ title: 'Refus impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const cancelRequest = async (req: ContactRequest) => {
    setBusyId(req.user.id);
    try {
      await accountApi.cancelContact(req.id);
      setOutgoing((prev) => prev.filter((r) => r.id !== req.id));
      setSearchResults((prev) => prev?.map((row) => (
        row.id === req.user.id ? { ...row, contactStatus: 'none', contactRequestId: null } : row
      )) ?? prev);
      toast({ title: 'Demande annulée', tone: 'success' });
    } catch (e) {
      toast({ title: 'Annulation impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const online = contacts.filter((u) => u.online).length;
  const showSearch = q.trim().length > 0;

  const statusButton = (u: User) => {
    if (u.blocked || u.blockedBy) {
      return <span className="pending-label"><IonIcon icon={closeCircle} /> Indisponible</span>;
    }
    if (u.contactStatus === 'accepted') {
      return (
        <button
          type="button"
          className="btn small soft"
          onClick={() => void startChat(u)}
          disabled={busyId === u.id}
        >
          {busyId === u.id ? <Spinner size={16} /> : <IonIcon icon={chatbubbleOutline} />}
          <span>{u.hasDirect ? 'Ouvrir' : 'Message'}</span>
        </button>
      );
    }
    if (u.contactStatus === 'pending_in' && u.contactRequestId) {
      return (
        <div className="request-actions">
          <button
            type="button"
            className="btn small primary"
            disabled={busyId === u.id}
            onClick={() => void acceptRequest({ id: u.contactRequestId!, createdAt: 0, user: u })}
          >
            <IonIcon icon={checkmarkCircle} /> Accepter
          </button>
          <button
            type="button"
            className="icon-btn soft"
            title="Refuser"
            disabled={busyId === u.id}
            onClick={() => void declineRequest({ id: u.contactRequestId!, createdAt: 0, user: u })}
          >
            <IonIcon icon={closeCircle} />
          </button>
        </div>
      );
    }
    if (u.contactStatus === 'pending_out') {
      return (
        <div className="request-actions">
          <span className="pending-label"><IonIcon icon={hourglassOutline} /> En attente</span>
          {u.contactRequestId && (
            <button
              type="button"
              className="icon-btn soft"
              title="Annuler la demande"
              disabled={busyId === u.id}
              onClick={() => void cancelRequest({ id: u.contactRequestId!, createdAt: 0, user: u })}
            >
              <IonIcon icon={closeCircle} />
            </button>
          )}
        </div>
      );
    }
    return (
      <button
        type="button"
        className="btn small primary"
        onClick={() => void requestContact(u)}
        disabled={busyId === u.id}
      >
        {busyId === u.id ? <Spinner size={16} /> : <IonIcon icon={personAddOutline} />}
        <span>Ajouter</span>
      </button>
    );
  };

  return (
    <div className="page contacts-page">
      <header className="page-head">
        <div>
          <h1>Contacts</h1>
          <p className="page-sub">
            {contacts.length} contact{contacts.length > 1 ? 's' : ''}
            {online > 0 ? ` · ${online} en ligne` : ''}
            {incoming.length > 0 ? ` · ${incoming.length} demande${incoming.length > 1 ? 's' : ''}` : ''}
          </p>
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
        <button type="button" className={tab === 'contacts' ? 'active' : ''} onClick={() => setTab('contacts')}>
          Contacts {incoming.length > 0 && <Badge count={incoming.length} />}
        </button>
        <button type="button" className={tab === 'invites' ? 'active' : ''} onClick={() => setTab('invites')}>Invitations</button>
      </div>

      {tab === 'contacts' && (
        <>
          {groups.length > 0 && !showSearch && (
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
                placeholder="Rechercher un contact ou un membre…"
                autoFocus
              />
              {q && <button type="button" className="clear-btn" onClick={() => setQ('')}><IonIcon icon={closeOutline} /></button>}
              {(loading || searching) && <Spinner size={16} />}
            </div>

            {showSearch ? (
              <>
                {!searching && searchResults && searchResults.length === 0 && (
                  <EmptyState
                    icon={<IonIcon icon={personAddOutline} />}
                    title="Aucun membre trouvé"
                    text="Essayez un autre nom ou identifiant."
                  />
                )}
                <div className="people-list">
                  {(searchResults || []).map((u) => (
                    <div key={u.id} className="person-row">
                      <button type="button" className="person-main" onClick={() => setProfileId(u.id)}>
                        <Avatar id={u.id} name={u.name} avatarId={u.avatarId} size={48} online={u.online} />
                        <span className="person-info">
                          <strong>
                            {u.name}
                            {u.role === 'admin' && <Tag>Admin</Tag>}
                            {u.contactStatus === 'accepted' && <Tag tone="muted">Contact</Tag>}
                          </strong>
                          <em>@{u.username} · {u.contactStatus === 'accepted' ? (u.online ? <span className="online-text">en ligne</span> : lastSeenLabel(u.lastSeen)) : 'membre Pulse'}</em>
                          {u.bio && <span className="person-bio">{u.bio}</span>}
                        </span>
                      </button>
                      <div className="person-actions">
                        {statusButton(u)}
                        <button type="button" className="icon-btn soft" title="Profil" onClick={() => setProfileId(u.id)}>
                          <IonIcon icon={chevronForwardOutline} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                {incoming.length > 0 && (
                  <section className="contact-block">
                    <div className="section-head">
                      <h3>Demandes reçues <Badge count={incoming.length} /></h3>
                    </div>
                    <div className="people-list">
                      {incoming.map((req) => (
                        <div key={req.id} className="person-row request-row">
                          <button type="button" className="person-main" onClick={() => setProfileId(req.user.id)}>
                            <Avatar id={req.user.id} name={req.user.name} avatarId={req.user.avatarId} size={48} online={req.user.online} />
                            <span className="person-info">
                              <strong>{req.user.name}</strong>
                              <em>@{req.user.username} · souhaite vous ajouter en contact</em>
                            </span>
                          </button>
                          <div className="person-actions request-actions">
                            <button
                              type="button"
                              className="btn small primary"
                              disabled={busyId === req.user.id}
                              onClick={() => void acceptRequest(req)}
                            >
                              {busyId === req.user.id ? <Spinner size={16} /> : <IonIcon icon={checkmarkCircle} />}
                              <span>Accepter</span>
                            </button>
                            <button
                              type="button"
                              className="btn small ghost"
                              disabled={busyId === req.user.id}
                              onClick={() => void declineRequest(req)}
                            >
                              Refuser
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {outgoing.length > 0 && (
                  <section className="contact-block">
                    <div className="section-head"><h3>Demandes envoyées</h3></div>
                    <div className="people-list">
                      {outgoing.map((req) => (
                        <div key={req.id} className="person-row request-row">
                          <button type="button" className="person-main" onClick={() => setProfileId(req.user.id)}>
                            <Avatar id={req.user.id} name={req.user.name} avatarId={req.user.avatarId} size={44} />
                            <span className="person-info">
                              <strong>{req.user.name}</strong>
                              <em>@{req.user.username}</em>
                            </span>
                          </button>
                          <div className="person-actions">
                            <span className="pending-label"><IonIcon icon={hourglassOutline} /> En attente</span>
                            <button
                              type="button"
                              className="btn small ghost"
                              disabled={busyId === req.user.id}
                              onClick={() => void cancelRequest(req)}
                            >
                              Annuler
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section className="contact-block">
                  <div className="section-head"><h3>Mes contacts</h3></div>
                  {loading && <div className="center-pad"><Spinner /></div>}
                  {!loading && contacts.length === 0 && (
                    <EmptyState
                      icon={<IonIcon icon={personAddOutline} />}
                      title="Aucun contact pour l’instant"
                      text="Recherchez un membre par son nom ou son @identifiant, puis envoyez-lui une demande de contact."
                    />
                  )}
                  <div className="people-list">
                    {contacts.map((u) => (
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
                </section>
              </>
            )}
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

      <UserProfileModal
        userId={profileId}
        open={!!profileId}
        onClose={() => setProfileId(null)}
        onChanged={() => { void loadContacts(); }}
      />
    </div>
  );
}
