/**
 * Abonnement temps réel via Server-Sent Events.
 *
 * Le serveur ferme volontairement le flux au bout de ~20 s (compatibilité
 * Apache/mod_php) ; le client se reconnecte immédiatement avec des curseurs
 * à jour. En cas d'échec, il retente avec un backoff et l'appelant reprend
 * le polling `sync` comme filet de sécurité.
 */
import { syncStreamUrl } from './api';
import type { SyncResponse } from '../types';

export type StreamState = 'connecting' | 'live' | 'down';

export interface SyncStreamParams {
  since?: number;
  conversationId?: number;
  afterMessageId?: number;
  updatesSince?: number;
  presence?: number[];
}

interface SyncStreamOptions {
  token: string;
  params: () => SyncStreamParams;
  onSync: (payload: SyncResponse) => void;
  onState?: (state: StreamState) => void;
}

const RETRY_MIN = 1000;
const RETRY_MAX = 15000;
const WATCHDOG_MS = 35000;

export class SyncStream {
  private source: EventSource | null = null;
  private retryTimer: number | undefined;
  private watchdogTimer: number | undefined;
  private retryDelay = RETRY_MIN;
  private started = false;
  private paused = false;
  private state: StreamState = 'down';

  constructor(private readonly options: SyncStreamOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof EventSource === 'undefined') {
      this.setState('down');
      return;
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    if (!document.hidden) this.connect();
  }

  stop(): void {
    this.started = false;
    this.paused = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.teardown();
    this.setState('down');
  }

  private onVisibility = (): void => {
    if (document.hidden) this.pause();
    else this.resume();
  };

  private pause(): void {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.teardown();
    this.setState('down');
  }

  private resume(): void {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.connect();
  }

  private connect(): void {
    if (!this.started || this.paused || document.hidden || !this.options.token) return;
    this.teardown();
    this.setState('connecting');
    const source = new EventSource(syncStreamUrl({ ...this.options.params(), session: this.options.token }));
    this.source = source;

    source.addEventListener('open', () => this.markAlive());
    source.addEventListener('ready', () => this.markAlive());
    source.addEventListener('ping', () => this.markAlive());
    source.addEventListener('sync', (event) => {
      this.markAlive();
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as SyncResponse;
        this.options.onSync(payload);
      } catch {
        /* charge utile illisible : le prochain événement corrigera */
      }
    });
    source.addEventListener('end', () => this.reconnect(0, true));
    source.onerror = () => this.reconnect();
    this.armWatchdog();
  }

  private markAlive(): void {
    this.retryDelay = RETRY_MIN;
    this.setState('live');
    this.armWatchdog();
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) window.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = window.setTimeout(() => this.reconnect(), WATCHDOG_MS);
  }

  /**
   * `clean` = rotation normale décidée par le serveur : on ne signale pas
   * de coupure, pour ne pas déclencher un polling inutile.
   */
  private reconnect(delay?: number, clean = false): void {
    if (!this.started || this.paused) return;
    this.teardown();
    if (!clean) this.setState('down');
    const wait = delay ?? this.retryDelay;
    if (delay === undefined) this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, wait);
  }

  private teardown(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this.watchdogTimer) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private setState(next: StreamState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onState?.(next);
  }
}
