import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { decodePairing } from '@remote-console/protocol';
import { pairStatusMessage } from '../src/agent-auth.ts';
import {
  PAIRING_CAP_PER_IP,
  PAIRING_CAP_TOTAL,
  PAIRING_TTL_MS,
  generatePairingCode,
} from '../src/pairing.ts';
import { b64uEncode } from '../src/encoding.ts';
import { setClock } from '../src/clock.ts';
import {
  accessKit,
  newAgentKeys,
  postJson,
  registryStub,
  relayFetch,
  testEnv,
  type AgentKeys,
} from './helpers.ts';

// Storage persists across tests in a file, so each test starts from an empty pending table.
beforeEach(async () => {
  await runInDurableObject(registryStub(testEnv), (_i, state) => {
    state.storage.sql.exec('DELETE FROM pending');
  });
});

let ipCounter = 0;
async function start(keys: AgentKeys, ip = `203.0.113.${++ipCounter}`) {
  return postJson(
    '/pair/start',
    { kind: 'pair-start', installId: keys.installId, publicKey: keys.publicKey },
    { 'cf-connecting-ip': ip },
  );
}

interface Started {
  pairingCode: string;
  fingerprint: string;
}
async function startOk(keys: AgentKeys): Promise<Started> {
  const res = await start(keys);
  expect(res.status).toBe(200);
  return (await res.json()) as Started;
}

async function status(keys: AgentKeys, timestampMs = Date.now(), sign = keys) {
  return postJson('/pair/status', {
    kind: 'pair-status',
    installId: keys.installId,
    timestampMs,
    signature: await sign.sign(pairStatusMessage(keys.installId, timestampMs)),
  });
}

describe('pairing code generation', () => {
  it('a generated code is eight Crockford base32 characters', () => {
    for (let i = 0; i < 200; i++) expect(generatePairingCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });
});

describe('pairing start', () => {
  it('a pair start returns a code and the fingerprint of the key', async () => {
    const keys = await newAgentKeys();
    const res = await start(keys);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Started & { expiresInSec: number };
    expect(decodePairing(body, 'pair-start-result').ok).toBe(true);
    expect(body.expiresInSec).toBe(PAIRING_TTL_MS / 1000);
  });

  it('a pair start with an unknown field is rejected as malformed', async () => {
    const keys = await newAgentKeys();
    const res = await postJson('/pair/start', {
      kind: 'pair-start',
      installId: keys.installId,
      publicKey: keys.publicKey,
      hostname: 'pc',
    });
    expect(res.status).toBe(400);
  });

  it('a pair start with a key of the wrong length is rejected', async () => {
    const keys = await newAgentKeys();
    const res = await postJson('/pair/start', {
      kind: 'pair-start',
      installId: keys.installId,
      publicKey: b64uEncode(new Uint8Array(31)),
    });
    expect(res.status).toBe(400);
  });

  it('a fourth pending pairing from one address is refused', async () => {
    for (let i = 0; i < PAIRING_CAP_PER_IP; i++)
      expect((await start(await newAgentKeys(), '198.51.100.1')).status).toBe(200);
    expect((await start(await newAgentKeys(), '198.51.100.1')).status).toBe(429);
    expect((await start(await newAgentKeys(), '198.51.100.2')).status).toBe(200);
  });

  it('the total number of pending pairings is capped', async () => {
    const reg = registryStub(testEnv);
    // Spread over many hashed addresses so only the total cap can stop us.
    let accepted = 0;
    for (let i = 0; i < PAIRING_CAP_TOTAL + 5; i++) {
      const k = await newAgentKeys();
      const out = await reg.pairStart(k.installId, k.publicKey, `ip-${i}`);
      if (out.ok) accepted++;
      else expect(out.error).toBe('too-many-pending');
    }
    expect(accepted).toBeLessThanOrEqual(PAIRING_CAP_TOTAL);
    expect(accepted).toBeGreaterThan(0);
  });

  it('an install that is already paired cannot start a second pairing', async () => {
    const keys = await newAgentKeys();
    const reg = registryStub(testEnv);
    const out = await reg.pairStart(keys.installId, keys.publicKey, 'ip-x');
    if (!out.ok) throw new Error('start failed');
    await reg.approve(out.pairingCode, 'PC', true);
    expect((await start(keys)).status).toBe(409);
  });
});

describe('pairing status', () => {
  it('a signed status poll reports pending then approved', async () => {
    const keys = await newAgentKeys();
    const started = await startOk(keys);
    expect(await (await status(keys)).json()).toEqual({
      kind: 'pair-status-result',
      status: 'pending',
    });
    await registryStub(testEnv).approve(started.pairingCode, 'Front desk', true);
    expect(await (await status(keys)).json()).toEqual({
      kind: 'pair-status-result',
      status: 'approved',
    });
  });

  it('a rejected pairing reports rejected', async () => {
    const keys = await newAgentKeys();
    const started = await startOk(keys);
    await registryStub(testEnv).approve(started.pairingCode, 'x', false);
    expect(((await (await status(keys)).json()) as { status: string }).status).toBe('rejected');
  });

  it('a status poll signed with another key is refused', async () => {
    const keys = await newAgentKeys();
    await start(keys);
    const other = await newAgentKeys();
    const res = await status(keys, Date.now(), other);
    expect(res.status).toBe(401);
  });

  it('a status poll with an old timestamp is refused', async () => {
    const keys = await newAgentKeys();
    await start(keys);
    const res = await status(keys, Date.now() - 6 * 60 * 1000);
    expect(res.status).toBe(400);
  });

  it('a status poll for an install with no pairing reports expired', async () => {
    const keys = await newAgentKeys();
    expect(((await (await status(keys)).json()) as { status: string }).status).toBe('expired');
  });

  it('a pending pairing expires after ten minutes', async () => {
    const keys = await newAgentKeys();
    const started = await startOk(keys);
    setClock(() => Date.now() + PAIRING_TTL_MS + 1000);
    try {
      expect(await registryStub(testEnv).lookup(started.pairingCode)).toBeNull();
      expect(await registryStub(testEnv).approve(started.pairingCode, 'x', true)).toBe(false);
    } finally {
      setClock(null);
    }
  });
});

describe('pairing approval', () => {
  it('a code can be approved once only', async () => {
    const keys = await newAgentKeys();
    const started = await startOk(keys);
    const reg = registryStub(testEnv);
    expect(await reg.approve(started.pairingCode, 'PC', true)).toBe(true);
    expect(await reg.approve(started.pairingCode, 'PC', true)).toBe(false);
    expect(await reg.lookup(started.pairingCode)).toBeNull();
  });

  it('the lookup shows the same fingerprint the agent was given', async () => {
    const keys = await newAgentKeys();
    const started = await startOk(keys);
    const found = await registryStub(testEnv).lookup(started.pairingCode);
    expect(found).toEqual({ fingerprint: started.fingerprint, rekey: false });
  });

  it('a dashboard lookup accepts a typed code with look-alike letters and spaces', async () => {
    const kit = await accessKit();
    const keys = await newAgentKeys();
    const started = await startOk(keys);
    const typed = started.pairingCode.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l');
    const spaced = `${typed.slice(0, 4)} - ${typed.slice(4)}`;
    const res = await kit.fetch('/api/pair/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'pair-lookup', pairingCode: spaced }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Started;
    expect(decodePairing(body, 'pair-lookup-result').ok).toBe(true);
    expect(body.fingerprint).toBe(started.fingerprint);
  });

  it('a dashboard lookup of an unknown code is not found', async () => {
    const kit = await accessKit();
    const res = await kit.fetch('/api/pair/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'pair-lookup', pairingCode: '00000000' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('agent routes', () => {
  it('an unknown install is not found and creates no Durable Object', async () => {
    const before = (await listDurableObjectIds(testEnv.SESSION)).length;
    for (let i = 0; i < 5; i++) {
      const keys = await newAgentKeys();
      const res = await relayFetch(`/agent/ws?install=${keys.installId}`, {
        headers: { upgrade: 'websocket' },
      });
      expect(res.status).toBe(404);
    }
    expect((await listDurableObjectIds(testEnv.SESSION)).length).toBe(before);
  });

  it('an agent route without an upgrade header is refused', async () => {
    const keys = await newAgentKeys();
    expect((await relayFetch(`/agent/ws?install=${keys.installId}`)).status).toBe(426);
  });

  it('a malformed install id is refused', async () => {
    const res = await relayFetch('/agent/ws?install=nope', { headers: { upgrade: 'websocket' } });
    expect(res.status).toBe(400);
  });

  it('the relay serves nothing else', async () => {
    expect((await relayFetch('/')).status).toBe(404);
    expect((await relayFetch('/api/installs')).status).toBe(404);
  });
});
