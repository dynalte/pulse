/**
 * Réglages locaux (localStorage) : URL de l'API, session, apparence, brouillons.
 * Le serveur reste la source de vérité pour le profil et les préférences de notifications.
 */
export const Keys = {
  apiURL: 'pulse_api_url',
  token: 'pulse_session_token',
  user: 'pulse_user',
  theme: 'pulse_theme',
  accent: 'pulse_accent',
  sound: 'pulse_sound',
  lastSeenSync: 'pulse_last_seen_sync',
  inviteDraft: 'pulse_invite_draft',
} as const;

function getString(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function defaultApiURL(): string {
  try {
    // Même origine par défaut : /api-messagerie.php (proxy Vite en dev).
    return new URL('api-messagerie.php', window.location.origin + '/').href;
  } catch {
    return 'api-messagerie.php';
  }
}

export const settings = {
  get apiURL(): string {
    return (getString(Keys.apiURL, '') || defaultApiURL()).trim();
  },
  get token(): string {
    return getString(Keys.token, '').trim();
  },
  get cachedUser(): unknown {
    try {
      const raw = getString(Keys.user, '');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  get theme(): 'dark' | 'light' | 'system' {
    const v = getString(Keys.theme, 'dark');
    return v === 'light' || v === 'system' ? v : 'dark';
  },
  get accent(): string {
    const v = getString(Keys.accent, 'emerald');
    return ['emerald', 'violet', 'ocean', 'sunset'].includes(v) ? v : 'emerald';
  },
  get sound(): boolean {
    return getString(Keys.sound, '1') !== '0';
  },
  get inviteDraft(): string {
    return getString(Keys.inviteDraft, '');
  },
};

export function setSetting(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* mode privé : on ignore */
  }
}

export function setApiURL(url: string) {
  setSetting(Keys.apiURL, url.trim().replace(/\/+$/, ''));
}

export function saveSession(token: string, user: unknown) {
  setSetting(Keys.token, token);
  try {
    localStorage.setItem(Keys.user, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function saveCachedUser(user: unknown) {
  try {
    localStorage.setItem(Keys.user, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function clearSession() {
  setSetting(Keys.token, null);
  setSetting(Keys.user, null);
  setSetting(Keys.lastSeenSync, null);
}

export function draftKey(conversationId: number): string {
  return `pulse_draft_${conversationId}`;
}
