import { env } from 'cloudflare:workers';
import { SUPPORTED_VERSIONS, decodePairing } from '@remote-console/protocol';
import { SignJWT, generateKeyPair } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { agentAuthMessage, pairStatusMessage } from '../src/agent-auth.ts';
import { b64uEncode, randomB64u } from '../src/encoding.ts';
import { createDashboardHandler } from '../src/dashboard-worker.ts';
import { createRelayHandler } from '../src/relay-worker.ts';
import { registryStub, sessionStub } from '../src/stubs.ts';

export const testEnv = env as Cloudflare.Env;
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

export type Json = Record<string, any>;

/** A WebSocket client that records every frame it receives. */
export class Client {
  inbox: Json[] = [];
  closed: { code: number; reason: string } | null = null;
  /** The resync the relay sent right after auth-ok, for agent clients. */
  resyncSeen: Json | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (e) => {
      this.inbox.push(JSON.parse(e.data as string) as Json);
      this.wake();
    });
    ws.addEventListener('close', (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  send(frame: Json | string): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** Takes the oldest frame matching the predicate, waiting up to two seconds for it. */
  async next(match: (f: Json) => boolean = () => true): Promise<Json> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const i = this.inbox.findIndex(match);
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      if (Date.now() > deadline) throw new Error(`timed out; inbox=${JSON.stringify(this.inbox)}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  nextType(type: string): Promise<Json> {
    return this.next((f) => f.type === type);
  }

  nextEvent(kind: string): Promise<Json> {
    return this.next((f) => f.type === 'event' && f.kind === kind);
  }

  /** Like drain, but ignores the relay's own armed-state announcements. */
  async quiet(ms = 80): Promise<Json[]> {
    return (await this.drain(ms)).filter((f) => !(f.type === 'event' && f.kind === 'armed-state'));
  }

  /** Waits briefly and returns whatever arrived, for asserting that nothing did. */
  async drain(ms = 80): Promise<Json[]> {
    await new Promise((r) => setTimeout(r, ms));
    const out = this.inbox;
    this.inbox = [];
    return out;
  }

  async waitClosed(): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + 2000;
    while (this.closed === null) {
      if (Date.now() > deadline) throw new Error('socket did not close');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return this.closed;
  }
}

export interface AgentKeys {
  installId: string;
  publicKey: string;
  sign(message: string): Promise<string>;
}

export async function newAgentKeys(): Promise<AgentKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const installId = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return {
    installId,
    publicKey: b64uEncode(raw),
    async sign(message) {
      const sig = await crypto.subtle.sign(
        { name: 'Ed25519' },
        pair.privateKey,
        new TextEncoder().encode(message),
      );
      return b64uEncode(new Uint8Array(sig));
    },
  };
}

export const relay = createRelayHandler();

export function relayFetch(path: string, init?: RequestInit): Promise<Response> {
  return relay.fetch!(
    new Request(`https://relay.test${path}`, init) as never,
    testEnv,
    ctx,
  ) as Promise<Response>;
}

export function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return relayFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Pairs and approves an install directly through the Registry, returning its keys. */
export async function enroll(name = 'Test PC', keys?: AgentKeys): Promise<AgentKeys> {
  const k = keys ?? (await newAgentKeys());
  const started = await registryStub(testEnv).pairStart(
    k.installId,
    k.publicKey,
    'iphash-' + k.installId,
  );
  if (!started.ok) throw new Error(`pairStart failed: ${started.error}`);
  const ok = await registryStub(testEnv).approve(started.pairingCode, name, true);
  if (!ok) throw new Error('approve failed');
  return k;
}

export async function openAgentSocket(installId: string): Promise<Client> {
  const res = await relayFetch(`/agent/ws?install=${installId}`, {
    headers: { upgrade: 'websocket' },
  });
  if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
  return new Client(res.webSocket);
}

export function agentHello(keys: AgentKeys, sessionId: string): Json {
  return {
    v: 1,
    type: 'hello',
    role: 'agent',
    protocolVersions: [...SUPPORTED_VERSIONS],
    installId: keys.installId,
    sessionId,
    appId: 'sim',
    agentVersion: '0.1.0',
  };
}

export const SESSION_A = 'a'.repeat(32);
export const SESSION_B = 'b'.repeat(32);

/** Connects and authenticates an agent, then answers the relay's resync as an agent with no history. */
export async function connectAgent(
  keys: AgentKeys,
  sessionId = SESSION_A,
  opts: { settle?: boolean } = {},
): Promise<Client> {
  const c = await openAgentSocket(keys.installId);
  c.send(agentHello(keys, sessionId));
  const challenge = await c.nextType('auth-challenge');
  const agentNonce = randomB64u(32);
  c.send({
    v: 1,
    type: 'auth-response',
    agentNonce,
    signature: await keys.sign(
      agentAuthMessage(keys.installId, sessionId, challenge.nonce, agentNonce),
    ),
  });
  await c.nextType('auth-ok');
  const resync = await c.nextType('resync');
  c.resyncSeen = resync;
  if (opts.settle !== false) settleResync(c, resync.lastSeq);
  return c;
}

/** Answers a resync the way an agent with nothing to replay does. */
export function settleResync(c: Client, headSeq: number, state: Json = {}): void {
  c.send({ v: 1, type: 'resync-result', fromSeq: headSeq + 1, toSeq: headSeq, gap: false });
  c.send(snapshot(headSeq, state));
}

export function snapshot(seq: number, over: Json = {}): Json {
  return {
    v: 1,
    type: 'snapshot',
    seq,
    armed: true,
    state: 'idle',
    jobId: null,
    jobKind: null,
    progress: null,
    prompt: null,
    terminal: null,
    ...over,
  };
}

export const JOB_ID = 'c'.repeat(32);

export function event(seq: number, body: Json): Json {
  return { v: 1, type: 'event', seq, ...body };
}

export const jobStarted = (seq: number): Json =>
  event(seq, { kind: 'job-started', jobId: JOB_ID, jobKind: 'simulated' });
export const promptOpened = (seq: number, promptId = 'p1', expects = 'done'): Json =>
  event(seq, {
    kind: 'prompt-opened',
    promptId,
    expects,
    labelId: 'finish-and-check',
    blocking: true,
  });
export const promptClosed = (seq: number, promptId = 'p1', reason = 'answered-remote'): Json =>
  event(seq, { kind: 'prompt-closed', promptId, reason });
export const progressEvent = (seq: number, over: Json = {}): Json =>
  event(seq, {
    kind: 'progress',
    step: 'copying',
    percent: 10,
    filesDone: 1,
    filesTotal: 10,
    bytesDone: 100,
    bytesTotal: 1000,
    ok: 1,
    skipped: 0,
    failed: 0,
    ...over,
  });
export const statusEvent = (seq: number, status = 'completed', over: Json = {}): Json =>
  event(seq, { kind: 'status', status, ...over });

// ---- browser side ---------------------------------------------------------------------------

export const TEAM = 'team.cloudflareaccess.com';
export const AUD = 'test-aud-tag';
export const OWNER = 'owner@example.com';

export interface AccessKit {
  handler: ExportedHandler<Cloudflare.Env>;
  env: Cloudflare.Env;
  token(opts?: {
    email?: string;
    aud?: string;
    issuer?: string;
    expSeconds?: number;
  }): Promise<string>;
  fetch(path: string, init?: RequestInit & { token?: string | null }): Promise<Response>;
  /** A token signed by a key the handler does not trust. */
  rogueToken(): Promise<string>;
}

let keyPairs: Promise<[CryptoKeyPair, CryptoKeyPair]> | null = null;
function accessKeys(): Promise<[CryptoKeyPair, CryptoKeyPair]> {
  keyPairs ??= Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]) as never;
  return keyPairs;
}

export async function accessKit(extraEnv: Partial<Cloudflare.Env> = {}): Promise<AccessKit> {
  const [{ publicKey, privateKey }, rogue] = await accessKeys();
  const jwks: JWTVerifyGetKey = async () => publicKey;
  const handler = createDashboardHandler({ jwks });
  const dashEnv = {
    REGISTRY: testEnv.REGISTRY,
    SESSION: testEnv.SESSION,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_EMAILS: OWNER,
    ...extraEnv,
  } as Cloudflare.Env;
  const sign = (
    key: CryptoKey,
    o: { email?: string; aud?: string; issuer?: string; expSeconds?: number } = {},
  ) =>
    new SignJWT({ email: o.email ?? OWNER })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(o.issuer ?? `https://${TEAM}`)
      .setAudience(o.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (o.expSeconds ?? 300))
      .sign(key);
  return {
    handler,
    env: dashEnv,
    token: (o) => sign(privateKey, o),
    rogueToken: () => sign(rogue.privateKey),
    async fetch(path, init = {}) {
      const { token, ...rest } = init;
      const headers = new Headers(rest.headers);
      const t = token === undefined ? await sign(privateKey) : token;
      if (t !== null) headers.set('cf-access-jwt-assertion', t);
      if (rest.method === 'POST' && !headers.has('origin'))
        headers.set('origin', 'https://dash.test');
      return handler.fetch!(
        new Request(`https://dash.test${path}`, { ...rest, headers }) as never,
        dashEnv,
        ctx,
      ) as Promise<Response>;
    },
  };
}

export async function openBrowserSocket(kit: AccessKit, installId: string): Promise<Client> {
  const res = await kit.fetch(`/ws/browser?install=${installId}`, {
    headers: { upgrade: 'websocket', origin: 'https://dash.test' },
  });
  if (res.status !== 101 || !res.webSocket)
    throw new Error(`browser upgrade failed: ${res.status}`);
  return new Client(res.webSocket);
}

/** Attaches a browser: hello, auth-ok, resync from `lastSeq`, and waits for the snapshot. */
export async function attachBrowser(
  kit: AccessKit,
  installId: string,
  lastSeq = 0,
): Promise<Client> {
  const c = await openBrowserSocket(kit, installId);
  c.send({ v: 1, type: 'hello', role: 'browser', protocolVersions: [1] });
  await c.nextType('auth-ok');
  c.send({ v: 1, type: 'resync', lastSeq });
  await c.nextType('resync-result');
  await c.nextType('snapshot');
  return c;
}

export function actionFrame(id: string, action: string, promptId?: string): Json {
  return { v: 1, type: 'action', actionId: id, action, ...(promptId ? { promptId } : {}) };
}

export { sessionStub, registryStub, decodePairing, pairStatusMessage };
