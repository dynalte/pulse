import React, { useEffect, useMemo, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  addOutline, archiveOutline, chatbubbleEllipsesOutline, checkmarkDoneOutline, checkmarkOutline,
  ellipsisVertical, notificationsOffOutline, peopleOutline, pinOutline, searchOutline, trashOutline,
  personAddOutline, closeOutline, arrowForwardOutline, logOutOutline, timeOutline, chatbubblesOutline,
} from 'ionicons/icons';
import { chatApi, messageApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useDebouncedValue } from '../services/hooks';
import {
  formatListTime, lastSeenLabel, previewText,
} from '../services/utils';
import type { Conversation, Message, SearchResults, User, ConversationMember } from '../types';
import {
  ActionSheet, Avatar, Badge, ConfirmDialog, EmptyState, IconButton, Spinner,
} from '../components/ui';
import { UserProfileModal } from '../components/UserProfileModal';
import { draftKey } from '../services/settings';

type Filter = 'all' | 'unread' | 'groups' | 'archived';

function lastTicks(c: Conversation, meId: number): 'read' | 'sent' | null {
  if (!c.lastMessage || c.lastMessage.senderId !== meId) return null;
  const others = c.members.filter((m) => m.id !== meId);
  if (!others.length) return null;
  return others.every((m) => m.lastReadMessageId >= (c.lastMessage?.id || 0)) ? 'read' : 'sent';
}

function conversationPreview(c: Conversation, meId: number): string {
  const m = c.lastMessage;
  if (!m) return c.type === 'group' ? 'Groupe créé' : 'Dites bonjour 👋';
  if (m.deleted) return 'Message supprimé';
  const prefix = m.type === 'system' ? '' : m.senderId === meId ? 'Vous : ' : (c.type === 'group' ? `${m.senderName.split(' ')[0]} : ` : '');
  return prefix + previewText(m.type, m.body, m.deleted);
}

export default function ChatsPage() {
  const {
    me, conversations, unreadTotal, markConversationReadLocal, upsertConversation,
    removeConversation, toast,
  } = useApp();
  const history = useHistory();
  const location = useLocation();
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q, 320);
  const [filter, setFilter] = useState<Filter>('all');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [menuConv, setMenuConv] = useState<Conversation | null>(null);
  const [deleteConv, setDeleteConv] = useState<Conversation | null>(null);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  useEffect(() => {
    const map: Record<number, string> = {};
    for (const c of conversations) {
      try {
        const d = localStorage.getItem(draftKey(c.id));
        if (d) map[c.id] = d;
      } catch { /* ignore */ }
    }
    setDrafts(map);
  }, [conversations]);

  useEffect(() => {
    const needle = debounced.trim();
    if (!needle) {
      setResults(null);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      messageApi.searchAll(needle)
        .then((res) => { if (alive) setResults(res); })
        .catch(() => { if (alive) setResults(null); })
        .finally(() => { if (alive) setSearching(false); });
    }, 120);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [debounced]);

  const archivedCount = conversations.filter((c) => c.archived).length;
  const allCount = conversations.filter((c) => !c.archived).length;
  const unreadCount = conversations.filter((c) => !c.archived && c.unread > 0).length;
  const groupCount = conversations.filter((c) => !c.archived && c.type === 'group').length;

  const list = useMemo(() => {
    const base = conversations.filter((c) => (filter === 'archived' ? c.archived : !c.archived));
    if (filter === 'unread') return base.filter((c) => c.unread > 0);
    if (filter === 'groups') return base.filter((c) => c.type === 'group');
    return base;
  }, [conversations, filter]);

  if (!me) return null;

  const markRead = async (c: Conversation) => {
    if (!c.lastMessage) return;
    markConversationReadLocal(c.id, c.lastMessage.id);
    try {
      await chatApi.read(c.id, c.lastMessage.id);
    } catch { /* ignore */ }
  };

  const togglePin = async (c: Conversation) => {
    try {
      await chatApi.pin(c.id, !c.pinned);
      upsertConversation({ ...c, pinned: c.pinned ? 0 : 1 });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const toggleMute = async (c: Conversation) => {
    try {
      const until = c.mutedUntil > Date.now() / 1000 ? 0 : Math.floor(Date.now() / 1000) + 8 * 3600;
      const res = await chatApi.mute(c.id, until);
      upsertConversation({ ...c, mutedUntil: res.mutedUntil });
      toast({ title: until ? 'Notifications coupées 8 h' : 'Notifications réactivées', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const toggleArchive = async (c: Conversation) => {
    try {
      await chatApi.archive(c.id, !c.archived);
      upsertConversation({ ...c, archived: c.archived ? 0 : 1 });
      toast({ title: c.archived ? 'Conversation désarchivée' : 'Conversation archivée', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const doDelete = async () => {
    if (!deleteConv) return;
    try {
      await chatApi.remove(deleteConv.id);
      removeConversation(deleteConv.id);
      toast({ title: 'Conversation supprimée', tone: 'success' });
    } catch (e) {
      toast({ title: 'Suppression impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setDeleteConv(null);
      setMenuConv(null);
    }
  };

  const openConv = (c: Conversation) => {
    markConversationReadLocal(c.id, c.lastMessage?.id);
    history.push(`/chat/${c.id}`);
  };

  const menuActions = menuConv ? [
    { label: menuConv.unread > 0 ? 'Marquer comme lu' : 'Ouvrir', icon: checkmarkOutline, onClick: () => menuConv.unread > 0 ? void markRead(menuConv) : openConv(menuConv) },
    { label: menuConv.pinned ? 'Désépingler' : 'Épingler', icon: pinOutline, onClick: () => void togglePin(menuConv) },
    { label: menuConv.mutedUntil > Date.now() / 1000 ? 'Réactiver les notifications' : 'Couper les notifications 8 h', icon: notificationsOffOutline, onClick: () => void toggleMute(menuConv) },
    { label: menuConv.archived ? 'Désarchiver' : 'Archiver', icon: archiveOutline, onClick: () => void toggleArchive(menuConv) },
    { label: 'Supprimer la conversation', icon: trashOutline, danger: true, onClick: () => setDeleteConv(menuConv) },
  ] : [];

  const showSearch = q.trim().length > 0;
  const activeId = Number(location.pathname.split('/')[2]) || 0;

  return (
    <div className="list-pane-inner">
      <header className="list-head">
        <div className="list-title">
          <span className="mobile-only brand-lockup">
            <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" className="brand-mini" />
            <strong>Pulse</strong>
          </span>
          <h1 className="desktop-only">Discussions</h1>
          {unreadTotal > 0 && <span className="head-badge">{unreadTotal}</span>}
          <span className="mobile-only head-avatar" onClick={() => history.push('/settings')}>
            <Avatar id={me.id} name={me.name} avatarId={me.avatarId} size={34} />
          </span>
        </div>
        <div className="list-head-actions">
          <IconButton icon={personAddOutline} label="Inviter" onClick={() => history.push('/contacts')} />
          <IconButton icon={addOutline} label="Nouvelle discussion" variant="solid" onClick={() => history.push('/contacts')} />
        </div>
      </header>

      <div className="list-search">
        <IonIcon icon={searchOutline} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher discussions, messages, personnes…"
          aria-label="Rechercher"
        />
        {q && (
          <button type="button" className="clear-btn" onClick={() => setQ('')} aria-label="Effacer">
            <IonIcon icon={closeOutline} />
          </button>
        )}
        {searching && <Spinner size={16} />}
      </div>

      {!showSearch && (
        <div className="filter-chips">
          <button type="button" className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            Toutes <span>{allCount}</span>
          </button>
          <button type="button" className={`chip ${filter === 'unread' ? 'active' : ''}`} onClick={() => setFilter('unread')}>
            Non lues <span>{unreadCount}</span>
          </button>
          <button type="button" className={`chip ${filter === 'groups' ? 'active' : ''}`} onClick={() => setFilter('groups')}>
            Groupes <span>{groupCount}</span>
          </button>
          {archivedCount > 0 && (
            <button type="button" className={`chip ${filter === 'archived' ? 'active' : ''}`} onClick={() => setFilter('archived')}>
              Archivées <span>{archivedCount}</span>
            </button>
          )}
        </div>
      )}

      <div className="conv-list">
        {showSearch && (
          <div className="search-panel">
            {!results && searching && <div className="center-pad"><Spinner /></div>}
            {results && (
              <>
                {results.conversations.length > 0 && (
                  <section>
                    <h4>Discussions</h4>
                    {results.conversations.map((c) => (
                      <button key={c.id} type="button" className="search-result compact" onClick={() => openConv(c)}>
                        <Avatar id={c.id} name={c.title} avatarId={c.avatarId} size={38} group={c.type === 'group'} online={c.peer?.online} />
                        <span><strong>{c.title}</strong><em>{conversationPreview(c, me.id)}</em></span>
                      </button>
                    ))}
                  </section>
                )}
                {results.users.length > 0 && (
                  <section>
                    <h4>Personnes</h4>
                    {results.users.map((u) => (
                      <button key={u.id} type="button" className="search-result compact" onClick={() => setProfileUserId(u.id)}>
                        <Avatar id={u.id} name={u.name} avatarId={u.avatarId} size={38} online={u.online} />
                        <span><strong>{u.name}</strong><em>@{u.username}{u.online ? ' · en ligne' : ` · ${lastSeenLabel(u.lastSeen)}`}</em></span>
                        <IonIcon icon={arrowForwardOutline} className="row-arrow" />
                      </button>
                    ))}
                  </section>
                )}
                {results.messages.length > 0 && (
                  <section>
                    <h4>Messages</h4>
                    {results.messages.map((m) => (
                      <button key={m.id} type="button" className="search-result compact message-result" onClick={() => { history.push(`/chat/${m.conversationId}?m=${m.id}`); setQ(''); }}>
                        <span className="search-msg-icon"><IonIcon icon={chatbubblesOutline} /></span>
                        <span>
                          <strong>{m.conversationTitle}<em>{formatListTime(m.createdAt)}</em></strong>
                          <span>{m.senderName} : {previewText(m.type, m.body)}</span>
                        </span>
                      </button>
                    ))}
                  </section>
                )}
                {results.conversations.length === 0 && results.users.length === 0 && results.messages.length === 0 && (
                  <EmptyState icon={<IonIcon icon={searchOutline} />} title="Aucun résultat" text={`Rien ne correspond à « ${q.trim()} ».`} />
                )}
              </>
            )}
          </div>
        )}

        {!showSearch && list.length === 0 && (
          <EmptyState
            icon={<IonIcon icon={filter === 'archived' ? archiveOutline : chatbubbleEllipsesOutline} />}
            title={filter === 'archived' ? 'Aucune archive' : filter === 'unread' ? 'Tout est lu' : filter === 'groups' ? 'Aucun groupe' : 'Aucune discussion'}
            text={filter === 'all' ? 'Cherchez un membre ou invitez vos proches pour démarrer une conversation.' : 'Changez de filtre pour voir vos autres conversations.'}
            action={filter === 'all' ? (
              <button type="button" className="btn primary" onClick={() => history.push('/contacts')}>
                <IonIcon icon={addOutline} /> Nouvelle discussion
              </button>
            ) : undefined}
          />
        )}

        {!showSearch && list.map((c) => {
          const ticks = lastTicks(c, me.id);
          const draft = drafts[c.id];
          return (
            <div
              key={c.id}
              className={`conv-row ${c.pinned ? 'pinned' : ''} ${c.unread ? 'unread' : ''} ${activeId === c.id ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => openConv(c)}
              onKeyDown={(e) => { if (e.key === 'Enter') openConv(c); }}
              onContextMenu={(e) => { e.preventDefault(); setMenuConv(c); }}
            >
              <Avatar
                id={c.type === 'group' ? c.id + 3 : c.peer?.id || c.id}
                name={c.title}
                avatarId={c.avatarId}
                size={50}
                group={c.type === 'group'}
                online={c.type === 'direct' ? c.peer?.online : undefined}
              />
              <div className="conv-main">
                <div className="conv-line">
                  <strong className="conv-title">
                    {c.title}
                    {c.pinned === 1 && <IonIcon icon={pinOutline} className="conv-pin" />}
                    {c.mutedUntil > Date.now() / 1000 && <IonIcon icon={notificationsOffOutline} className="conv-mute" />}
                  </strong>
                  <time className="conv-time">{formatListTime(c.lastMessage?.createdAt || c.updatedAt)}</time>
                </div>
                <div className="conv-line second">
                  <span className="conv-preview">
                    {c.lastMessage?.senderId === me.id && (
                      <IonIcon
                        icon={ticks === 'read' ? checkmarkDoneOutline : checkmarkOutline}
                        className={`ticks ${ticks === 'read' ? 'read' : ''}`}
                      />
                    )}
                    {draft ? <span className="draft">Brouillon : {draft}</span> : conversationPreview(c, me.id)}
                  </span>
                  {c.unread > 0
                    ? <Badge count={c.unread} muted={c.mutedUntil > Date.now() / 1000} />
                    : <button
                        type="button"
                        className="conv-more"
                        aria-label="Options"
                        onClick={(e) => { e.stopPropagation(); setMenuConv(c); }}
                      ><IonIcon icon={ellipsisVertical} /></button>}
                </div>
              </div>
            </div>
          );
        })}

        {!showSearch && filter !== 'archived' && list.length > 0 && (
          <button type="button" className="list-invite-cta" onClick={() => history.push('/contacts')}>
            <IonIcon icon={personAddOutline} />
            <span><strong>Invitez vos proches</strong><em>Pulse est privé : chaque compte est créé sur invitation.</em></span>
            <IonIcon icon={arrowForwardOutline} />
          </button>
        )}
      </div>

      <ActionSheet
        open={!!menuConv}
        onClose={() => setMenuConv(null)}
        title={menuConv?.title}
        subtitle={menuConv?.type === 'group' ? `${menuConv.memberCount} membres` : menuConv?.peer ? `@${menuConv.peer.username}` : ''}
        actions={menuActions}
      />

      <ConfirmDialog
        open={!!deleteConv}
        onClose={() => { setDeleteConv(null); setMenuConv(null); }}
        onConfirm={() => void doDelete()}
        title="Supprimer la conversation ?"
        message="Elle disparaîtra de votre liste. Elle réapparaîtra si un nouveau message arrive."
        confirmLabel="Supprimer"
        danger
      />

      <UserProfileModal userId={profileUserId} open={!!profileUserId} onClose={() => setProfileUserId(null)} />
    </div>
  );
}
