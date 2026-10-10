import { decodePairing, normalizePairingCode } from '@remote-console/protocol';
import type { PairLookupResult } from '@remote-console/protocol';
import type { JWTVerifyGetKey } from 'jose';
import { verifyAccess } from './access.ts';
import { fingerprint } from './agent-auth.ts';
import {
  INSTALL_ID,
  fail,
  forwardUpgrade,
  isWebSocketUpgrade,
  json,
  readJson,
  sameOrigin,
  withSecurityHeaders,
} from './http.ts';
import { registryStub, sessionStub } from './stubs.ts';

export { RegistryDO } from './registry-do.ts';
export { SessionDO } from './session-do.ts';

export interface DashboardOptions {
  /** Key source for the Access JWT. Tests inject a local one; production uses the team's JWKS. */
  jwks?: JWTVerifyGetKey;
}

function withNormalizedCode(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && 'pairingCode' in body) {
    const o = body as Record<string, unknown>;
    if (typeof o.pairingCode === 'string')
      return { ...o, pairingCode: normalizePairingCode(o.pairingCode) };
  }
  return body;
}

async function browserSocket(req: Request, env: Cloudflare.Env, url: URL): Promise<Response> {
  if (!sameOrigin(req)) return fail(403, 'forbidden');
  const install = url.searchParams.get('install') ?? '';
  if (!INSTALL_ID.test(install)) return fail(400, 'malformed');
  if (!isWebSocketUpgrade(req)) return fail(426, 'upgrade-required');
  if ((await registryStub(env).getInstall(install)) === null) return fail(404, 'not-found');
  return sessionStub(env, install).fetch(forwardUpgrade(req, { role: 'browser', install }));
}

async function listInstalls(env: Cloudflare.Env): Promise<Response> {
  const records = await registryStub(env).listInstalls();
  const installs = await Promise.all(
    records.map(async (r) => ({
      installId: r.installId,
      displayName: r.displayName,
      status: r.status,
      locked: r.locked,
      createdMs: r.createdMs,
      fingerprint: r.publicKey === '' ? null : await fingerprint(r.publicKey),
      live: await sessionStub(env, r.installId).getView(),
    })),
  );
  return json({ installs });
}

async function installAction(
  env: Cloudflare.Env,
  id: string,
  action: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const registry = registryStub(env);
  const session = sessionStub(env, id);
  let ok: boolean;
  switch (action) {
    case 'rotate':
      ok = await registry.rotate(id);
      if (ok) {
        await session.kickAgent();
        await session.recordAudit('rotated');
      }
      break;
    case 'revoke':
    case 'unlock': {
      const lock = action === 'revoke';
      ok = await registry.setLocked(id, lock);
      if (ok) {
        await session.setLocked(lock);
        await session.recordAudit(lock ? 'revoked' : 'unlocked');
      }
      break;
    }
    case 'rename': {
      const name = body.displayName;
      // eslint-disable-next-line no-control-regex
      if (
        typeof name !== 'string' ||
        [...name].length < 1 ||
        [...name].length > 40 ||
        /[\u0000-\u001f\u007f]/.test(name)
      )
        return fail(400, 'malformed');
      ok = await registry.rename(id, name);
      if (ok) await session.recordAudit('renamed');
      break;
    }
    case 'delete':
      ok = await registry.remove(id);
      if (ok) await session.wipe();
      break;
    default:
      return fail(404, 'not-found');
  }
  return ok ? json({ ok: true }) : fail(404, 'not-found');
}

async function api(req: Request, env: Cloudflare.Env, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter((p) => p !== '');
  // parts[0] is "api".
  if (req.method === 'GET') {
    if (parts.length === 2 && parts[1] === 'installs') return listInstalls(env);
    if (parts.length === 4 && parts[1] === 'installs' && parts[3] === 'audit') {
      const id = parts[2]!;
      if (!INSTALL_ID.test(id)) return fail(400, 'malformed');
      if ((await registryStub(env).getInstall(id)) === null) return fail(404, 'not-found');
      return json({ rows: await sessionStub(env, id).getAudit(200) });
    }
    return fail(404, 'not-found');
  }
  if (req.method !== 'POST') return fail(405, 'method-not-allowed');
  if (!sameOrigin(req)) return fail(403, 'forbidden');
  const raw = await readJson(req);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail(400, 'malformed');
  const body = raw as Record<string, unknown>;
  if (parts.length === 3 && parts[1] === 'pair' && parts[2] === 'lookup') {
    const d = decodePairing(withNormalizedCode(body), 'pair-lookup');
    if (!d.ok || d.body.kind !== 'pair-lookup') return fail(400, 'malformed');
    const found = await registryStub(env).lookup(d.body.pairingCode);
    if (found === null) return fail(404, 'not-found');
    const result: PairLookupResult = { kind: 'pair-lookup-result', ...found };
    return json(result);
  }
  if (parts.length === 3 && parts[1] === 'pair' && parts[2] === 'approve') {
    const d = decodePairing(withNormalizedCode(body), 'pair-approve');
    if (!d.ok || d.body.kind !== 'pair-approve') return fail(400, 'malformed');
    const ok = await registryStub(env).approve(
      d.body.pairingCode,
      d.body.displayName,
      d.body.approve,
    );
    return ok ? json({ ok: true }) : fail(404, 'not-found');
  }
  if (parts.length === 4 && parts[1] === 'installs') {
    const id = parts[2]!;
    if (!INSTALL_ID.test(id)) return fail(400, 'malformed');
    return installAction(env, id, parts[3]!, body);
  }
  return fail(404, 'not-found');
}

/** The Access-protected Worker: assets, `/api/*` and `/ws/browser`. Every route checks the JWT. */
export function createDashboardHandler(
  options: DashboardOptions = {},
): ExportedHandler<Cloudflare.Env> {
  return {
    async fetch(req, env) {
      const who = await verifyAccess(req, env, options.jwks);
      if (who === null) return withSecurityHeaders(fail(401, 'unauthorized'));
      const url = new URL(req.url);
      if (url.pathname === '/ws/browser' && req.method === 'GET')
        return withSecurityHeaders(await browserSocket(req, env, url));
      if (url.pathname.startsWith('/api/')) return withSecurityHeaders(await api(req, env, url));
      if ((req.method === 'GET' || req.method === 'HEAD') && env.ASSETS !== undefined)
        return withSecurityHeaders(await env.ASSETS.fetch(req));
      return withSecurityHeaders(fail(404, 'not-found'));
    },
  };
}

export default createDashboardHandler();
