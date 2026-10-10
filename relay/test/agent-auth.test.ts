import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { agentAuthMessage } from '../src/agent-auth.ts';
import { setClock } from '../src/clock.ts';
import { randomB64u } from '../src/encoding.ts';
import {
  SESSION_A,
  agentHello,
  connectAgent,
  enroll,
  newAgentKeys,
  openAgentSocket,
  registryStub,
  relayFetch,
  sessionStub,
  testEnv,
} from './helpers.ts';

async function challenge(keys: Awaited<ReturnType<typeof enroll>>, sessionId = SESSION_A) {
  const c = await openAgentSocket(keys.installId);
  c.send(agentHello(keys, sessionId));
  const ch = await c.nextType('auth-challenge');
  return { c, nonce: ch.nonce as string };
}

describe('agent authentication', () => {
  it('an agent that signs the challenge with its key is let in and receives a resync', async () => {
    const keys = await enroll();
    const c = await openAgentSocket(keys.installId);
    c.send(agentHello(keys, SESSION_A));
    const ch = await c.nextType('auth-challenge');
    const agentNonce = randomB64u(32);
    c.send({
      v: 1,
      type: 'auth-response',
      agentNonce,
      signature: await keys.sign(agentAuthMessage(keys.installId, SESSION_A, ch.nonce, agentNonce)),
    });
    const ok = await c.nextType('auth-ok');
    expect(ok.v).toBe(1);
    expect(typeof ok.serverTimeMs).toBe('number');
    expect(await c.nextType('resync')).toMatchObject({ lastSeq: 0 });
  });

  it('a signature made with a different key is refused with unauthorized', async () => {
    const keys = await enroll();
    const impostor = await newAgentKeys();
    const { c, nonce } = await challenge(keys);
    const agentNonce = randomB64u(32);
    c.send({
      v: 1,
      type: 'auth-response',
      agentNonce,
      signature: await impostor.sign(
        agentAuthMessage(keys.installId, SESSION_A, nonce, agentNonce),
      ),
    });
    expect(await c.nextType('error')).toMatchObject({ code: 'unauthorized', fatal: true });
    await c.waitClosed();
  });

  it('a signature over a different session id is refused', async () => {
    const keys = await enroll();
    const { c, nonce } = await challenge(keys, SESSION_A);
    const agentNonce = randomB64u(32);
    c.send({
      v: 1,
      type: 'auth-response',
      agentNonce,
      signature: await keys.sign(
        agentAuthMessage(keys.installId, 'f'.repeat(32), nonce, agentNonce),
      ),
    });
    expect(await c.nextType('error')).toMatchObject({ code: 'unauthorized' });
  });

  it('a challenge cannot be answered twice', async () => {
    const keys = await enroll();
    const { c, nonce } = await challenge(keys);
    const agentNonce = randomB64u(32);
    const response = {
      v: 1,
      type: 'auth-response',
      agentNonce,
      signature: await keys.sign(agentAuthMessage(keys.installId, SESSION_A, nonce, agentNonce)),
    };
    c.send(response);
    await c.nextType('auth-ok');
    c.send(response);
    // The socket is authenticated, so a stray auth-response is a protocol error and ends it.
    expect(await c.nextType('error')).toMatchObject({ code: 'malformed', fatal: true });
  });

  it('a challenge answered after sixty seconds is refused as expired', async () => {
    const keys = await enroll();
    const { c, nonce } = await challenge(keys);
    const agentNonce = randomB64u(32);
    const signature = await keys.sign(
      agentAuthMessage(keys.installId, SESSION_A, nonce, agentNonce),
    );
    setClock(() => Date.now() + 61_000);
    try {
      c.send({ v: 1, type: 'auth-response', agentNonce, signature });
      expect(await c.nextType('error')).toMatchObject({ code: 'expired', fatal: true });
    } finally {
      setClock(null);
    }
  });

  it('a hello for a different install id is refused', async () => {
    const keys = await enroll();
    const other = await newAgentKeys();
    const c = await openAgentSocket(keys.installId);
    c.send(agentHello(other, SESSION_A));
    expect(await c.nextType('error')).toMatchObject({ code: 'unauthorized', fatal: true });
  });

  it('a hello with no protocol version in common is refused as unsupported', async () => {
    const keys = await enroll();
    const c = await openAgentSocket(keys.installId);
    c.send({ ...agentHello(keys, SESSION_A), protocolVersions: [7] });
    expect(await c.nextType('error')).toMatchObject({ code: 'unsupported-version', fatal: true });
  });

  it('a frame that does not decode ends the agent socket', async () => {
    const keys = await enroll();
    const c = await openAgentSocket(keys.installId);
    c.send('not json');
    expect(await c.nextType('error')).toMatchObject({ code: 'malformed', fatal: true });
    await c.waitClosed();
  });

  it('a socket that never authenticates is closed by the alarm after fifteen seconds', async () => {
    const keys = await enroll();
    const c = await openAgentSocket(keys.installId);
    setClock(() => Date.now() + 16_000);
    try {
      expect(await runDurableObjectAlarm(sessionStub(testEnv, keys.installId))).toBe(true);
      expect(await c.nextType('error')).toMatchObject({ code: 'unauthorized', fatal: true });
      await c.waitClosed();
    } finally {
      setClock(null);
    }
    const audit = await sessionStub(testEnv, keys.installId).getAudit();
    expect(audit.map((r) => r.code)).toContain('auth-timeout');
  });

  it('a second agent socket replaces the first', async () => {
    const keys = await enroll();
    const first = await connectAgent(keys);
    const second = await connectAgent(keys);
    expect((await first.waitClosed()).reason).toBe('replaced');
    expect(second.closed).toBeNull();
    const view = await sessionStub(testEnv, keys.installId).getView();
    expect(view.connected).toBe(true);
    expect(view.armed).toBe(true);
  });

  it('a locked install gets a fatal locked error and no challenge', async () => {
    const keys = await enroll();
    await registryStub(testEnv).setLocked(keys.installId, true);
    const c = await openAgentSocket(keys.installId);
    expect(await c.nextType('error')).toMatchObject({ code: 'locked', fatal: true });
    await c.waitClosed();
  });

  it('an install waiting to be paired again cannot connect', async () => {
    const keys = await enroll();
    await registryStub(testEnv).rotate(keys.installId);
    const res = await relayFetch(`/agent/ws?install=${keys.installId}`, {
      headers: { upgrade: 'websocket' },
    });
    expect(res.status).toBe(403);
  });
});
