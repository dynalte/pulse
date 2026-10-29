/**
 * Contexte global : session, conversations, synchronisation temps réel,
 * notifications locales et préférences d'apparence.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { accountApi, authApi, chatApi, messageApi } from '../services/api';
import { clearMediaCache } from '../services/api';
import { clearMediaObjectUrls } from '../services/media';
import { disablePush, enablePush, pushSupported, setAppBadge } from '../services/notifications';
import { clearSession, Keys, saveCachedUser, saveSession, setSetting, settings } from '../services/settings';
import { playNotificationSound, previewText } from '../services/utils';
import type { Conversation, Me, Message, NotifPrefs, PrivacyPrefs, ThemeMode } from '../types';

export interface ToastItem {
  id: number;
  title: string;
  body?: string;
  avatarId?: number | null;
  tone?: 'info' | 'success' | 'error';
  conversationId?: number;
}

interface AppContextValue {
  me: Me | null;
  booting: boolean;
  conversations: Conversation[];
  unreadTotal: number;
  toasts: ToastItem[];
  theme: ThemeMode;
  accent: string;
  soundEnabled: boolean;
  setTheme: (t: ThemeMode) => void;
  setAccent: (a: string) => void;
  setSoundEnabled: (v: boolean) => void;
  login: (login: string, password: string) => Promise<Me>;
  setupAdmin: (name: string, email: string, username: string, password: string) => Promise<Me>;
  registerWithInvite: (code: string, name: string, email: string, username: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<Me | null>;
  refreshConversations: () => Promise<void>;
  applyConversations: (list: Conversation[]) => void;
  upsertConversation: (c: Conversation) => void;
  removeConversation: (id: number) => void;
  markConversationReadLocal: (id: number, lastRead?: number) => void;
  setUnreadTotal: (n: number) => void;
  updateMe: (user: Me) => void;
  updateNotif: (n: Partial<NotifPrefs>) => Promise<void>;
  updatePrivacy: (p: Partial<PrivacyPrefs>) => Promise<void>;
  setActiveConversation: (id: number | null, visible?: boolean) => void;
  toast: (t: Omit<ToastItem, 'id'>) => void;
  dismissToast: (id: number) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned - a.pinned;
    return b.updatedAt - a.updatedAt;
  });
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const history = useHistory();
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [unreadTotal, setUnreadTotalState] = useState(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [theme, setThemeState] = useState<ThemeMode>(settings.theme);
  const [accent, setAccentState] = useState(settings.accent);
  const [soundEnabled, setSoundEnabledState] = useState(settings.sound);

  const meRef = useRef<Me | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const activeConversationRef = useRef<number | null>(null);
  const activeVisibleRef = useRef(false);
  const lastSyncRef = useRef(0);
  const toastIdRef = useRef(1);
  const notifiedRef = useRef<Set<number>>(new Set());

  meRef.current = me;

  /* ---------------------------------------------------------- apparence */
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.accent = accent;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0f1c' : '#f2f5f9');
    };
    apply();
    setSetting(Keys.theme, theme);
    setSetting(Keys.accent, accent);
    if (theme === 'system') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    return undefined;
  }, [theme, accent]);

  const setTheme = useCallback((t: ThemeMode) => setThemeState(t), []);
  const setAccent = useCallback((a: string) => setAccentState(a), []);
  const setSoundEnabled = useCallback((v: boolean) => {
    setSoundEnabledState(v);
    setSetting(Keys.sound, v ? '1' : '0');
  }, []);

  /* -------------------------------------------------------------- toasts */
  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = toastIdRef.current++;
    setToasts((list) => [...list.slice(-2), { ...t, id }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((x) => x.id !== id));
    }, t.tone === 'error' ? 7000 : 5000);
  }, []);

  /* ------------------------------------------------------------ sessions */
  const setUnreadTotal = useCallback((n: number) => {
    setUnreadTotalState(n);
  }, []);

  useEffect(() => {
    if (me?.notif.badge === false) setAppBadge(0);
    else setAppBadge(unreadTotal);
  }, [unreadTotal, me?.notif.badge]);

  const applyConversations = useCallback((list: Conversation[]) => {
    setConversations((prev) => {
      const map = new Map(prev.map((c) => [c.id, c]));
      for (const c of list) map.set(c.id, c);
      const next = sortConversations(Array.from(map.values()));
      conversationsRef.current = next;
      return next;
    });
  }, []);

  const replaceConversations = useCallback((list: Conversation[]) => {
    const next = sortConversations(list);
    conversationsRef.current = next;
    setConversations(next);
  }, []);

  const upsertConversation = useCallback((c: Conversation) => {
    setConversations((prev) => {
      const map = new Map(prev.map((x) => [x.id, x]));
      map.set(c.id, c);
      const next = sortConversations(Array.from(map.values()));
      conversationsRef.current = next;
      return next;
    });
  }, []);

  const removeConversation = useCallback((id: number) => {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      conversationsRef.current = next;
      return next;
    });
  }, []);

  const markConversationReadLocal = useCallback((id: number, lastRead?: number) => {
    const current = conversationsRef.current.find((c) => c.id === id);
    if (!current) return;
    const oldUnread = current.unread;
    const next = conversationsRef.current.map((c) => {
      if (c.id !== id) return c;
      return {
        ...c,
        unread: 0,
        lastReadMessageId: Math.max(c.lastReadMessageId, lastRead ?? c.lastMessage?.id ?? 0),
      };
    });
    conversationsRef.current = next;
    setConversations(next);
    if (oldUnread > 0) {
      setUnreadTotalState((u) => Math.max(0, u - oldUnread));
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    const res = await chatApi.list(true);
    replaceConversations(res.conversations);
    setUnreadTotal(res.unreadTotal);
  }, [replaceConversations, setUnreadTotal]);

  const refreshMe = useCallback(async (): Promise<Me | null> => {
    try {
      const res = await accountApi.me();
      setMe(res.user);
      saveCachedUser(res.user);
      setUnreadTotal(res.user.unreadTotal ?? 0);
      return res.user;
    } catch {
      return null;
    }
  }, [setUnreadTotal]);

  const completeAuth = useCallback(async (token: string, user: Me) => {
    saveSession(token, user);
    clearMediaCache();
    clearMediaObjectUrls();
    notifiedRef.current.clear();
    setMe(user);
    meRef.current = user;
    setUnreadTotal(user.unreadTotal ?? 0);
    lastSyncRef.current = Math.floor(Date.now() / 1000) - 1;
    try {
      await refreshConversations();
    } catch {
      /* la synchronisation réessaiera */
    }
    if (user.notif.enabled && pushSupported() && Notification.permission === 'granted') {
      void enablePush().catch(() => undefined);
    }
  }, [refreshConversations, setUnreadTotal]);

  const login = useCallback(async (loginValue: string, password: string) => {
    const res = await authApi.login(loginValue, password);
    await completeAuth(res.token, res.user);
    return res.user;
  }, [completeAuth]);

  const setupAdmin = useCallback(async (name: string, email: string, username: string, password: string) => {
    const res = await authApi.bootstrap(name, email, username, password);
    await completeAuth(res.token, res.user);
    return res.user;
  }, [completeAuth]);

  const registerWithInvite = useCallback(async (code: string, name: string, email: string, username: string, password: string) => {
    const res = await authApi.register(code, name, email, username, password);
    await completeAuth(res.token, res.user);
    return res.user;
  }, [completeAuth]);

  const logout = useCallback(async () => {
    try {
      await disablePush();
    } catch {
      /* ignore */
    }
    try {
      await authApi.logout();
    } catch {
      /* le jeton est peut-être déjà invalide */
    }
    clearSession();
    clearMediaCache();
    clearMediaObjectUrls();
    notifiedRef.current.clear();
    setAppBadge(0);
    meRef.current = null;
    conversationsRef.current = [];
    setMe(null);
    setConversations([]);
    setUnreadTotalState(0);
    lastSyncRef.current = 0;
    history.replace('/');
  }, [history]);

  const updateMe = useCallback((user: Me) => {
    setMe(user);
    meRef.current = user;
    saveCachedUser(user);
    setUnreadTotal(user.unreadTotal ?? 0);
  }, [setUnreadTotal]);

  const updateNotif = useCallback(async (n: Partial<NotifPrefs>) => {
    const res = await accountApi.profileUpdate({ notif: n });
    updateMe(res.user);
  }, [updateMe]);

  const updatePrivacy = useCallback(async (p: Partial<PrivacyPrefs>) => {
    const res = await accountApi.profileUpdate({ privacy: p });
    updateMe(res.user);
  }, [updateMe]);

  const setActiveConversation = useCallback((id: number | null, visible = true) => {
    activeConversationRef.current = id;
    activeVisibleRef.current = visible;
  }, []);

  /* --------------------------------------------------------------- boot */
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!settings.token) {
        setBooting(false);
        return;
      }
      try {
        const { user } = await accountApi.me();
        if (!alive) return;
        setMe(user);
        meRef.current = user;
        setUnreadTotal(user.unreadTotal ?? 0);
        lastSyncRef.current = Math.floor(Date.now() / 1000) - 1;
        await refreshConversations();
        if (user.notif.enabled && pushSupported() && Notification.permission === 'granted') {
          void enablePush().catch(() => undefined);
        }
      } catch (e) {
        if (!alive) return;
        const status = (e as { status?: number }).status;
        if (status === 401) {
          clearSession();
          setMe(null);
        } else {
          const cached = settings.cachedUser as Me | null;
          if (cached && cached.id) {
            setMe(cached);
            meRef.current = cached;
            toast({ title: 'Serveur injoignable', body: 'Mode hors ligne : certaines actions peuvent échouer.', tone: 'error' });
          }
        }
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------------------------------------- sync global */
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;

    const notifyEvents = (events: Message[]) => {
      if (!events.length) return;
      const current = meRef.current;
      if (!current) return;
      const visible = document.visibilityState === 'visible';
      if (!visible) return; // le Web Push prend le relais en arrière-plan
      const now = Date.now() / 1000;
      const fresh = events.filter((m) => {
        if (m.senderId === current.id || m.type === 'system') return false;
        if (notifiedRef.current.has(m.id)) return false;
        notifiedRef.current.add(m.id);
        return true;
      });
      if (notifiedRef.current.size > 500) {
        notifiedRef.current = new Set(Array.from(notifiedRef.current).slice(-250));
      }
      if (!fresh.length) return;
      let played = false;
      for (const m of fresh) {
        if (m.conversationId === activeConversationRef.current && activeVisibleRef.current) continue;
        const conv = conversationsRef.current.find((c) => c.id === m.conversationId);
        if (conv && conv.mutedUntil > now) continue;
        const title = conv?.type === 'group' ? conv.title : m.senderName || conv?.title || 'Pulse';
        const body = conv?.type === 'group'
          ? `${m.senderName} · ${previewText(m.type, m.body)}`
          : previewText(m.type, m.body);
        toast({
          title,
          body: body.slice(0, 160),
          avatarId: conv?.type === 'group' ? conv.avatarId : m.senderAvatarId,
          conversationId: m.conversationId,
        });
        if (!played && current.notif.sound && soundEnabled) {
          playNotificationSound();
          played = true;
        }
      }
    };

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await messageApi.sync({ since: lastSyncRef.current });
        if (cancelled) return;
        lastSyncRef.current = Math.max(res.now - 1, lastSyncRef.current);
        if (res.conversations?.length) applyConversations(res.conversations);
        setUnreadTotal(res.me.unreadTotal);
        notifyEvents(res.events || []);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 401) {
          clearSession();
          setMe(null);
          return;
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          const delay = document.visibilityState === 'hidden' ? 20000 : (activeConversationRef.current ? 10000 : 6000);
          timer = window.setTimeout(tick, delay);
        }
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (timer) window.clearTimeout(timer);
        timer = undefined;
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [me?.id, applyConversations, setUnreadTotal, soundEnabled, toast]);

  const value = useMemo<AppContextValue>(() => ({
    me,
    booting,
    conversations,
    unreadTotal,
    toasts,
    theme,
    accent,
    soundEnabled,
    setTheme,
    setAccent,
    setSoundEnabled,
    login,
    setupAdmin,
    registerWithInvite,
    logout,
    refreshMe,
    refreshConversations,
    applyConversations,
    upsertConversation,
    removeConversation,
    markConversationReadLocal,
    setUnreadTotal,
    updateMe,
    updateNotif,
    updatePrivacy,
    setActiveConversation,
    toast,
    dismissToast,
  }), [
    me, booting, conversations, unreadTotal, toasts, theme, accent, soundEnabled,
    setTheme, setAccent, setSoundEnabled, login, setupAdmin, registerWithInvite, logout,
    refreshMe, refreshConversations, applyConversations, upsertConversation, removeConversation,
    markConversationReadLocal, setUnreadTotal, updateMe, updateNotif, updatePrivacy,
    setActiveConversation, toast, dismissToast,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp doit être utilisé dans AppProvider');
  return ctx;
}
