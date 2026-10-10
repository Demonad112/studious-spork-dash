import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import WebSocket from 'ws';
import { DASHBOARD_PORT, DASHBOARD_URL, RELAY_PORT } from './ports.ts';

export type Json = Record<string, any>;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIM = join(
  root,
  'agent',
  'target',
  'debug',
  process.platform === 'win32' ? 'agent-sim.exe' : 'agent-sim',
);
const ORIGIN = { Origin: DASHBOARD_URL };

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls until the condition holds. Real time, because the relay and the simulator are real. */
export async function until<T>(
  what: string,
  fn: () => T | undefined | false,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

export async function api(path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${DASHBOARD_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { ...ORIGIN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** A stand-in for the browser: the same hello, resync and action frames the dashboard sends. */
export class Browser {
  readonly frames: Json[] = [];
  closed: number | null = null;
  private ws!: WebSocket;

  constructor(private readonly installId: string) {}

  async connect(lastSeq: number): Promise<void> {
    this.closed = null;
    this.ws = new WebSocket(
      `ws://localhost:${DASHBOARD_PORT}/ws/browser?install=${this.installId}`,
      { headers: ORIGIN },
    );
    this.ws.on('message', (data) => this.frames.push(JSON.parse(String(data)) as Json));
    this.ws.on('close', (code) => (this.closed = code));
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.send({ v: 1, type: 'hello', role: 'browser', protocolVersions: [1] });
    await this.waitFor('auth-ok', (f) => f.type === 'auth-ok');
    this.send({ v: 1, type: 'resync', lastSeq });
    await this.waitFor('snapshot', (f) => f.type === 'snapshot');
  }

  send(frame: Json): void {
    this.ws.send(JSON.stringify(frame));
  }

  action(action: string, promptId?: string, actionId: string = crypto.randomUUID()): string {
    this.send({
      v: 1,
      type: 'action',
      actionId,
      action,
      ...(promptId === undefined ? {} : { promptId }),
    });
    return actionId;
  }

  /** Waits for a frame the test has not looked at yet that matches. Frames stay in `frames`. */
  async waitFor(what: string, match: (f: Json) => boolean, ms = 15_000): Promise<Json> {
    return until(what, () => this.frames.find(match), ms);
  }

  result(actionId: string): Promise<Json> {
    return this.waitFor(
      `result of ${actionId}`,
      (f) => f.type === 'action-result' && f.actionId === actionId,
    );
  }

  event(kind: string, match: (f: Json) => boolean = () => true): Promise<Json> {
    return this.waitFor(`${kind} event`, (f) => f.type === 'event' && f.kind === kind && match(f));
  }

  events(kind?: string): Json[] {
    return this.frames.filter((f) => f.type === 'event' && (kind === undefined || f.kind === kind));
  }

  /** The newest discrete seq seen, as the dashboard would resume from. */
  lastSeq(): number {
    let seq = 0;
    for (const f of this.frames) {
      if (f.type === 'snapshot' || (f.type === 'event' && f.kind !== 'progress')) {
        seq = Math.max(seq, f.seq as number);
      }
    }
    return seq;
  }

  close(): void {
    this.ws?.close(1000);
  }
}

/** One enrolled install: its own data folder, its own key, paired through the real HTTP flow. */
export class Install {
  private constructor(
    readonly installId: string,
    readonly dataDir: string,
  ) {}

  static async pair(displayName = 'e2e'): Promise<Install> {
    const dataDir = mkdtempSync(join(tmpdir(), 'rc-e2e-agent-'));
    const before = new Set(
      ((await api('/api/installs')).body.installs as Json[]).map((i) => i.installId),
    );
    const pair = spawn(SIM, [
      'pair',
      '--relay',
      `ws://localhost:${RELAY_PORT}`,
      '--data-dir',
      dataDir,
    ]);
    let out = '';
    pair.stdout.on('data', (d) => (out += String(d)));
    const code = await until('a pairing code', () => /Pairing code : ([0-9A-Z]{8})/.exec(out)?.[1]);
    const approved = await api('/api/pair/approve', {
      kind: 'pair-approve',
      pairingCode: code,
      displayName,
      approve: true,
    });
    if (approved.status !== 200) throw new Error(`approve answered ${approved.status}`);
    await new Promise<void>((resolve, reject) => {
      pair.once('exit', (c) => (c === 0 ? resolve() : reject(new Error(`pair exited ${c}`))));
    });
    const list = (await api('/api/installs')).body.installs as Json[];
    const mine = list.find((i) => !before.has(i.installId));
    if (mine === undefined) throw new Error('the new install is not listed');
    return new Install(mine.installId as string, dataDir);
  }

  /** Starts `agent-sim run <script>`. */
  run(script: string): Agent {
    return new Agent(
      spawn(SIM, [
        'run',
        script,
        '--relay',
        `ws://localhost:${RELAY_PORT}`,
        '--data-dir',
        this.dataDir,
      ]),
    );
  }

  cleanup(): void {
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

export class Agent {
  output = '';
  exitCode: number | null = null;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on('data', (d) => (this.output += String(d)));
    child.stderr?.on('data', (d) => (this.output += String(d)));
    child.on('exit', (c) => (this.exitCode = c ?? -1));
  }

  async exited(ms = 30_000): Promise<number> {
    return until('the agent to exit', () => this.exitCode ?? undefined, ms);
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** Pairs a fresh install, optionally attaches a browser, then starts a simulator script. */
export async function start(script: string, opts: { watchFirst?: boolean } = {}) {
  const install = await Install.pair();
  const browser = new Browser(install.installId);
  if (opts.watchFirst !== false) await browser.connect(0);
  const agent = install.run(script);
  cleanups.push(() => {
    agent.kill();
    browser.close();
    install.cleanup();
  });
  return { install, browser, agent };
}
