import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHistory, useLocation, useParams } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  arrowBackOutline, arrowRedoOutline, archiveOutline, banOutline, chatbubbleEllipsesOutline,
  chevronDownOutline, copyOutline, createOutline, ellipsisVertical, exitOutline, imagesOutline,
  informationCircleOutline, notificationsOffOutline, notificationsOutline, pinOutline, searchOutline,
  star as starFilled, starOutline, trashOutline, closeOutline, timeOutline,
} from 'ionicons/icons';
import { accountApi, chatApi, messageApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useDebouncedValue } from '../services/hooks';
import { copyText, formatDayLabel, formatListTime, formatTime, groupMessagesByDay, lastSeenLabel, previewText } from '../services/utils';
import type { Conversation, Media, Message } from '../types';
import { MessageBubble } from '../components/MessageBubble';
import { Composer } from '../components/Composer';
import { EmojiPicker, QUICK_REACTIONS } from '../components/EmojiPicker';
import { GroupInfoModal } from '../components/GroupInfoModal';
import { UserProfileModal } from '../components/UserProfileModal';
import { ForwardModal } from '../components/ForwardModal';
import { MessageInfoModal } from '../components/MessageInfoModal';
import { ConversationMediaModal, StarredModal } from '../components/ChatExtras';
import { ImageViewer } from '../components/media';
import {
  ActionSheet, Avatar, ConfirmDialog, EmptyState, IconButton, Modal, Spinner,
} from '../components/ui';

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const convId = Number(id);
  const history = useHistory();
  const location = useLocation();
  const {
    me, conversations, upsertConversation, applyConversations, markConversationReadLocal,
    setUnreadTotal, setActiveConversation, removeConversation, toast,
  } = useApp();

  const [conversation, setConversation] = useState<Conversation | null>(
    () => conversations.find((c) => c.id === convId) || null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [typing, setTyping] = useState<{ userId: number; name: string; until: number }[]>([]);
  const [presence, setPresence] = useState<Record<number, { lastSeen: number; online: boolean }>>({});
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ message: Message; everyone: boolean } | null>(null);
  const [forwardMessage, setForwardMessage] = useState<Message | null>(null);
  const [infoMessage, setInfoMessage] = useState<Message | null>(null);
  const [imageViewer, setImageViewer] = useState<Media | null>(null);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [starredOpen, setStarredOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'clear' | 'delete' | 'leave' | 'block' | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [firstUnread, setFirstUnread] = useState<number | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [reactionTarget, setReactionTarget] = useState<Message | null>(null);
  const [reactionOpen, setReactionOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(searchQ, 320);
  const conversationRef = useRef<Conversation | null>(conversation);
  const messagesRef = useRef<Message[]>([]);
  const lastMessageIdRef = useRef(0);
  const lastReadSentRef = useRef(0);
  const lastUpdatesRef = useRef(Math.floor(Date.now() / 1000) - 2);
  const convSinceRef = useRef(Math.floor(Date.now() / 1000) - 1);
  const nearBottomRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const initialJumpDone = useRef(false);

  conversationRef.current = conversation;
  messagesRef.current = messages;

  const scrollToBottom = useCallback((smooth = true) => {
    window.setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
    }, 60);
  }, []);

  const markRead = useCallback(async (messageId: number) => {
    if (!messageId || messageId <= lastReadSentRef.current) return;
    lastReadSentRef.current = messageId;
    markConversationReadLocal(convId, messageId);
    try {
      await chatApi.read(convId, messageId);
    } catch {
      /* silencieux */
    }
  }, [convId, markConversationReadLocal]);

  /* ------------------------------------------------------- chargement */
  useEffect(() => {
    if (!me || !convId) return;
    let alive = true;
    setLoading(true);
    setMessages([]);
    setReplyTo(null);
    setEditing(null);
    setSearchOpen(false);
    setFirstUnread(null);
    setShowJump(false);
    lastMessageIdRef.current = 0;
    lastReadSentRef.current = 0;
    lastUpdatesRef.current = Math.floor(Date.now() / 1000) - 2;
    convSinceRef.current = Math.floor(Date.now() / 1000) - 1;
    initialJumpDone.current = false;

    (async () => {
      try {
        const [detail, list] = await Promise.all([
          chatApi.get(convId),
          messageApi.list(convId, { limit: 60 }),
        ]);
        if (!alive) return;
        setConversation(detail.conversation);
        upsertConversation(detail.conversation);
        setMessages(list.messages);
        messagesRef.current = list.messages;
        setHasMore(list.hasMore);
        const maxId = list.messages.length ? list.messages[list.messages.length - 1].id : 0;
        lastMessageIdRef.current = maxId;
        lastReadSentRef.current = list.myLastRead;
        const unread = list.messages.find((m) => m.id > list.myLastRead && m.senderId !== me.id);
        setFirstUnread(unread?.id ?? null);
        nearBottomRef.current = true;
        scrollToBottom(false);
        if (maxId > list.myLastRead) void markRead(maxId);
      } catch (e) {
        if (!alive) return;
        toast({ title: 'Conversation indisponible', body: (e as Error).message, tone: 'error' });
        history.replace('/');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, me?.id]);

  /* ------------------------------------ conversation mise à jour (contexte) */
  useEffect(() => {
    const c = conversations.find((x) => x.id === convId);
    if (c) setConversation(c);
  }, [conversations, convId]);

  /* ---------------------------------------------------- conversation active */
  useEffect(() => {
    setActiveConversation(convId, document.visibilityState === 'visible');
    const onVis = () => setActiveConversation(convId, document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      setActiveConversation(null);
      void messageApi.typing(convId, false).catch(() => undefined);
    };
  }, [convId, setActiveConversation]);

  /* --------------------------------------------------------- fusion messages */
  const mergeIncoming = useCallback((incoming: Message[]) => {
    if (!incoming.length) return;
    const maxIncoming = Math.max(...incoming.map((m) => m.id));
    const wasNear = nearBottomRef.current;
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m);
      const next = Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
      messagesRef.current = next;
      return next;
    });
    if (maxIncoming > lastMessageIdRef.current) {
      lastMessageIdRef.current = maxIncoming;
      if (wasNear) scrollToBottom(true);
      else setShowJump(true);
      if (document.visibilityState === 'visible') void markRead(maxIncoming);
    }
  }, [markRead, scrollToBottom]);

  /* -------------------------------------------------------------- polling */
  const mergeUpdates = useCallback((updates: Message[]) => {
    if (!updates.length) return;
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      let changed = false;
      for (const u of updates) {
        if (!map.has(u.id)) continue;
        map.set(u.id, u);
        changed = true;
      }
      if (!changed) return prev;
      const next = Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!me || !convId) return;
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const presenceIds = (conversationRef.current?.members || []).map((m) => m.id);
        const res = await messageApi.sync({
          since: convSinceRef.current,
          conversationId: convId,
          afterMessageId: lastMessageIdRef.current,
          updatesSince: lastUpdatesRef.current,
          presence: presenceIds,
        });
        if (cancelled) return;
        convSinceRef.current = Math.max(res.now - 1, convSinceRef.current);
        lastUpdatesRef.current = Math.max(res.now - 1, lastUpdatesRef.current);
        if (res.conversations?.length) applyConversations(res.conversations);
        setUnreadTotal(res.me.unreadTotal);
        if (res.messages?.length) mergeIncoming(res.messages);
        if (res.updates?.length) mergeUpdates(res.updates);
        if (res.typing) setTyping(res.typing.filter((t) => t.conversationId === convId && t.until > Date.now() / 1000));
        if (res.presence?.length) {
          setPresence((prev) => {
            const next = { ...prev };
            for (const p of res.presence!) next[p.userId] = { lastSeen: p.lastSeen, online: p.online };
            return next;
          });
        }
        if (res.readStates?.length) {
          setMessages((prev) => prev.map((m) => {
            if (!m.mine) return m;
            const readers = res.readStates!.filter((r) => r.userId !== me.id && r.lastReadMessageId >= m.id).length;
            if (readers === m.readCount) return m;
            return { ...m, readCount: readers, deliveredCount: Math.max(m.deliveredCount, readers) };
          }));
        }
        if (document.visibilityState === 'visible' && lastMessageIdRef.current > lastReadSentRef.current) {
          void markRead(lastMessageIdRef.current);
        }
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 401) {
          history.replace('/');
          return;
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          timer = window.setTimeout(tick, document.visibilityState === 'hidden' ? 15000 : 2500);
        }
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        if (timer) window.clearTimeout(timer);
        timer = undefined;
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [convId, me?.id, applyConversations, setUnreadTotal, mergeIncoming, mergeUpdates, markRead, history]);

  /* ---------------------------------------------------- recherche interne */
  useEffect(() => {
    if (!searchOpen || !debouncedSearch.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    messageApi.search(debouncedSearch.trim(), convId)
      .then((res) => { if (alive) setSearchResults(res.messages); })
      .catch(() => undefined)
      .finally(() => { if (alive) setSearching(false); });
    return () => { alive = false; };
  }, [debouncedSearch, searchOpen, convId]);

  /* --------------------------------------------------------- saut message */
  const jumpTo = useCallback(async (messageId: number) => {
    let exists = messagesRef.current.some((m) => m.id === messageId);
    if (!exists) {
      try {
        const res = await messageApi.list(convId, { before: messageId + 1, limit: 40 });
        setMessages((prev) => {
          const map = new Map(prev.map((m) => [m.id, m]));
          for (const m of res.messages) map.set(m.id, m);
          const next = Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
          messagesRef.current = next;
          return next;
        });
        setHasMore(res.hasMore);
        exists = res.messages.some((m) => m.id === messageId);
      } catch {
        /* ignore */
      }
    }
    if (!exists) {
      toast({ title: 'Message introuvable', tone: 'error' });
      return;
    }
    setSearchOpen(false);
    setHighlight(messageId);
    window.setTimeout(() => {
      document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    window.setTimeout(() => setHighlight(null), 2800);
  }, [convId, toast]);

  useEffect(() => {
    if (loading || initialJumpDone.current) return;
    const raw = new URLSearchParams(location.search).get('m');
    const target = raw ? Number(raw) : 0;
    initialJumpDone.current = true;
    if (target > 0) {
      void jumpTo(target);
      history.replace(`/chat/${convId}`);
    }
  }, [loading, location.search, convId, jumpTo, history]);

  /* ---------------------------------------------------------- envoi message */
  const handleSend = useCallback(async (payload: { type: string; body?: string; mediaId?: number }) => {
    if (!conversation) return false;
    try {
      if (editing) {
        if (payload.type !== 'text' || !payload.body) return false;
        const res = await messageApi.edit(editing.id, payload.body);
        setMessages((prev) => prev.map((m) => (m.id === res.message.id ? { ...m, ...res.message } : m)));
        if (conversation.lastMessage?.id === editing.id) {
          upsertConversation({ ...conversation, lastMessage: { ...conversation.lastMessage, body: res.message.body } });
        }
        setEditing(null);
        toast({ title: 'Message modifié', tone: 'success' });
        return true;
      }
      const res = await messageApi.send({
        conversationId: convId,
        type: payload.type,
        body: payload.body,
        mediaId: payload.mediaId ?? null,
        replyTo: replyTo?.id ?? null,
      });
      setMessages((prev) => {
        if (prev.some((m) => m.id === res.message.id)) return prev;
        const next = [...prev, res.message];
        messagesRef.current = next;
        return next;
      });
      lastMessageIdRef.current = Math.max(lastMessageIdRef.current, res.message.id);
      upsertConversation(res.conversation);
      setReplyTo(null);
      nearBottomRef.current = true;
      scrollToBottom(true);
      return true;
    } catch (e) {
      toast({ title: 'Envoi impossible', body: (e as Error).message, tone: 'error' });
      return false;
    }
  }, [conversation, editing, convId, replyTo, upsertConversation, toast, scrollToBottom]);

  const handleTyping = useCallback((isTyping: boolean) => {
    void messageApi.typing(convId, isTyping).catch(() => undefined);
  }, [convId]);

  /* -------------------------------------------------------------- actions */
  const react = async (message: Message, emoji: string) => {
    try {
      const res = await messageApi.react(message.id, emoji);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, reactions: res.reactions as Message['reactions'] } : m)));
    } catch (e) {
      toast({ title: 'Réaction impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const star = async (message: Message) => {
    try {
      await messageApi.star(message.id, !message.starred);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, starred: !m.starred } : m)));
      toast({ title: message.starred ? 'Retiré des favoris' : 'Ajouté aux favoris', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    const { message, everyone } = deleteTarget;
    try {
      await messageApi.remove(message.id, everyone);
      if (everyone) {
        setMessages((prev) => prev.map((m) => (
          m.id === message.id ? { ...m, deletedAt: Date.now() / 1000, body: '', media: null, reactions: [], replyTo: m.replyTo } : m
        )));
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== message.id));
      }
      const refreshed = await chatApi.get(convId);
      setConversation(refreshed.conversation);
      upsertConversation(refreshed.conversation);
      toast({ title: everyone ? 'Message supprimé pour tous' : 'Message supprimé pour vous', tone: 'success' });
    } catch (e) {
      toast({ title: 'Suppression impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setDeleteTarget(null);
      setActionMessage(null);
    }
  };

  const toggleMute = async (seconds: number) => {
    try {
      const until = seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0;
      const res = await chatApi.mute(convId, until);
      if (conversation) {
        const updated = { ...conversation, mutedUntil: res.mutedUntil };
        setConversation(updated);
        upsertConversation(updated);
      }
      toast({ title: seconds > 0 ? 'Notifications coupées' : 'Notifications réactivées', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const togglePin = async () => {
    if (!conversation) return;
    try {
      await chatApi.pin(convId, !conversation.pinned);
      const updated = { ...conversation, pinned: conversation.pinned ? 0 : 1 };
      setConversation(updated);
      upsertConversation(updated);
      toast({ title: updated.pinned ? 'Conversation épinglée' : 'Conversation désépinglée', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const archive = async () => {
    if (!conversation) return;
    try {
      await chatApi.archive(convId, !conversation.archived);
      const updated = { ...conversation, archived: conversation.archived ? 0 : 1 };
      upsertConversation(updated);
      toast({ title: updated.archived ? 'Conversation archivée' : 'Conversation désarchivée', tone: 'success' });
      if (updated.archived) history.push('/');
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const clearChat = async () => {
    try {
      await chatApi.clear(convId);
      setMessages([]);
      messagesRef.current = [];
      lastMessageIdRef.current = 0;
      const refreshed = await chatApi.get(convId);
      setConversation(refreshed.conversation);
      upsertConversation(refreshed.conversation);
      toast({ title: 'Conversation vidée', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setConfirmAction(null);
    }
  };

  const deleteChat = async () => {
    try {
      await chatApi.remove(convId);
      removeConversation(convId);
      history.replace('/');
      toast({ title: 'Conversation supprimée', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setConfirmAction(null);
    }
  };

  const leaveGroup = async () => {
    try {
      await chatApi.leave(convId);
      removeConversation(convId);
      history.replace('/');
      toast({ title: 'Vous avez quitté le groupe', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setConfirmAction(null);
    }
  };

  const blockPeer = async () => {
    const peer = conversation?.peer;
    if (!peer) return;
    try {
      await accountApi.block(peer.id);
      const refreshed = await chatApi.get(convId);
      setConversation(refreshed.conversation);
      upsertConversation(refreshed.conversation);
      toast({ title: 'Utilisateur bloqué', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setConfirmAction(null);
    }
  };

  const copyMessage = async (m: Message) => {
    const ok = await copyText(m.body);
    toast({ title: ok ? 'Message copié' : 'Copie impossible', tone: ok ? 'success' : 'error' });
  };

  const loadOlder = async () => {
    if (!hasMore || loadingOlder || !messages.length) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const previousHeight = el?.scrollHeight || 0;
    const previousTop = el?.scrollTop || 0;
    try {
      const res = await messageApi.list(convId, { before: messages[0].id, limit: 50 });
      setMessages((prev) => {
        const map = new Map(prev.map((m) => [m.id, m]));
        for (const m of res.messages) map.set(m.id, m);
        const next = Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
        messagesRef.current = next;
        return next;
      });
      setHasMore(res.hasMore);
      window.requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - previousHeight + previousTop;
      });
    } catch (e) {
      toast({ title: 'Chargement impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setLoadingOlder(false);
    }
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance < 200;
    setShowJump(distance > 500);
    if (el.scrollTop < 70) void loadOlder();
  };

  /* ------------------------------------------------------------- rendu */
  if (!me) return null;
  if (loading && !conversation) {
    return <div className="chat loading-chat"><Spinner size={32} /></div>;
  }
  if (!conversation) {
    return (
      <div className="chat">
        <EmptyState icon={<IonIcon icon={chatbubbleEllipsesOutline} />} title="Conversation introuvable" text="Elle a peut-être été supprimée." />
      </div>
    );
  }

  const peer = conversation.peer;
  const peerPresence = peer ? presence[peer.id] : undefined;
  const peerOnline = peerPresence ? peerPresence.online : peer?.online;
  const peerLastSeen = peerPresence ? peerPresence.lastSeen : peer?.lastSeen;
  const typingNow = typing.filter((t) => t.until > Date.now() / 1000);
  const subtitle = typingNow.length > 0
    ? (typingNow.length === 1 ? `${typingNow[0].name} écrit…` : 'Plusieurs personnes écrivent…')
    : conversation.blocked
      ? 'Discussion bloquée'
      : conversation.type === 'group'
        ? `${conversation.memberCount} membres`
        : peerOnline
          ? 'En ligne'
          : peerLastSeen
            ? `Vu ${lastSeenLabel(peerLastSeen)}`
            : 'Hors ligne';

  const disabledReason = conversation.blocked
    ? 'Vous ne pouvez pas envoyer de messages : un blocage est actif.'
    : conversation.onlyAdminsCanPost === 1 && !['owner', 'admin'].includes(conversation.myRole || '')
      ? 'Seuls les administrateurs peuvent écrire dans ce groupe.'
      : undefined;

  const grouped = groupMessagesByDay(messages);
  const canModerate = conversation.type === 'group' && ['owner', 'admin'].includes(conversation.myRole || '');
  const now = Date.now() / 1000;

  const menuActions = [
    {
      label: conversation.type === 'group' ? 'Infos du groupe' : 'Profil du contact',
      icon: informationCircleOutline,
      onClick: () => { if (conversation.type === 'group') setGroupInfoOpen(true); else if (peer) setProfileUserId(peer.id); },
    },
    { label: 'Rechercher dans la discussion', icon: searchOutline, onClick: () => setSearchOpen(true) },
    { label: 'Médias et documents', icon: imagesOutline, onClick: () => setMediaOpen(true) },
    { label: 'Messages favoris', icon: starOutline, onClick: () => setStarredOpen(true) },
    { label: conversation.mutedUntil > now ? 'Réactiver les notifications' : 'Couper les notifications 8 h', icon: conversation.mutedUntil > now ? notificationsOutline : notificationsOffOutline, onClick: () => void toggleMute(conversation.mutedUntil > now ? 0 : 8 * 3600) },
    { label: conversation.pinned ? 'Désépingler la conversation' : 'Épingler la conversation', icon: pinOutline, onClick: () => void togglePin() },
    { label: conversation.archived ? 'Désarchiver' : 'Archiver la conversation', icon: archiveOutline, onClick: () => void archive() },
    { label: 'Vider la conversation', icon: trashOutline, onClick: () => setConfirmAction('clear') },
    { label: 'Supprimer la conversation', icon: trashOutline, danger: true, onClick: () => setConfirmAction('delete') },
    ...(conversation.type === 'group' ? [{ label: 'Quitter le groupe', icon: exitOutline, danger: true, onClick: () => setConfirmAction('leave') }] : []),
    ...(conversation.type === 'direct' && peer && !conversation.blocked ? [{ label: 'Bloquer ce contact', icon: banOutline, danger: true, onClick: () => setConfirmAction('block') }] : []),
  ];

  const canDeleteEveryone = actionMessage && (actionMessage.mine || canModerate) && !actionMessage.deletedAt;
  const canEditMessage = actionMessage && actionMessage.mine && actionMessage.type === 'text' && !actionMessage.deletedAt && (Date.now() / 1000 - actionMessage.createdAt) < 900;

  return (
    <div className="chat">
      <header className="chat-head">
        <IconButton icon={arrowBackOutline} label="Retour" className="back-btn" onClick={() => history.push('/')} />
        <button
          type="button"
          className="chat-peer"
          onClick={() => { if (conversation.type === 'group') setGroupInfoOpen(true); else if (peer) setProfileUserId(peer.id); }}
        >
          <Avatar
            id={conversation.type === 'group' ? conversation.id + 3 : peer?.id || 0}
            name={conversation.title}
            avatarId={conversation.avatarId}
            size={42}
            group={conversation.type === 'group'}
            online={conversation.type === 'direct' ? peerOnline : undefined}
          />
          <span className="chat-peer-text">
            <strong>{conversation.title}</strong>
            <em className={typingNow.length ? 'typing' : ''}>{subtitle}</em>
          </span>
        </button>
        <div className="chat-head-actions">
          <IconButton icon={searchOutline} label="Rechercher" onClick={() => setSearchOpen(true)} />
          <IconButton
            icon={informationCircleOutline}
            label="Informations"
            onClick={() => { if (conversation.type === 'group') setGroupInfoOpen(true); else if (peer) setProfileUserId(peer.id); }}
          />
          <IconButton icon={ellipsisVertical} label="Menu" onClick={() => setMenuOpen(true)} />
        </div>
      </header>

      {searchOpen && (
        <div className="chat-search">
          <div className="chat-search-head">
            <div className="search-box">
              <IonIcon icon={searchOutline} />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Rechercher dans la conversation…"
                autoFocus
              />
              {searchQ && <button type="button" className="clear-btn" onClick={() => setSearchQ('')}><IonIcon icon={closeOutline} /></button>}
            </div>
            <IconButton icon={closeOutline} label="Fermer la recherche" onClick={() => { setSearchOpen(false); setSearchQ(''); }} />
          </div>
          {searching && <div className="center-pad"><Spinner /></div>}
          {!searching && searchQ.trim() && searchResults.length === 0 && (
            <p className="muted small center-pad">Aucun message ne correspond.</p>
          )}
          <div className="search-result-list">
            {searchResults.map((m) => (
              <button key={m.id} type="button" className="search-result" onClick={() => void jumpTo(m.id)}>
                <Avatar id={m.senderId} name={m.senderName} avatarId={m.senderAvatarId} size={34} />
                <span>
                  <strong>{m.senderName} <em>{formatListTime(m.createdAt)}</em></strong>
                  <span>{previewText(m.type, m.body)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        {hasMore && (
          <div className="load-older">
            <button type="button" className="btn small ghost" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? <Spinner size={16} /> : <IonIcon icon={timeOutline} />}
              Charger les messages plus anciens
            </button>
          </div>
        )}
        {messages.length === 0 && !loading && (
          <div className="conversation-start">
            <Avatar id={conversation.type === 'group' ? conversation.id + 3 : peer?.id || 0} name={conversation.title} avatarId={conversation.avatarId} size={72} group={conversation.type === 'group'} />
            <h3>{conversation.title}</h3>
            <p>
              {conversation.type === 'group'
                ? `Groupe créé le ${formatDayLabel(conversation.createdAt)}. Dites bonjour aux ${conversation.memberCount} membres !`
                : 'C’est le début de votre conversation. Dites bonjour !'}
            </p>
          </div>
        )}
        {grouped.map((group) => (
          <div key={group.day} className="day-group">
            <div className="day-sep"><span>{formatDayLabel(group.day)}</span></div>
            {group.items.map((m, i) => {
              const prev = i > 0 ? group.items[i - 1] : null;
              const showName = !prev || prev.senderId !== m.senderId || (m.createdAt - prev.createdAt) > 300;
              return (
                <React.Fragment key={m.id}>
                  {firstUnread === m.id && (
                    <div className="unread-sep"><span>Messages non lus</span></div>
                  )}
                  <div id={`msg-${m.id}`} className="msg-anchor">
                    <MessageBubble
                      message={m}
                      conversation={conversation}
                      meId={me.id}
                      showName={showName}
                      showAvatar={showName}
                      contiguous={!showName}
                      highlighted={highlight === m.id}
                      onAction={(msg) => { setActionMessage(msg); setReactionTarget(msg); }}
                      onReply={(msg) => {
                        setReplyTo(msg);
                        setEditing(null);
                        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
                      }}
                      onReaction={(msg, emoji) => void react(msg, emoji)}
                      onJumpTo={(mid) => void jumpTo(mid)}
                      onOpenImage={(media) => setImageViewer(media)}
                    />
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {showJump && (
        <button type="button" className="jump-bottom" onClick={() => { nearBottomRef.current = true; scrollToBottom(true); setShowJump(false); }} aria-label="Aller au dernier message">
          <IonIcon icon={chevronDownOutline} />
        </button>
      )}

      <Composer
        conversation={conversation}
        replyTo={replyTo}
        editing={editing}
        disabledReason={disabledReason}
        onSend={handleSend}
        onTyping={handleTyping}
        onSent={() => { setReplyTo(null); setEditing(null); }}
        onCancelContext={() => { setReplyTo(null); setEditing(null); }}
      />

      {/* Actions message */}
      <Modal open={!!actionMessage} onClose={() => setActionMessage(null)} className="message-actions-sheet">
        <div className="sheet-grabber" />
        {actionMessage && (
          <>
            {!actionMessage.deletedAt && (
              <div className="quick-reactions">
                {QUICK_REACTIONS.map((e) => (
                  <button key={e} type="button" onClick={() => { void react(actionMessage, e); setActionMessage(null); }}>{e}</button>
                ))}
                <button
                  type="button"
                  className="more-reactions"
                  onClick={() => { setReactionTarget(actionMessage); setActionMessage(null); setReactionOpen(true); }}
                  aria-label="Plus de réactions"
                >+</button>
              </div>
            )}
            <div className="sheet-actions">
              {!actionMessage.deletedAt && (
                <button type="button" className="sheet-action" onClick={() => { setReplyTo(actionMessage); setEditing(null); setActionMessage(null); document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(); }}>
                  <IonIcon icon={arrowRedoOutline} /><span>Répondre</span>
                </button>
              )}
              {actionMessage.type === 'text' && actionMessage.body && (
                <button type="button" className="sheet-action" onClick={() => { void copyMessage(actionMessage); setActionMessage(null); }}>
                  <IonIcon icon={copyOutline} /><span>Copier le texte</span>
                </button>
              )}
              {canEditMessage && (
                <button type="button" className="sheet-action" onClick={() => { setEditing(actionMessage); setReplyTo(null); setActionMessage(null); }}>
                  <IonIcon icon={createOutline} /><span>Modifier</span>
                </button>
              )}
              {!actionMessage.deletedAt && (
                <button type="button" className="sheet-action" onClick={() => { void star(actionMessage); setActionMessage(null); }}>
                  <IonIcon icon={actionMessage.starred ? starFilled : starOutline} /><span>{actionMessage.starred ? 'Retirer des favoris' : 'Ajouter aux favoris'}</span>
                </button>
              )}
              {!actionMessage.deletedAt && (
                <button type="button" className="sheet-action" onClick={() => { setForwardMessage(actionMessage); setActionMessage(null); }}>
                  <IonIcon icon={arrowRedoOutline} /><span>Transférer</span>
                </button>
              )}
              {actionMessage.mine && !actionMessage.deletedAt && (
                <button type="button" className="sheet-action" onClick={() => { setInfoMessage(actionMessage); setActionMessage(null); }}>
                  <IonIcon icon={informationCircleOutline} /><span>Informations</span>
                </button>
              )}
              <button type="button" className="sheet-action" onClick={() => { setDeleteTarget({ message: actionMessage, everyone: false }); }}>
                <IonIcon icon={trashOutline} /><span>Supprimer pour moi</span>
              </button>
              {canDeleteEveryone && (
                <button type="button" className="sheet-action danger" onClick={() => setDeleteTarget({ message: actionMessage, everyone: true })}>
                  <IonIcon icon={trashOutline} /><span>Supprimer pour tout le monde</span>
                </button>
              )}
            </div>
            <button type="button" className="sheet-cancel" onClick={() => setActionMessage(null)}>Annuler</button>
          </>
        )}
      </Modal>

      {/* Sélecteur de réaction complet */}
      <Modal open={reactionOpen} onClose={() => setReactionOpen(false)} className="reaction-modal">
        <EmojiPicker
          onPick={(emoji) => {
            if (reactionTarget) void react(reactionTarget, emoji);
            setReactionOpen(false);
          }}
          onClose={() => setReactionOpen(false)}
        />
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void doDelete()}
        title={deleteTarget?.everyone ? 'Supprimer pour tout le monde ?' : 'Supprimer pour vous ?'}
        message={deleteTarget?.everyone
          ? 'Le message sera remplacé par « Message supprimé » chez tous les participants.'
          : 'Le message disparaîtra de votre côté uniquement.'}
        confirmLabel="Supprimer"
        danger
      />

      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={conversation.title} actions={menuActions} />

      <ConfirmDialog
        open={confirmAction === 'clear'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => void clearChat()}
        title="Vider la conversation ?"
        message="Tous les messages seront supprimés pour vous uniquement."
        confirmLabel="Vider"
        danger
      />
      <ConfirmDialog
        open={confirmAction === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => void deleteChat()}
        title="Supprimer la conversation ?"
        message="Elle disparaîtra de votre liste. Elle réapparaîtra si un nouveau message arrive."
        confirmLabel="Supprimer"
        danger
      />
      <ConfirmDialog
        open={confirmAction === 'leave'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => void leaveGroup()}
        title="Quitter le groupe ?"
        message={conversation.myRole === 'owner' ? 'Vous êtes propriétaire : le rôle sera transmis à un autre membre.' : 'Vous ne recevrez plus les messages de ce groupe.'}
        confirmLabel="Quitter"
        danger
      />
      <ConfirmDialog
        open={confirmAction === 'block'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => void blockPeer()}
        title="Bloquer ce contact ?"
        message="Il ne pourra plus vous écrire en privé. Vous pourrez le débloquer depuis son profil."
        confirmLabel="Bloquer"
        danger
      />

      <ForwardModal
        message={forwardMessage}
        open={!!forwardMessage}
        onClose={() => setForwardMessage(null)}
      />
      <MessageInfoModal message={infoMessage} open={!!infoMessage} onClose={() => setInfoMessage(null)} />
      <ConversationMediaModal conversationId={convId} open={mediaOpen} onClose={() => setMediaOpen(false)} />
      <StarredModal
        open={starredOpen}
        onClose={() => setStarredOpen(false)}
        onOpenMessage={(cid, mid) => history.push(`/chat/${cid}?m=${mid}`)}
      />
      <UserProfileModal userId={profileUserId} open={!!profileUserId} onClose={() => setProfileUserId(null)} />
      <GroupInfoModal
        conversation={conversation}
        open={groupInfoOpen}
        onClose={() => setGroupInfoOpen(false)}
        onUpdated={(c) => { setConversation(c); upsertConversation(c); }}
        onLeft={(reason) => {
          setGroupInfoOpen(false);
          if (reason === 'clear') {
            setMessages([]);
            messagesRef.current = [];
            lastMessageIdRef.current = 0;
            toast({ title: 'Conversation vidée', tone: 'success' });
            chatApi.get(convId).then((res) => {
              setConversation(res.conversation);
              upsertConversation(res.conversation);
            }).catch(() => undefined);
          } else {
            removeConversation(convId);
            history.replace('/');
          }
        }}
        onOpenUser={(uid) => { setGroupInfoOpen(false); setProfileUserId(uid); }}
      />
      <ImageViewer media={imageViewer} open={!!imageViewer} onClose={() => setImageViewer(null)} />
    </div>
  );
}
