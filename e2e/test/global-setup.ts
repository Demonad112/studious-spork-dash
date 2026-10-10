import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_PORT, DASHBOARD_URL, RELAY_PORT, RELAY_URL } from './ports.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const children: ChildProcess[] = [];
let state = '';

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

function wrangler(config: string, port: number, inspector: number, extra: string[]): void {
  const child = spawn(
    'corepack',
    [
      'pnpm',
      'exec',
      'wrangler',
      'dev',
      '-c',
      config,
      '--port',
      String(port),
      '--inspector-port',
      String(inspector),
      '--persist-to',
      join(state, String(port)),
      ...extra,
    ],
    {
      cwd: join(root, 'relay'),
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    },
  );
  children.push(child);
}

async function waitUp(url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${url} did not come up`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function setup(): Promise<void> {
  run('cargo', ['build', '--manifest-path', 'agent/Cargo.toml', '-p', 'agent-sim'], root);
  if (!existsSync(join(root, 'dashboard', 'dist', 'index.html'))) {
    run('corepack', ['pnpm', '--filter', '@remote-console/dashboard', 'build'], root);
  }
  state = mkdtempSync(join(tmpdir(), 'rc-e2e-'));
  wrangler('wrangler.relay.jsonc', RELAY_PORT, 9330, []);
  // The dev bypass is passed on the command line, never written into a tracked config.
  wrangler('wrangler.dashboard.jsonc', DASHBOARD_PORT, 9331, ['--var', 'ALLOW_DEV_AUTH:true']);
  await waitUp(RELAY_URL);
  await waitUp(DASHBOARD_URL);
}

export function teardown(): void {
  for (const c of children) {
    // Each wrangler is the leader of its own process group, so this reaches workerd as well.
    if (c.pid !== undefined) {
      try {
        process.kill(-c.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
  if (state !== '') rmSync(state, { recursive: true, force: true });
}
