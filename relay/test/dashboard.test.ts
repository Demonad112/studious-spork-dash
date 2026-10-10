import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUDIT_CAP, appendAudit } from '../src/audit.ts';
import { createDashboardHandler } from '../src/dashboard-worker.ts';
import {
  AUD,
  OWNER,
  TEAM,
  accessKit,
  connectAgent,
  enroll,
  newAgentKeys,
  registryStub,
  sessionStub,
  testEnv,
} from './helpers.ts';

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };

describe('Access JWT verification', () => {
  it('a request with no assertion is refused on every route including assets', async () => {
    const kit = await accessKit();
    for (const path of [
      '/',
      '/index.html',
      '/api/installs',
      '/ws/browser?install=' + 'a'.repeat(32),
    ]) {
      const res = await kit.fetch(path, { token: null });
      expect(res.status, path).toBe(401);
    }
  });

  it('a valid assertion for the owner is accepted', async () => {
    const kit = await accessKit();
    expect((await kit.fetch('/api/installs')).status).toBe(200);
  });

  it('an assertion signed by an untrusted key is refused', async () => {
    const kit = await accessKit();
    expect((await kit.fetch('/api/installs', { token: await kit.rogueToken() })).status).toBe(401);
  });

  it('an assertion for another audience is refused', async () => {
    const kit = await accessKit();
    const token = await kit.token({ aud: 'someone-else' });
    expect((await kit.fetch('/api/installs', { token })).status).toBe(401);
  });

  it('an assertion from another issuer is refused', async () => {
    const kit = await accessKit();
    const token = await kit.token({ issuer: 'https://evil.cloudflareaccess.com' });
    expect((await kit.fetch('/api/installs', { token })).status).toBe(401);
  });

  it('an expired assertion is refused', async () => {
    const kit = await accessKit();
    const token = await kit.token({ expSeconds: -60 });
    expect((await kit.fetch('/api/installs', { token })).status).toBe(401);
  });

  it('an email that is not on the allow list is refused', async () => {
    const kit = await accessKit();
    const token = await kit.token({ email: 'stranger@example.com' });
    expect((await kit.fetch('/api/installs', { token })).status).toBe(401);
  });

  it('the email match ignores case', async () => {
    const kit = await accessKit();
    const token = await kit.token({ email: OWNER.toUpperCase() });
    expect((await kit.fetch('/api/installs', { token })).status).toBe(200);
  });

  it('missing configuration fails closed even with a good token', async () => {
    for (const missing of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ALLOWED_EMAILS'] as const) {
      const kit = await accessKit({ [missing]: '' });
      expect((await kit.fetch('/api/installs')).status, missing).toBe(401);
    }
    expect(TEAM).toBeTruthy();
    expect(AUD).toBeTruthy();
  });
});

describe('development bypass', () => {
  const handler = createDashboardHandler();
  const call = (url: string, vars: Record<string, string>) =>
    handler.fetch!(
      new Request(url) as never,
      { ...testEnv, ...vars } as never,
      {} as never,
    ) as Promise<Response>;

  it('the bypass works only with the variable set and a loopback host', async () => {
    expect(
      (await call('http://localhost:8787/api/installs', { ALLOW_DEV_AUTH: 'true' })).status,
    ).toBe(200);
    expect(
      (await call('http://127.0.0.1:8787/api/installs', { ALLOW_DEV_AUTH: 'true' })).status,
    ).toBe(200);
  });

  it('the variable alone does not open a public host', async () => {
    expect(
      (await call('https://console.example.com/api/installs', { ALLOW_DEV_AUTH: 'true' })).status,
    ).toBe(401);
  });

  it('a loopback host alone does not open the dashboard', async () => {
    expect((await call('http://localhost:8787/api/installs', {})).status).toBe(401);
    expect(
      (await call('http://localhost:8787/api/installs', { ALLOW_DEV_AUTH: 'false' })).status,
    ).toBe(401);
  });
});

describe('request hygiene', () => {
  it('every response carries the security headers', async () => {
    const kit = await accessKit();
    for (const res of [
      await kit.fetch('/api/installs'),
      await kit.fetch('/api/installs', { token: null }),
    ]) {
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('a mutating request without an Origin header is refused', async () => {
    const kit = await accessKit();
    const res = await kit.fetch('/api/pair/lookup', {
      ...JSON_POST,
      headers: { 'content-type': 'application/json', origin: '' },
    });
    expect(res.status).toBe(403);
  });

  it('a mutating request from another origin is refused', async () => {
    const kit = await accessKit();
    const res = await kit.fetch('/api/pair/lookup', {
      ...JSON_POST,
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('a mutating request that is not JSON is refused', async () => {
    const kit = await accessKit();
    const res = await kit.fetch('/api/pair/lookup', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('a websocket upgrade from another origin is refused', async () => {
    const kit = await accessKit();
    const keys = await enroll();
    const res = await kit.fetch(`/ws/browser?install=${keys.installId}`, {
      headers: { upgrade: 'websocket', origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('a websocket upgrade for an unknown install is not found', async () => {
    const kit = await accessKit();
    const res = await kit.fetch(`/ws/browser?install=${'e'.repeat(32)}`, {
      headers: { upgrade: 'websocket', origin: 'https://dash.test' },
    });
    expect(res.status).toBe(404);
  });

  it('static assets are served through the same checks when an asset binding exists', async () => {
    const assets = {
      fetch: async () =>
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    };
    const kit = await accessKit({ ASSETS: assets as never });
    const res = await kit.fetch('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await kit.fetch('/', { token: null })).status).toBe(401);
  });

  it('a method other than GET or POST on the API is refused', async () => {
    const kit = await accessKit();
    expect((await kit.fetch('/api/installs', { method: 'DELETE' })).status).toBe(405);
  });
});

describe('install management', () => {
  async function post(kit: Awaited<ReturnType<typeof accessKit>>, path: string, body: unknown) {
    return kit.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('the install list shows the fingerprint, never the public key', async () => {
    const kit = await accessKit();
    const keys = await enroll('Front desk');
    const body = (await (await kit.fetch('/api/installs')).json()) as {
      installs: Record<string, unknown>[];
    };
    const mine = body.installs.find((i) => i.installId === keys.installId)!;
    expect(mine.displayName).toBe('Front desk');
    expect(mine.fingerprint).toMatch(/^([0-9a-f]{4}-){3}[0-9a-f]{4}$/);
    expect(JSON.stringify(body)).not.toContain(keys.publicKey);
  });

  it('the list reports live status for a connected agent', async () => {
    const kit = await accessKit();
    const keys = await enroll();
    await connectAgent(keys);
    const body = (await (await kit.fetch('/api/installs')).json()) as {
      installs: { installId: string; live: { connected: boolean; armed: boolean } }[];
    };
    expect(body.installs.find((i) => i.installId === keys.installId)!.live).toMatchObject({
      connected: true,
      armed: true,
    });
  });

  it('an install can be renamed and a bad name is refused', async () => {
    const kit = await accessKit();
    const keys = await enroll();
    expect(
      (await post(kit, `/api/installs/${keys.installId}/rename`, { displayName: 'Back office' }))
        .status,
    ).toBe(200);
    expect((await registryStub(testEnv).getInstall(keys.installId))!.displayName).toBe(
      'Back office',
    );
    expect(
      (await post(kit, `/api/installs/${keys.installId}/rename`, { displayName: '' })).status,
    ).toBe(400);
    expect(
      (await post(kit, `/api/installs/${keys.installId}/rename`, { displayName: 'a\nb' })).status,
    ).toBe(400);
  });

  it('deleting an install removes it and its stored session', async () => {
    const kit = await accessKit();
    const keys = await enroll();
    await connectAgent(keys);
    expect((await post(kit, `/api/installs/${keys.installId}/delete`, {})).status).toBe(200);
    expect(await registryStub(testEnv).getInstall(keys.installId)).toBeNull();
    expect((await post(kit, `/api/installs/${keys.installId}/delete`, {})).status).toBe(404);
  });

  it('an action on an unknown install is not found and an unknown action is not found', async () => {
    const kit = await accessKit();
    const keys = await enroll();
    expect((await post(kit, `/api/installs/${'d'.repeat(32)}/revoke`, {})).status).toBe(404);
    expect((await post(kit, `/api/installs/${keys.installId}/format-disk`, {})).status).toBe(404);
  });

  it('pairing can be approved from the dashboard and then the agent connects', async () => {
    const kit = await accessKit();
    const keys = await newAgentKeys();
    const started = await registryStub(testEnv).pairStart(
      keys.installId,
      keys.publicKey,
      'ip-dash',
    );
    if (!started.ok) throw new Error('start failed');
    const res = await post(kit, '/api/pair/approve', {
      kind: 'pair-approve',
      pairingCode: started.pairingCode,
      displayName: 'Counter PC',
      approve: true,
    });
    expect(res.status).toBe(200);
    const agent = await connectAgent(keys);
    expect(agent.closed).toBeNull();
  });

  it('the audit endpoint lists rows for an install', async () => {
    const kit = await accessKit();
    const keys = await enroll();
    await connectAgent(keys);
    const body = (await (await kit.fetch(`/api/installs/${keys.installId}/audit`)).json()) as {
      rows: { code: string }[];
    };
    expect(body.rows.map((r) => r.code)).toContain('agent-connected');
  });
});

describe('audit', () => {
  it('the audit table keeps only the newest 2000 rows', async () => {
    const keys = await enroll();
    await runInDurableObject(sessionStub(testEnv, keys.installId), (_i, state) => {
      for (let i = 0; i < AUDIT_CAP + 100; i++)
        appendAudit(state.storage.sql, 'action-accepted', 'status');
      const n = state.storage.sql.exec<{ c: number }>('SELECT count(*) AS c FROM audit').one().c;
      expect(n).toBe(AUDIT_CAP);
    });
  });

  it('a detail that is not a short code is replaced and never stored', async () => {
    const keys = await enroll();
    await runInDurableObject(sessionStub(testEnv, keys.installId), (_i, state) => {
      appendAudit(state.storage.sql, 'action-rejected', 'C:\\Users\\bob\\file.txt');
      const row = state.storage.sql
        .exec<{ detail: string }>('SELECT detail FROM audit ORDER BY id DESC LIMIT 1')
        .one();
      expect(row.detail).toBe('invalid');
    });
  });
});
