import { useCallback, useEffect, useRef, useState } from 'react';

export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [onOutside]);
  return ref;
}

export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Capture l'événement dès le chargement du module : sinon il est manqué
// quand l'utilisateur ouvre les Réglages après le chargement de la PWA.
let deferredInstall: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
function notifyInstall() {
  installListeners.forEach((fn) => fn());
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e as InstallPromptEvent;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    notifyInstall();
  });
}

export function useInstallPrompt() {
  const [canInstall, setCanInstall] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !!deferredInstall && !window.matchMedia('(display-mode: standalone)').matches;
  });
  const [installed, setInstalled] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches
  ));

  useEffect(() => {
    const update = () => {
      const standalone = window.matchMedia('(display-mode: standalone)').matches;
      setInstalled(standalone);
      setCanInstall(!!deferredInstall && !standalone);
    };
    installListeners.add(update);
    update();
    return () => {
      installListeners.delete(update);
    };
  }, []);

  const install = useCallback(async (): Promise<boolean> => {
    if (!deferredInstall) return false;
    await deferredInstall.prompt();
    const choice = await deferredInstall.userChoice;
    deferredInstall = null;
    notifyInstall();
    return choice.outcome === 'accepted';
  }, []);

  return { canInstall: canInstall && !installed, installed, install };
}

/** Long press mobile (500 ms) sans bloquer le scroll. */
export function useLongPress(callback: () => void, ms = 500) {
  const timer = useRef<number | null>(null);
  const start = useCallback(() => {
    timer.current = window.setTimeout(callback, ms);
  }, [callback, ms]);
  const clear = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  return {
    onTouchStart: start,
    onTouchEnd: clear,
    onTouchMove: clear,
    onMouseDown: start,
    onMouseUp: clear,
    onMouseLeave: clear,
  };
}
