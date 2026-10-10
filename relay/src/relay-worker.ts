import { decodePairing } from '@remote-console/protocol';
import type { PairStatusResult } from '@remote-console/protocol';
import {
  fail,
  forwardUpgrade,
  INSTALL_ID,
  isWebSocketUpgrade,
  json,
  readJson,
  withSecurityHeaders,
} from './http.ts';
import { hashIp } from './pairing.ts';
import { registryStub, sessionStub } from './stubs.ts';

export { RegistryDO } from './registry-do.ts';
export { SessionDO } from './session-do.ts';

async function pairStart(req: Request, env: Cloudflare.Env): Promise<Response> {
  const body = decodePairing(await readJson(req), 'pair-start');
  if (!body.ok || body.body.kind !== 'pair-start') return fail(400, 'malformed');
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const out = await registryStub(env).pairStart(
    body.body.installId,
    body.body.publicKey,
    await hashIp(ip),
  );
  if (out.ok)
    return json({
      kind: 'pair-start-result',
      pairingCode: out.pairingCode,
      fingerprint: out.fingerprint,
      expiresInSec: out.expiresInSec,
    });
  const status = {
    'invalid-key': 400,
    'already-paired': 409,
    'too-many-pending': 429,
    'rate-limited': 429,
  }[out.error];
  return fail(status, out.error);
}

async function pairStatus(req: Request, env: Cloudflare.Env): Promise<Response> {
  const body = decodePairing(await readJson(req), 'pair-status');
  if (!body.ok || body.body.kind !== 'pair-status') return fail(400, 'malformed');
  const out = await registryStub(env).pairStatus(
    body.body.installId,
    body.body.timestampMs,
    body.body.signature,
  );
  if (!out.ok) return fail(out.error === 'unauthorized' ? 401 : 400, out.error);
  const result: PairStatusResult = { kind: 'pair-status-result', status: out.status };
  return json(result);
}

async function agentSocket(req: Request, env: Cloudflare.Env, url: URL): Promise<Response> {
  const install = url.searchParams.get('install') ?? '';
  if (!INSTALL_ID.test(install)) return fail(400, 'malformed');
  if (!isWebSocketUpgrade(req)) return fail(426, 'upgrade-required');
  const record = await registryStub(env).getInstall(install);
  // An unknown install never reaches a Durable Object, so random ids create nothing.
  if (record === null) return fail(404, 'not-found');
  if (record.publicKey === '') return fail(403, 'not-paired');
  return sessionStub(env, install).fetch(
    forwardUpgrade(req, {
      role: 'agent',
      install,
      key: record.publicKey,
      locked: record.locked ? '1' : '0',
    }),
  );
}

/** The public Worker: agent routes and pairing. It owns both Durable Object classes. */
export function createRelayHandler(): ExportedHandler<Cloudflare.Env> {
  return {
    async fetch(req, env) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/pair/start')
        return withSecurityHeaders(await pairStart(req, env));
      if (req.method === 'POST' && url.pathname === '/pair/status')
        return withSecurityHeaders(await pairStatus(req, env));
      if (req.method === 'GET' && url.pathname === '/agent/ws') return agentSocket(req, env, url);
      return withSecurityHeaders(fail(404, 'not-found'));
    },
  };
}

export default createRelayHandler();
