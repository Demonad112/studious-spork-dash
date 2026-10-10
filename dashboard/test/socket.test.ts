import { describe, expect, it } from 'vitest';
import { LiveConnection, browserSocketUrl } from '../src/lib/socket.ts';
import type { SocketLike } from '../src/lib/socket.ts';
import type { Frame } from '@remote-console/protocol';

class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  receive(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  sentTypes(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type);
  }
}

function setup(lastSeq = 0) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const frames: Frame[] = [];
  const log = { connected: 0, disconnected: 0, fatal: 0 };
  let next = 0;
  const conn = new LiveConnection({
    installId: 'a'.repeat(32),
    lastSeq: () => lastSeq,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => {
      const id = (next += 1);
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    random: () => 0.5,
    handlers: {
      onConnected: () => (log.connected += 1),
      onDisconnected: () => (log.disconnected += 1),
      onFrame: (f) => frames.push(f),
      onFatal: () => (log.fatal += 1),
    },
  });
  return { conn, sockets, timers, frames, log };
}

const AUTH_OK = { v: 1, type: 'auth-ok', serverTimeMs: 1 };

describe('live connection', () => {
  it('builds a wss url for https and carries the install in the query', () => {
    expect(browserSocketUrl('abc', { protocol: 'https:', host: 'x.example' })).toBe(
      'wss://x.example/ws/browser?install=abc',
    );
    expect(browserSocketUrl('abc', { protocol: 'http:', host: 'localhost:1440' })).toBe(
      'ws://localhost:1440/ws/browser?install=abc',
    );
  });

  it('sends hello on open, then resync from the last seq once the relay accepts', () => {
    const t = setup(42);
    t.conn.start();
    const s = t.sockets[0]!;
    s.onopen?.({});
    expect(s.sentTypes()).toEqual(['hello']);
    s.receive(AUTH_OK);
    expect(s.sentTypes()).toEqual(['hello', 'resync']);
    expect(JSON.parse(s.sent[1]!)).toMatchObject({ lastSeq: 42 });
    expect(t.log.connected).toBe(1);
  });

  it('asks for only one resync until the snapshot arrives', () => {
    const t = setup();
    t.conn.start();
    const s = t.sockets[0]!;
    s.onopen?.({});
    s.receive(AUTH_OK);
    t.conn.requestResync();
    t.conn.requestResync();
    expect(s.sentTypes().filter((x) => x === 'resync')).toHaveLength(1);
    s.receive({
      v: 1,
      type: 'snapshot',
      seq: 0,
      armed: false,
      state: 'idle',
      jobId: null,
      jobKind: null,
      progress: null,
      prompt: null,
      terminal: null,
    });
    t.conn.requestResync();
    expect(s.sentTypes().filter((x) => x === 'resync')).toHaveLength(2);
  });

  it('drops a frame the strict decoder rejects', () => {
    const t = setup();
    t.conn.start();
    const s = t.sockets[0]!;
    s.onopen?.({});
    s.onmessage?.({ data: '{"v":1,"type":"action-result","actionId":"x"}' });
    s.onmessage?.({ data: 'not json' });
    expect(t.frames).toHaveLength(0);
  });

  it('reconnects with backoff after a drop and resets it after auth-ok', () => {
    const t = setup();
    t.conn.start();
    t.sockets[0]!.close();
    expect(t.log.disconnected).toBe(1);
    const retry = t.timers.find((x) => x.ms >= 500 && x.ms <= 1500)!;
    expect(retry).toBeDefined();
    retry.fn();
    expect(t.sockets).toHaveLength(2);
    t.sockets[1]!.onopen?.({});
    t.sockets[1]!.receive(AUTH_OK);
    t.sockets[1]!.close();
    expect(t.timers.some((x) => x.ms >= 500 && x.ms <= 1500)).toBe(true);
  });

  it('a fatal error stops retrying and tells the handler', () => {
    const t = setup();
    t.conn.start();
    const s = t.sockets[0]!;
    s.onopen?.({});
    s.receive({ v: 1, type: 'error', code: 'unsupported-version', fatal: true });
    s.close();
    expect(t.log.fatal).toBe(1);
    expect(t.timers.every((x) => x.ms < 25_000 || x.ms > 25_000)).toBe(true);
    expect(t.sockets).toHaveLength(1);
  });

  it('a full viewer limit retries slowly instead of giving up', () => {
    const t = setup();
    t.conn.start();
    const s = t.sockets[0]!;
    s.onopen?.({});
    s.receive({ v: 1, type: 'error', code: 'too-many-connections', fatal: true });
    s.close();
    expect(t.timers.some((x) => x.ms === 30_000)).toBe(true);
    expect(t.log.fatal).toBe(0);
  });

  it('sends an action only while the socket is open and returns its id', () => {
    const t = setup();
    t.conn.start();
    const s = t.sockets[0]!;
    s.onopen?.({});
    s.receive(AUTH_OK);
    const id = t.conn.sendAction('done', 'b'.repeat(32));
    expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(JSON.parse(s.sent.at(-1)!)).toMatchObject({
      type: 'action',
      action: 'done',
      promptId: 'b'.repeat(32),
      actionId: id,
    });
    s.readyState = 3;
    expect(t.conn.sendAction('cancel')).toBeNull();
  });

  it('stop closes the socket and schedules nothing', () => {
    const t = setup();
    t.conn.start();
    t.conn.stop();
    expect(t.timers).toHaveLength(0);
    expect(t.log.disconnected).toBe(0);
  });
});
