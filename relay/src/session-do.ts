import { DurableObject } from 'cloudflare:workers';
import {
  ACTION_KINDS,
  Machine,
  PING_FRAME,
  PONG_FRAME,
  SUPPORTED_VERSIONS,
  decideAction,
  decodeFrame,
  encodeFrame,
} from '@remote-console/protocol';
import type {
  Action,
  ActionResult,
  ErrorCode,
  EventBody,
  EventFrame,
  Frame,
  RejectReason,
  SessionState,
  Snapshot,
} from '@remote-console/protocol';
import { agentAuthMessage, verifySignature } from './agent-auth.ts';
import { appendAudit, initAudit, readAudit } from './audit.ts';
import type { AuditCode, AuditRow } from './audit.ts';
import { now } from './clock.ts';
import { randomB64u } from './encoding.ts';
import { isWebSocketUpgrade } from './http.ts';

export const RING_SIZE = 64;
export const DEDUP_SIZE = 128;
export const ISSUED_PROMPTS = 32;
export const BUCKET_CAPACITY = 5;
export const BUCKET_PER_SECOND = 5;
export const MAX_BROWSERS = 3;
export const AUTH_DEADLINE_MS = 15_000;
export const NONCE_TTL_MS = 60_000;
/** How long the relay waits for the agent to answer its own resync before it stops waiting. */
export const RESYNC_WAIT_MS = 10_000;

const ACTION_ID = /^[A-Za-z0-9-]{8,64}$/;

type AgentStage = 'hello' | 'challenged' | 'verifying' | 'ready';
type Attachment =
  | {
      role: 'agent';
      installId: string;
      publicKey: string;
      stage: AgentStage;
      deadlineMs: number;
      sessionId?: string;
      nonce?: string;
      nonceExpMs?: number;
      replaced?: boolean;
    }
  | { role: 'browser'; stage: 'hello' | 'ready'; deadlineMs: number };

interface ArmedInfo {
  armed: boolean;
  expiresAtMs: number | null;
}

interface ResyncState {
  oldHead: number;
  sentMs: number;
  stage: 'awaiting-result' | 'awaiting-snapshot' | 'replaying';
  gap: boolean;
  snapSeq: number;
}

export interface SessionView {
  connected: boolean;
  armed: boolean;
  expiresAtMs: number | null;
  viewers: number;
  state: SessionState;
  locked: boolean;
  lastSeenMs: number | null;
}

function negotiate(versions: number[]): number | null {
  const common = versions.filter((v) => SUPPORTED_VERSIONS.includes(v));
  return common.length === 0 ? null : Math.max(...common);
}

/** One per install: the sockets, the stored session, the replay ring, the dedup set and the audit. */
export class SessionDO extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ring (seq INTEGER PRIMARY KEY, frame TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS dedup (ord INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL UNIQUE, result TEXT)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS issued (ord INTEGER PRIMARY KEY AUTOINCREMENT, prompt_id TEXT NOT NULL UNIQUE)`,
    );
    initAudit(sql);
  }

  // ---- storage helpers ---------------------------------------------------------------------

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private kvGet(key: string): string | null {
    const row = this.sql
      .exec<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, key)
      .toArray()[0];
    return row === undefined ? null : row.value;
  }

  private kvSet(key: string, value: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, key, value);
  }

  private kvDelete(key: string): void {
    this.sql.exec(`DELETE FROM kv WHERE key = ?`, key);
  }

  private kvNumber(key: string, fallback: number): number {
    const v = this.kvGet(key);
    return v === null ? fallback : Number(v);
  }

  private kvJson<T>(key: string, fallback: T): T {
    const v = this.kvGet(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  }

  private get head(): number {
    return this.kvNumber('head', 0);
  }

  private get locked(): boolean {
    return this.kvGet('locked') === '1';
  }

  private get armedInfo(): ArmedInfo {
    return this.kvJson<ArmedInfo>('armed', { armed: false, expiresAtMs: null });
  }

  private loadMachine(): Machine {
    const raw = this.kvGet('machine');
    return raw === null ? new Machine() : Machine.fromSnapshot(JSON.parse(raw) as Snapshot);
  }

  private saveMachine(m: Machine, head: number): void {
    this.kvSet('machine', JSON.stringify(m.snapshot(head, this.armedInfo.armed)));
  }

  private audit(code: AuditCode, detail = ''): void {
    appendAudit(this.sql, code, detail);
  }

  private resyncState(): ResyncState | null {
    const r = this.kvJson<ResyncState | null>('resync', null);
    if (r === null) return null;
    if (r.stage !== 'replaying' && now() - r.sentMs > RESYNC_WAIT_MS) {
      this.kvDelete('resync');
      return null;
    }
    return r;
  }

  // ---- socket helpers ----------------------------------------------------------------------

  private attachment(ws: WebSocket): Attachment | null {
    return ws.deserializeAttachment() as Attachment | null;
  }

  private send(ws: WebSocket, frame: Frame): void {
    try {
      ws.send(encodeFrame(frame));
    } catch {
      // The socket is gone; its close handler cleans up.
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode, fatal: boolean): void {
    this.send(ws, { v: 1, type: 'error', code, fatal });
    if (fatal) this.close(ws, 1008, code);
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private readySockets(role: 'agent' | 'browser', except?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets(role)
      .filter((w) => w !== except && this.attachment(w)?.stage === 'ready');
  }

  private agentSocket(except?: WebSocket): WebSocket | null {
    return this.readySockets('agent', except)[0] ?? null;
  }

  private viewerCount(except?: WebSocket): number {
    return this.readySockets('browser', except).length;
  }

  private broadcast(frame: Frame, except?: WebSocket): void {
    for (const b of this.readySockets('browser', except)) this.send(b, frame);
  }

  private armedFrame(viewers: number, agentUp: boolean): EventFrame {
    const a = this.armedInfo;
    return {
      v: 1,
      type: 'event',
      seq: 0,
      kind: 'armed-state',
      armed: agentUp && a.armed,
      expiresAtMs: a.expiresAtMs,
      viewers,
    };
  }

  /** Tells the agent how many dashboards watch, and the dashboards the merged armed state. */
  private announceArmed(except?: WebSocket): void {
    const viewers = this.viewerCount(except);
    const agent = this.agentSocket(except);
    if (agent !== null) this.send(agent, this.armedFrame(viewers, true));
    this.broadcast(this.armedFrame(viewers, agent !== null), except);
  }

  private async ensureAlarm(deadlineMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > deadlineMs) await this.ctx.storage.setAlarm(deadlineMs);
  }

  // ---- upgrade -----------------------------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    const role = req.headers.get('x-rc-role');
    if (!isWebSocketUpgrade(req) || (role !== 'agent' && role !== 'browser'))
      return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const deadlineMs = now() + AUTH_DEADLINE_MS;
    if (role === 'agent') {
      const att: Attachment = {
        role,
        installId: req.headers.get('x-rc-install') ?? '',
        publicKey: req.headers.get('x-rc-key') ?? '',
        stage: 'hello',
        deadlineMs,
      };
      this.ctx.acceptWebSocket(server, ['agent']);
      server.serializeAttachment(att);
      // The registry is the source of truth for the lock; a connect refreshes the copy kept here.
      this.kvSet('locked', req.headers.get('x-rc-locked') === '1' ? '1' : '0');
      if (this.locked) this.sendError(server, 'locked', true);
    } else {
      const crowded = this.ctx.getWebSockets('browser').length >= MAX_BROWSERS;
      this.ctx.acceptWebSocket(server, ['browser']);
      server.serializeAttachment({ role, stage: 'hello', deadlineMs } satisfies Attachment);
      if (crowded) this.sendError(server, 'too-many-connections', true);
    }
    await this.ensureAlarm(deadlineMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- socket events -----------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = this.attachment(ws);
    if (att === null) return this.close(ws, 1011, 'internal');
    if (typeof message !== 'string') return this.close(ws, 1003, 'text only');
    try {
      if (att.role === 'agent') await this.onAgentMessage(ws, att, message);
      else await this.onBrowserMessage(ws, att, message);
    } catch {
      this.sendError(ws, 'internal', true);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.onGone(ws);
    this.close(ws, 1000, 'closed');
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  async alarm(): Promise<void> {
    const t = now();
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att === null || att.stage === 'ready') continue;
      if (att.deadlineMs <= t) {
        if (att.role === 'agent') this.audit('auth-timeout');
        this.sendError(ws, 'unauthorized', true);
      } else next = next === null ? att.deadlineMs : Math.min(next, att.deadlineMs);
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  private onGone(ws: WebSocket): void {
    const att = this.attachment(ws);
    if (att === null || att.stage !== 'ready') return;
    if (att.role === 'agent') {
      if (att.replaced === true) return;
      this.audit('agent-disconnected');
      this.kvSet('lastSeen', String(now()));
      this.kvSet('armed', JSON.stringify({ armed: false, expiresAtMs: null }));
      this.saveMachine(this.loadMachine(), this.head);
      this.failInFlight();
      this.kvDelete('resync');
      this.broadcast(this.armedFrame(this.viewerCount(), false));
    } else {
      this.audit('browser-disconnected');
      this.announceArmed(ws);
    }
  }

  private failInFlight(): void {
    const rows = this.sql
      .exec<{ action_id: string }>(`SELECT action_id FROM dedup WHERE result IS NULL`)
      .toArray();
    for (const r of rows) {
      const result: ActionResult = {
        v: 1,
        type: 'action-result',
        actionId: r.action_id,
        outcome: 'rejected',
        reason: 'disarmed',
      };
      this.sql.exec(
        `UPDATE dedup SET result = ? WHERE action_id = ?`,
        JSON.stringify(result),
        r.action_id,
      );
      this.broadcast(result);
    }
  }

  // ---- agent -------------------------------------------------------------------------------

  private setAtt(ws: WebSocket, att: Attachment): void {
    ws.serializeAttachment(att);
  }

  private async onAgentMessage(
    ws: WebSocket,
    att: Extract<Attachment, { role: 'agent' }>,
    raw: string,
  ): Promise<void> {
    const decoded = decodeFrame(raw);
    if (!decoded.ok) return this.sendError(ws, decoded.error, true);
    const frame = decoded.frame;
    if (att.stage !== 'ready') return this.onAgentHandshake(ws, att, frame);
    switch (frame.type) {
      case 'event':
        return this.onAgentEvent(ws, frame);
      case 'resync-result':
        return this.onResyncResult(frame.toSeq, frame.gap);
      case 'snapshot':
        return this.onAgentSnapshot(frame);
      case 'action-result':
        return this.onActionResult(frame);
      case 'error':
        this.audit('agent-error', frame.code);
        return;
      case 'ping':
      case 'pong':
        return;
      default:
        return this.sendError(ws, 'malformed', true);
    }
  }

  private async onAgentHandshake(
    ws: WebSocket,
    att: Extract<Attachment, { role: 'agent' }>,
    frame: Frame,
  ): Promise<void> {
    if (att.stage === 'hello' && frame.type === 'hello') {
      if (frame.role !== 'agent' || frame.installId !== att.installId || att.publicKey === '')
        return this.sendError(ws, 'unauthorized', true);
      if (negotiate(frame.protocolVersions) === null)
        return this.sendError(ws, 'unsupported-version', true);
      if (this.locked) return this.sendError(ws, 'locked', true);
      const nonce = randomB64u(32);
      this.setAtt(ws, {
        ...att,
        stage: 'challenged',
        sessionId: frame.sessionId!,
        nonce,
        nonceExpMs: now() + NONCE_TTL_MS,
      });
      this.send(ws, { v: 1, type: 'auth-challenge', nonce });
      return;
    }
    if (att.stage === 'challenged' && frame.type === 'auth-response') {
      const { nonce, nonceExpMs, sessionId } = att;
      // The nonce is single use: burn it before the asynchronous check.
      this.setAtt(ws, { ...att, stage: 'verifying', nonce: undefined, nonceExpMs: undefined });
      if (nonce === undefined || nonceExpMs === undefined || now() > nonceExpMs)
        return this.failAuth(ws, 'expired');
      const good = await verifySignature(
        att.publicKey,
        agentAuthMessage(att.installId, sessionId!, nonce, frame.agentNonce),
        frame.signature,
      );
      if (!good) return this.failAuth(ws, 'bad-signature');
      if (this.locked) return this.sendError(ws, 'locked', true);
      this.completeAgentAuth(ws, att, sessionId!);
      return;
    }
    this.sendError(ws, 'malformed', true);
  }

  private failAuth(ws: WebSocket, detail: string): void {
    this.audit('auth-failed', detail);
    this.sendError(ws, detail === 'expired' ? 'expired' : 'unauthorized', true);
  }

  private completeAgentAuth(
    ws: WebSocket,
    att: Extract<Attachment, { role: 'agent' }>,
    sessionId: string,
  ): void {
    for (const old of this.ctx.getWebSockets('agent')) {
      if (old === ws) continue;
      const oa = this.attachment(old);
      if (oa === null || oa.role !== 'agent' || oa.stage !== 'ready') continue;
      this.setAtt(old, { ...oa, replaced: true });
      this.audit('agent-replaced');
      this.close(old, 1000, 'replaced');
    }
    this.setAtt(ws, { ...att, stage: 'ready', sessionId, nonce: undefined, nonceExpMs: undefined });
    if (this.kvGet('sessionId') !== sessionId) this.resetSession(sessionId);
    this.kvSet('armed', JSON.stringify({ armed: true, expiresAtMs: null }));
    this.kvSet('lastSeen', String(now()));
    this.saveMachine(this.loadMachine(), this.head);
    this.audit('agent-connected');
    this.send(ws, { v: 1, type: 'auth-ok', serverTimeMs: now() });
    this.kvSet(
      'resync',
      JSON.stringify({
        oldHead: this.head,
        sentMs: now(),
        stage: 'awaiting-result',
        gap: false,
        snapSeq: 0,
      } satisfies ResyncState),
    );
    this.send(ws, { v: 1, type: 'resync', lastSeq: this.head });
    this.announceArmed();
  }

  /** A hello with a new session id starts from nothing. The old terminal summary ends here. */
  private resetSession(sessionId: string): void {
    const hadSession = this.kvGet('sessionId') !== null;
    this.sql.exec(`DELETE FROM ring`);
    this.sql.exec(`DELETE FROM dedup`);
    this.sql.exec(`DELETE FROM issued`);
    this.kvDelete('resync');
    this.kvDelete('machine');
    this.kvSet('head', '0');
    this.kvSet('floor', '0');
    this.kvSet('sessionId', sessionId);
    if (hadSession) this.audit('session-reset');
    this.broadcast(this.loadMachine().snapshot(0, false));
  }

  private startResync(ws: WebSocket): void {
    this.audit('event-gap');
    this.kvSet(
      'resync',
      JSON.stringify({
        oldHead: this.head,
        sentMs: now(),
        stage: 'awaiting-result',
        gap: false,
        snapSeq: 0,
      } satisfies ResyncState),
    );
    this.send(ws, { v: 1, type: 'resync', lastSeq: this.head });
  }

  private onResyncResult(toSeq: number, gap: boolean): void {
    const r = this.resyncState();
    if (r === null || r.stage !== 'awaiting-result') return;
    this.kvSet('resync', JSON.stringify({ ...r, stage: 'awaiting-snapshot', gap, snapSeq: toSeq }));
  }

  /** The agent's snapshot after a resync is authoritative. */
  private onAgentSnapshot(snap: Snapshot): void {
    const r = this.resyncState();
    if (r === null || r.stage !== 'awaiting-snapshot') return;
    this.kvSet('armed', JSON.stringify({ ...this.armedInfo, armed: snap.armed }));
    const machine = Machine.fromSnapshot(snap);
    this.kvSet('head', String(snap.seq));
    this.saveMachine(machine, snap.seq);
    const replay = !r.gap && snap.seq > r.oldHead;
    if (r.gap) {
      this.sql.exec(`DELETE FROM ring`);
      this.kvSet('floor', String(snap.seq));
    }
    if (replay) {
      this.kvSet('resync', JSON.stringify({ ...r, stage: 'replaying', snapSeq: snap.seq }));
    } else {
      this.kvDelete('resync');
      this.broadcast(machine.snapshot(snap.seq, snap.armed));
    }
  }

  private onAgentEvent(ws: WebSocket, frame: EventFrame): void {
    this.kvSet('lastSeen', String(now()));
    if (frame.kind === 'armed-state') return this.onAgentArmedState(frame);
    const r = this.resyncState();
    if (r !== null && r.stage === 'replaying') {
      if (frame.seq > r.oldHead && frame.seq <= r.snapSeq && frame.kind !== 'progress') {
        // Replayed history: the snapshot already holds its effect, so only store and forward.
        this.ringAppend(frame);
        this.broadcast(frame);
        if (frame.seq >= r.snapSeq) this.kvDelete('resync');
        return;
      }
      if (frame.seq <= r.oldHead) return;
      this.kvDelete('resync');
    }
    const head = this.head;
    const waiting = this.resyncState() !== null;
    if (frame.kind === 'progress') {
      if (frame.seq < head) return;
      if (frame.seq > head) return waiting ? undefined : this.startResync(ws);
      this.applyEvent(frame, head, false);
      return;
    }
    if (frame.seq <= head) return;
    if (frame.seq > head + 1) return waiting ? undefined : this.startResync(ws);
    this.applyEvent(frame, frame.seq, true);
  }

  private onAgentArmedState(frame: Extract<EventFrame, { kind: 'armed-state' }>): void {
    const before = this.armedInfo;
    if (before.armed !== frame.armed) this.audit('armed-state', frame.armed ? 'armed' : 'disarmed');
    this.kvSet('armed', JSON.stringify({ armed: frame.armed, expiresAtMs: frame.expiresAtMs }));
    this.saveMachine(this.loadMachine(), this.head);
    this.broadcast(this.armedFrame(this.viewerCount(), this.agentSocket() !== null));
  }

  /** Applies a discrete or progress event to the stored machine and forwards it. */
  private applyEvent(frame: EventFrame, seq: number, discrete: boolean): void {
    const { v: _v, type: _t, seq: _s, ...body } = frame;
    const machine = this.loadMachine();
    const ok = machine.apply(body as EventBody);
    if (discrete) this.kvSet('head', String(seq));
    if (!ok) {
      this.audit('event-dropped', frame.kind);
      return;
    }
    this.saveMachine(machine, discrete ? seq : this.head);
    if (frame.kind === 'prompt-opened') {
      this.sql.exec(`INSERT OR IGNORE INTO issued (prompt_id) VALUES (?)`, frame.promptId);
      this.sql.exec(
        `DELETE FROM issued WHERE ord <= (SELECT MAX(ord) FROM issued) - ?`,
        ISSUED_PROMPTS,
      );
    }
    if (frame.kind === 'unknown') return;
    if (discrete) this.ringAppend(frame);
    this.broadcast(frame);
  }

  private ringAppend(frame: EventFrame): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO ring (seq, frame) VALUES (?, ?)`,
      frame.seq,
      encodeFrame(frame),
    );
    const over = this.sql
      .exec<{ seq: number }>(`SELECT seq FROM ring ORDER BY seq DESC LIMIT 1 OFFSET ?`, RING_SIZE)
      .toArray()[0];
    if (over !== undefined) {
      this.sql.exec(`DELETE FROM ring WHERE seq <= ?`, over.seq);
      this.kvSet('floor', String(Math.max(this.kvNumber('floor', 0), over.seq)));
    }
  }

  private onActionResult(frame: ActionResult): void {
    const row = this.sql
      .exec<{ result: string | null }>(
        `SELECT result FROM dedup WHERE action_id = ?`,
        frame.actionId,
      )
      .toArray()[0];
    if (row === undefined || row.result !== null) return;
    this.sql.exec(
      `UPDATE dedup SET result = ? WHERE action_id = ?`,
      JSON.stringify(frame),
      frame.actionId,
    );
    this.audit('action-result', frame.outcome === 'rejected' ? (frame.reason ?? '') : 'accepted');
    this.broadcast(frame);
  }

  // ---- browser -----------------------------------------------------------------------------

  private async onBrowserMessage(
    ws: WebSocket,
    att: Extract<Attachment, { role: 'browser' }>,
    raw: string,
  ): Promise<void> {
    const decoded = decodeFrame(raw);
    if (att.stage === 'hello') {
      if (!decoded.ok) return this.sendError(ws, decoded.error, true);
      const f = decoded.frame;
      if (f.type !== 'hello' || f.role !== 'browser') return this.sendError(ws, 'malformed', true);
      if (negotiate(f.protocolVersions) === null)
        return this.sendError(ws, 'unsupported-version', true);
      if (this.readySockets('browser').length >= MAX_BROWSERS)
        return this.sendError(ws, 'too-many-connections', true);
      this.setAtt(ws, { ...att, stage: 'ready' });
      this.audit('browser-connected');
      this.send(ws, { v: 1, type: 'auth-ok', serverTimeMs: now() });
      this.announceArmed();
      return;
    }
    if (!decoded.ok) {
      const answered = decoded.error !== 'frame-too-large' && this.answerUndecodable(ws, raw);
      if (!answered) this.sendError(ws, decoded.error, false);
      return;
    }
    const f = decoded.frame;
    switch (f.type) {
      case 'resync':
        return this.serveResync(ws, f.lastSeq);
      case 'action':
        return this.onBrowserAction(ws, f);
      case 'ping':
      case 'pong':
        return;
      default:
        return this.sendError(ws, 'malformed', false);
    }
  }

  /** An undecodable action with a usable id still gets an answer. Returns false when it has none. */
  private answerUndecodable(ws: WebSocket, raw: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    const o = parsed as Record<string, unknown>;
    if (o.type !== 'action' || typeof o.actionId !== 'string' || !ACTION_ID.test(o.actionId))
      return false;
    const unknownKind =
      typeof o.action === 'string' && !(ACTION_KINDS as readonly string[]).includes(o.action);
    this.reply(ws, o.actionId, unknownKind ? 'unknown-action' : 'malformed');
    return true;
  }

  private reply(ws: WebSocket, actionId: string, reason: RejectReason): void {
    this.audit('action-rejected', reason);
    this.send(ws, { v: 1, type: 'action-result', actionId, outcome: 'rejected', reason });
  }

  private serveResync(ws: WebSocket, lastSeq: number): void {
    const head = this.head;
    const floor = this.kvNumber('floor', 0);
    const gap = lastSeq < head && lastSeq < floor;
    const events =
      lastSeq >= head || gap
        ? []
        : this.sql
            .exec<{ frame: string }>(
              `SELECT frame FROM ring WHERE seq > ? ORDER BY seq ASC`,
              lastSeq,
            )
            .toArray();
    this.send(ws, {
      v: 1,
      type: 'resync-result',
      fromSeq: lastSeq >= head ? head + 1 : gap ? floor + 1 : lastSeq + 1,
      toSeq: head,
      gap,
    });
    const agentUp = this.agentSocket() !== null;
    this.send(ws, this.loadMachine().snapshot(head, agentUp && this.armedInfo.armed));
    for (const e of events) ws.send(e.frame);
    this.send(ws, this.armedFrame(this.viewerCount(), agentUp));
  }

  private takeToken(): boolean {
    const t = now();
    const b = this.kvJson<{ tokens: number; ts: number }>('bucket', {
      tokens: BUCKET_CAPACITY,
      ts: t,
    });
    const tokens = Math.min(BUCKET_CAPACITY, b.tokens + ((t - b.ts) / 1000) * BUCKET_PER_SECOND);
    const ok = tokens >= 1;
    this.kvSet('bucket', JSON.stringify({ tokens: ok ? tokens - 1 : tokens, ts: t }));
    return ok;
  }

  private storeResult(result: ActionResult, inFlight: boolean): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO dedup (action_id, result) VALUES (?, ?)`,
      result.actionId,
      inFlight ? null : JSON.stringify(result),
    );
    this.sql.exec(`DELETE FROM dedup WHERE ord <= (SELECT MAX(ord) FROM dedup) - ?`, DEDUP_SIZE);
  }

  private onBrowserAction(ws: WebSocket, action: Action): void {
    const id = action.actionId;
    if (this.locked) return this.reply(ws, id, 'locked');
    const agent = this.agentSocket();
    const armed = this.armedInfo;
    if (agent === null || !armed.armed) return this.reply(ws, id, 'disarmed');
    if (armed.expiresAtMs !== null && now() >= armed.expiresAtMs)
      return this.reply(ws, id, 'expired');
    const prior = this.sql
      .exec<{ result: string | null }>(`SELECT result FROM dedup WHERE action_id = ?`, id)
      .toArray()[0];
    if (prior !== undefined) {
      if (prior.result !== null) ws.send(prior.result);
      return;
    }
    const rejectStored = (reason: RejectReason): void => {
      const result: ActionResult = {
        v: 1,
        type: 'action-result',
        actionId: id,
        outcome: 'rejected',
        reason,
      };
      this.storeResult(result, false);
      this.audit('action-rejected', reason);
      this.send(ws, result);
    };
    if (!this.takeToken()) return rejectStored('rate-limited');
    const machine = this.loadMachine();
    const issued = new Set(
      this.sql
        .exec<{ prompt_id: string }>(`SELECT prompt_id FROM issued`)
        .toArray()
        .map((r) => r.prompt_id),
    );
    const reason = decideAction(action, machine.state, machine.prompt, (p) => issued.has(p));
    if (reason !== null) return rejectStored(reason);
    this.storeResult({ v: 1, type: 'action-result', actionId: id, outcome: 'accepted' }, true);
    this.audit('action-accepted', action.action);
    this.send(agent, action);
  }

  // ---- RPC ---------------------------------------------------------------------------------

  getView(): SessionView {
    const agentUp = this.agentSocket() !== null;
    const armed = this.armedInfo;
    const lastSeen = this.kvGet('lastSeen');
    return {
      connected: agentUp,
      armed: agentUp && armed.armed,
      expiresAtMs: armed.expiresAtMs,
      viewers: this.viewerCount(),
      state: this.loadMachine().state,
      locked: this.locked,
      lastSeenMs: lastSeen === null ? null : Number(lastSeen),
    };
  }

  getAudit(limit = 200): AuditRow[] {
    return readAudit(this.sql, limit);
  }

  recordAudit(code: AuditCode): void {
    this.audit(code);
  }

  /** The kill switch. Locking closes the agent socket and keeps the agent out until unlocked. */
  setLocked(locked: boolean): void {
    this.kvSet('locked', locked ? '1' : '0');
    if (locked) {
      for (const ws of this.ctx.getWebSockets('agent')) this.sendError(ws, 'locked', true);
    }
  }

  /** Closes the agent socket without locking, used when its key is rotated. */
  kickAgent(): void {
    for (const ws of this.ctx.getWebSockets('agent')) this.sendError(ws, 'unauthorized', true);
  }

  /** Forgets everything stored for this install. */
  wipe(): void {
    for (const ws of this.ctx.getWebSockets()) this.close(ws, 1000, 'removed');
    for (const t of ['kv', 'ring', 'dedup', 'issued', 'audit']) this.sql.exec(`DELETE FROM ${t}`);
  }
}
