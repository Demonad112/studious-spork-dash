import { PING_FRAME, decodeFrame, encodeFrame } from '@remote-console/protocol';
import type { Action, ActionKind, Frame } from '@remote-console/protocol';

export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export interface LiveHandlers {
  /** The socket is open and the relay accepted the hello. */
  onConnected(): void;
  /** The socket dropped; a retry is scheduled. */
  onDisconnected(): void;
  onFrame(frame: Frame): void;
  /** The relay will not accept this client (fatal error frame). No retry follows. */
  onFatal(): void;
}

export interface LiveOptions {
  installId: string;
  /** Last discrete seq the view holds, asked for on every (re)connect. */
  lastSeq: () => number;
  handlers: LiveHandlers;
  createSocket?: (url: string) => SocketLike;
  /** Injected so tests need no real timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  random?: () => number;
}

const OPEN = 1;
const PING_EVERY_MS = 25_000;
const SILENCE_MS = 75_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A slow retry for the cap on viewers: someone else's tab will close eventually. */
const CROWDED_MS = 30_000;

export function browserSocketUrl(
  installId: string,
  loc: Pick<Location, 'protocol' | 'host'>,
): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/ws/browser?install=${encodeURIComponent(installId)}`;
}

/**
 * The browser end of the relay socket: hello, resync from the last seq, a keepalive, and
 * reconnect with backoff. Frames pass through the shared strict decoder before anyone sees them.
 */
export class LiveConnection {
  private socket: SocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: unknown = null;
  private keepalive: unknown = null;
  private silence: unknown = null;
  private awaitingSnapshot = false;
  private crowded = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(private readonly opts: LiveOptions) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as number));
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearAll();
    const s = this.socket;
    this.socket = null;
    if (s !== null) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      s.close(1000);
    }
  }

  /** Sends an action frame. Returns its id, or null when the socket is not open. */
  sendAction(action: ActionKind, promptId?: string): string | null {
    const s = this.socket;
    if (s === null || s.readyState !== OPEN) return null;
    const actionId = crypto.randomUUID();
    const frame: Action = { v: 1, type: 'action', actionId, action };
    if (promptId !== undefined) frame.promptId = promptId;
    s.send(encodeFrame(frame));
    return actionId;
  }

  /** Asks the relay for a snapshot and the events after `lastSeq`. Collapses duplicate asks. */
  requestResync(): void {
    if (this.awaitingSnapshot) return;
    const s = this.socket;
    if (s === null || s.readyState !== OPEN) return;
    this.awaitingSnapshot = true;
    s.send(encodeFrame({ v: 1, type: 'resync', lastSeq: this.opts.lastSeq() }));
  }

  private open(): void {
    const make = this.opts.createSocket ?? ((url: string) => new WebSocket(url) as SocketLike);
    const s = make(browserSocketUrl(this.opts.installId, location));
    this.socket = s;
    this.awaitingSnapshot = false;
    s.onopen = () => {
      s.send(encodeFrame({ v: 1, type: 'hello', role: 'browser', protocolVersions: [1] }));
      this.armSilence();
    };
    s.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      this.armSilence();
      const decoded = decodeFrame(ev.data);
      if (!decoded.ok) return;
      this.onFrame(decoded.frame);
    };
    s.onclose = () => this.onClose(s);
    s.onerror = () => {
      // The close event that follows does the work.
    };
  }

  private onFrame(frame: Frame): void {
    switch (frame.type) {
      case 'auth-ok':
        this.attempt = 0;
        this.keepalive = this.setTimer(() => this.ping(), PING_EVERY_MS);
        this.opts.handlers.onFrame(frame);
        this.opts.handlers.onConnected();
        this.requestResync();
        return;
      case 'snapshot':
        this.awaitingSnapshot = false;
        this.opts.handlers.onFrame(frame);
        return;
      case 'error':
        this.opts.handlers.onFrame(frame);
        if (frame.fatal) {
          if (frame.code === 'too-many-connections') this.crowded = true;
          else {
            this.stopped = true;
            this.clearAll();
            this.opts.handlers.onFatal();
          }
        }
        return;
      case 'pong':
        return;
      default:
        this.opts.handlers.onFrame(frame);
    }
  }

  private ping(): void {
    const s = this.socket;
    if (s !== null && s.readyState === OPEN) s.send(PING_FRAME);
    this.keepalive = this.setTimer(() => this.ping(), PING_EVERY_MS);
  }

  private armSilence(): void {
    if (this.silence !== null) this.clearTimer(this.silence);
    this.silence = this.setTimer(() => this.socket?.close(), SILENCE_MS);
  }

  private onClose(closed: SocketLike): void {
    if (this.socket !== closed) return;
    this.socket = null;
    this.clearAll();
    if (this.stopped) return;
    this.opts.handlers.onDisconnected();
    if (this.crowded) {
      this.crowded = false;
      this.retryIn(CROWDED_MS);
      return;
    }
    this.attempt += 1;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.attempt - 1));
    this.retryIn(base * (0.75 + 0.5 * (this.opts.random ?? Math.random)()));
  }

  private retryIn(ms: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.stopped) this.open();
    }, ms);
  }

  private clearAll(): void {
    for (const t of [this.keepalive, this.silence]) if (t !== null) this.clearTimer(t);
    this.keepalive = this.silence = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
