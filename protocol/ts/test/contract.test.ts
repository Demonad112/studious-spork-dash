import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME_BYTES,
  PING_FRAME,
  PONG_FRAME,
  decodeFrame,
  encodeFrame,
  findDenied,
  decodePairing,
  normalizePairingCode,
  sanitizeText,
} from '../src/index.ts';
import type { DenyList } from '../src/index.ts';
import { loadFixtures, loadJson } from './fixtures.ts';

const deny = loadJson<DenyList>('deny-list.json');
const frameSchema = loadJson<object>('schemas/frame.schema.json');
const pairingSchema = loadJson<object>('schemas/pairing.schema.json');

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false });
const validateFrame = ajv.compile(frameSchema);
const validatePairing = ajv.compile(pairingSchema);

interface LenientCase {
  input: unknown;
  normalized: unknown;
}

describe('valid fixtures', () => {
  for (const f of loadFixtures('valid')) {
    it(`${f.name} passes the schema, decodes, and round-trips unchanged`, () => {
      expect(validateFrame(f.json), JSON.stringify(validateFrame.errors)).toBe(true);
      const decoded = decodeFrame(f.text);
      expect(decoded.ok, JSON.stringify(decoded)).toBe(true);
      if (decoded.ok) expect(JSON.parse(encodeFrame(decoded.frame))).toEqual(f.json);
    });
  }

  it('every frame type in the schema has at least one valid fixture', () => {
    const types = new Set(loadFixtures('valid').map((f) => (f.json as { type: string }).type));
    const defs = (
      frameSchema as { $defs: Record<string, { properties?: { type?: { const?: string } } }> }
    ).$defs;
    const schemaTypes = Object.values(defs)
      .map((d) => d.properties?.type?.const)
      .filter((t): t is string => typeof t === 'string');
    expect(schemaTypes.length).toBe(13);
    for (const t of schemaTypes) expect(types.has(t), `missing fixture for ${t}`).toBe(true);
  });

  it('every event kind has at least one valid fixture', () => {
    const kinds = new Set(
      loadFixtures('valid')
        .map((f) => f.json as { type: string; kind?: string })
        .filter((j) => j.type === 'event')
        .map((j) => j.kind),
    );
    for (const k of [
      'job-started',
      'step',
      'progress',
      'prompt-opened',
      'prompt-closed',
      'status',
      'armed-state',
    ])
      expect(kinds.has(k), `missing fixture for ${k}`).toBe(true);
  });
});

describe('invalid fixtures', () => {
  for (const f of loadFixtures('invalid')) {
    it(`${f.name} is rejected by the schema and by the decoder`, () => {
      expect(validateFrame(f.json)).toBe(false);
      expect(decodeFrame(f.text).ok).toBe(false);
    });
  }

  it('a frame over 16 KiB is rejected as too large', () => {
    const big = JSON.stringify({ v: 1, type: 'ping', pad: 'x'.repeat(MAX_FRAME_BYTES) });
    const r = decodeFrame(big);
    expect(r).toMatchObject({ ok: false, error: 'frame-too-large' });
  });

  it('a frame of exactly 16 KiB is not rejected for size', () => {
    const head = '{"v":1,"type":"ping","pad":"';
    const tail = '"}';
    const pad = 'x'.repeat(MAX_FRAME_BYTES - head.length - tail.length);
    const r = decodeFrame(head + pad + tail);
    expect(r).toMatchObject({ ok: false, error: 'malformed' });
  });

  it('a frame of multi-byte characters is measured in bytes', () => {
    const r = decodeFrame(JSON.stringify({ v: 1, type: 'ping', pad: 'é'.repeat(9000) }));
    expect(r).toMatchObject({ ok: false, error: 'frame-too-large' });
  });

  it('an unsupported version is reported as such', () => {
    expect(decodeFrame('{"v":2,"type":"ping"}')).toMatchObject({
      ok: false,
      error: 'unsupported-version',
    });
  });

  it('text that is not JSON is malformed', () => {
    expect(decodeFrame('not json')).toMatchObject({ ok: false, error: 'malformed' });
    expect(decodeFrame('[1,2]')).toMatchObject({ ok: false, error: 'malformed' });
  });

  it('encoding an oversize frame throws', () => {
    expect(() =>
      encodeFrame({
        v: 1,
        type: 'event',
        seq: 1,
        kind: 'prompt-opened',
        promptId: 'p',
        expects: 'done',
        labelId: 'other',
        blocking: false,
        text: 'x'.repeat(MAX_FRAME_BYTES),
      }),
    ).toThrow();
  });
});

describe('lenient fixtures', () => {
  for (const f of loadFixtures('lenient')) {
    it(`${f.name} is accepted and normalised as expected`, () => {
      const c = f.json as LenientCase;
      const r = decodeFrame(JSON.stringify(c.input));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      if (c.normalized === null) {
        const seq = (c.input as { seq: number }).seq;
        expect(r.frame).toEqual({ v: 1, type: 'event', seq, kind: 'unknown' });
      } else {
        expect(r.frame).toEqual(c.normalized);
      }
    });
  }
});

describe('byte-constant keepalive frames', () => {
  it('the ping and pong constants decode to ping and pong', () => {
    expect(decodeFrame(PING_FRAME)).toMatchObject({ ok: true, frame: { type: 'ping' } });
    expect(decodeFrame(PONG_FRAME)).toMatchObject({ ok: true, frame: { type: 'pong' } });
    expect(encodeFrame({ v: 1, type: 'ping' })).toBe(PING_FRAME);
    expect(encodeFrame({ v: 1, type: 'pong' })).toBe(PONG_FRAME);
  });
});

describe('data minimisation', () => {
  const clean = [
    ...loadFixtures('valid'),
    ...loadFixtures('lenient'),
    ...loadFixtures('pairing/valid'),
  ];
  for (const f of clean) {
    it(`${f.name} carries no path, drive letter or forbidden field`, () => {
      expect(findDenied(f.json, deny)).toEqual([]);
    });
  }

  for (const f of loadFixtures('deny')) {
    it(`the scanner flags the planted leak in ${f.name}`, () => {
      expect(findDenied(f.json, deny).length).toBeGreaterThan(0);
    });
  }

  it('the scanner flags a path planted into an otherwise clean fixture', () => {
    const base = structuredClone(
      loadFixtures('valid').find((f) => f.name === 'event-prompt-opened-done')!.json,
    ) as Record<string, unknown>;
    expect(findDenied(base, deny)).toEqual([]);
    base.text = 'D:\\reports';
    expect(findDenied(base, deny)).toEqual([{ where: '$.text', why: 'path-separator' }]);
    base.text = 'D:report';
    expect(findDenied(base, deny)[0]?.why).toBe('drive-letter');
  });

  it('free text with a path or control characters is sanitised away or stripped', () => {
    expect(sanitizeText('Review first')).toBe('Review first');
    expect(sanitizeText('a\nb\u0007c')).toBe('abc');
    expect(sanitizeText('C:\\Users\\bob')).toBeUndefined();
    expect(sanitizeText('/etc/passwd')).toBeUndefined();
    expect(sanitizeText('x'.repeat(200))).toHaveLength(80);
  });
});

describe('pairing bodies', () => {
  for (const f of loadFixtures('pairing/valid')) {
    it(`${f.name} passes the pairing schema`, () => {
      expect(validatePairing(f.json), JSON.stringify(validatePairing.errors)).toBe(true);
    });
  }
  for (const f of loadFixtures('pairing/invalid')) {
    it(`${f.name} fails the pairing schema`, () => {
      expect(validatePairing(f.json)).toBe(false);
    });
  }
});

describe('pairing decoder', () => {
  for (const f of loadFixtures('pairing/valid')) {
    it(`${f.name} decodes strictly and unchanged`, () => {
      const kind = (f.json as { kind: Parameters<typeof decodePairing>[1] }).kind;
      const r = decodePairing(f.json, kind);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.body).toEqual(f.json);
    });
  }
  for (const f of loadFixtures('pairing/invalid')) {
    it(`${f.name} is rejected by the decoder`, () => {
      const kind = (f.json as { kind: Parameters<typeof decodePairing>[1] }).kind;
      expect(decodePairing(f.json, kind).ok).toBe(false);
    });
  }
  it('a body of the wrong kind is rejected', () => {
    expect(decodePairing({ kind: 'pair-lookup', pairingCode: '7K2M9Q4T' }, 'pair-approve').ok).toBe(
      false,
    );
  });
  it('typed codes are normalised', () => {
    expect(normalizePairingCode('7k2m-9q4t')).toBe('7K2M9Q4T');
    expect(normalizePairingCode(' o1Il 0000 ')).toBe('01110000');
  });
});
