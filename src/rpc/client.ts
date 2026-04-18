import { Client } from '@xhayper/discord-rpc';
import { getLogger } from '../utils/logger';
import type { PresencePayload } from './presence-builder';

export interface RpcClientOptions {
  clientId: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Max consecutive login failures before giving up. Default 10. */
  maxConsecutiveFailures?: number;
  onFatal?: (reason: string) => void;
}

/**
 * `@xhayper/discord-rpc` surfaces login errors as generic Error messages.
 * These substrings indicate an unrecoverable credential/handshake problem
 * — retrying won't help, so we exit instead of spinning forever.
 */
const FATAL_ERROR_FRAGMENTS = [
  'invalid client id',
  'oauth2 authorization failed',
  'invalid_client',
  '4000',
  'client_id is required',
];

/**
 * Wraps @xhayper/discord-rpc with a reconnect loop and a debounced setActivity.
 * Discord IPC rate-limits updates at ~1 call per 15 s — callers should coalesce upstream.
 */
export class RpcClient {
  private client: Client | null = null;
  private ready = false;
  private destroyed = false;
  private pendingPayload: PresencePayload | null = null;
  private clearPending = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private consecutiveFailures = 0;

  constructor(private readonly options: RpcClientOptions) {}

  async connect(): Promise<void> {
    if (this.destroyed) return;
    const log = getLogger();
    this.cancelReconnect();

    const client = new Client({ clientId: this.options.clientId });
    this.client = client;

    client.on('ready', () => {
      this.ready = true;
      this.reconnectAttempt = 0;
      this.consecutiveFailures = 0;
      log.info('rpc: connected to Discord');
      this.flushPending();
    });

    client.on('disconnected', () => {
      log.warn('rpc: disconnected');
      this.handleDisconnect();
    });

    client.on('error', (err: unknown) => {
      log.warn({ err: (err as Error)?.message ?? String(err) }, 'rpc: error event');
    });

    try {
      await client.login();
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (isFatalAuthError(message)) {
        log.error({ err: message }, 'rpc: fatal credential error — not retrying');
        this.destroyed = true;
        this.options.onFatal?.(message);
        return;
      }
      this.consecutiveFailures++;
      const max = this.options.maxConsecutiveFailures ?? 10;
      if (this.consecutiveFailures >= max) {
        log.error(
          { attempts: this.consecutiveFailures, max },
          'rpc: circuit breaker tripped after consecutive failures',
        );
        this.destroyed = true;
        this.options.onFatal?.(`login failed ${this.consecutiveFailures} times consecutively`);
        return;
      }
      log.warn({ err: message, failures: this.consecutiveFailures }, 'rpc: login failed');
      this.handleDisconnect();
    }
  }

  setActivity(payload: PresencePayload): void {
    this.pendingPayload = payload;
    this.clearPending = false;
    if (this.ready) this.flushPending();
  }

  clearActivity(): void {
    this.pendingPayload = null;
    this.clearPending = true;
    if (this.ready) this.flushPending();
  }

  isReady(): boolean {
    return this.ready;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.cancelReconnect();
    const log = getLogger();
    const client = this.client;
    if (!client) return;
    try {
      if (this.ready) {
        await client.user?.clearActivity().catch(() => undefined);
      }
      await client.destroy();
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'rpc: destroy error (ignored)');
    } finally {
      this.client = null;
      this.ready = false;
    }
  }

  private flushPending(): void {
    if (!this.ready || !this.client) return;
    const log = getLogger();
    const user = this.client.user;
    if (!user) return;

    if (this.clearPending) {
      this.clearPending = false;
      user.clearActivity().catch((err: Error) => {
        log.warn({ err: err.message }, 'rpc: clearActivity failed');
      });
      return;
    }
    if (!this.pendingPayload) return;
    const payload = this.pendingPayload;
    log.trace({ payload }, 'rpc: setActivity payload');
    user
      .setActivity({
        details: payload.details,
        state: payload.state,
        startTimestamp: payload.startTimestamp,
        largeImageKey: payload.largeImageKey,
        largeImageText: payload.largeImageText,
        instance: payload.instance ?? false,
      })
      .catch((err: Error) => {
        log.warn({ err: err.message }, 'rpc: setActivity failed');
      });
  }

  private handleDisconnect(): void {
    this.ready = false;
    this.client = null;
    if (this.destroyed) return;

    const min = this.options.reconnectMinMs ?? 5000;
    const max = this.options.reconnectMaxMs ?? 60_000;
    const delay = Math.min(max, min * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt++;
    const log = getLogger();
    log.info({ delayMs: delay, attempt: this.reconnectAttempt }, 'rpc: scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => undefined);
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function isFatalAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return FATAL_ERROR_FRAGMENTS.some((frag) => lower.includes(frag));
}
