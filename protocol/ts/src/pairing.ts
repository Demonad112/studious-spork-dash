/** HTTP pairing bodies. Mirrors `protocol/schemas/pairing.schema.json`. */

export interface PairStart {
  kind: 'pair-start';
  installId: string;
  publicKey: string;
}
export interface PairStartResult {
  kind: 'pair-start-result';
  pairingCode: string;
  fingerprint: string;
  expiresInSec: number;
}
export interface PairStatus {
  kind: 'pair-status';
  installId: string;
  timestampMs: number;
  signature: string;
}
export type PairingStatus = 'pending' | 'approved' | 'expired' | 'rejected';
export interface PairStatusResult {
  kind: 'pair-status-result';
  status: PairingStatus;
}
export interface PairLookup {
  kind: 'pair-lookup';
  pairingCode: string;
}
export interface PairLookupResult {
  kind: 'pair-lookup-result';
  fingerprint: string;
  /** True when the install is already enrolled and this pairing replaces its key. */
  rekey: boolean;
}
export interface PairApprove {
  kind: 'pair-approve';
  pairingCode: string;
  displayName: string;
  approve: boolean;
}

export type PairingBody =
  | PairStart
  | PairStartResult
  | PairStatus
  | PairStatusResult
  | PairLookup
  | PairLookupResult
  | PairApprove;

export type PairingKind = PairingBody['kind'];

const HEX32 = /^[0-9a-f]{32}$/;
const B64U_32 = /^[A-Za-z0-9_-]{43}$/;
const B64U_64 = /^[A-Za-z0-9_-]{86}$/;
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const FINGERPRINT = /^([0-9a-f]{4}-){3}[0-9a-f]{4}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export type PairingDecode = { ok: true; body: PairingBody } | { ok: false; detail: string };

function fail(detail: string): PairingDecode {
  return { ok: false, detail };
}

function hasOnly(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

/**
 * Uppercases a typed pairing code and maps the look-alike letters Crockford base32 leaves out
 * (O to 0, I and L to 1), dropping spaces and hyphens.
 */
export function normalizePairingCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Strictly decodes one pairing body of the expected kind. Never throws. */
export function decodePairing(input: unknown, expected: PairingKind): PairingDecode {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return fail('expected object');
  const o = input as Record<string, unknown>;
  if (o.kind !== expected) return fail('kind: unexpected');
  switch (expected) {
    case 'pair-start':
      if (!hasOnly(o, ['kind', 'installId', 'publicKey'])) return fail('unknown field');
      if (typeof o.installId !== 'string' || !HEX32.test(o.installId))
        return fail('installId: invalid format');
      if (typeof o.publicKey !== 'string' || !B64U_32.test(o.publicKey))
        return fail('publicKey: invalid format');
      return { ok: true, body: { kind: expected, installId: o.installId, publicKey: o.publicKey } };
    case 'pair-status':
      if (!hasOnly(o, ['kind', 'installId', 'timestampMs', 'signature']))
        return fail('unknown field');
      if (typeof o.installId !== 'string' || !HEX32.test(o.installId))
        return fail('installId: invalid format');
      if (
        typeof o.timestampMs !== 'number' ||
        !Number.isSafeInteger(o.timestampMs) ||
        o.timestampMs < 0
      )
        return fail('timestampMs: invalid');
      if (typeof o.signature !== 'string' || !B64U_64.test(o.signature))
        return fail('signature: invalid format');
      return {
        ok: true,
        body: {
          kind: expected,
          installId: o.installId,
          timestampMs: o.timestampMs,
          signature: o.signature,
        },
      };
    case 'pair-lookup':
      if (!hasOnly(o, ['kind', 'pairingCode'])) return fail('unknown field');
      if (typeof o.pairingCode !== 'string' || !CODE.test(o.pairingCode))
        return fail('pairingCode: invalid format');
      return { ok: true, body: { kind: expected, pairingCode: o.pairingCode } };
    case 'pair-approve':
      if (!hasOnly(o, ['kind', 'pairingCode', 'displayName', 'approve']))
        return fail('unknown field');
      if (typeof o.pairingCode !== 'string' || !CODE.test(o.pairingCode))
        return fail('pairingCode: invalid format');
      if (
        typeof o.displayName !== 'string' ||
        o.displayName.length < 1 ||
        [...o.displayName].length > 40 ||
        CONTROL.test(o.displayName)
      )
        return fail('displayName: invalid');
      if (typeof o.approve !== 'boolean') return fail('approve: expected boolean');
      return {
        ok: true,
        body: {
          kind: expected,
          pairingCode: o.pairingCode,
          displayName: o.displayName,
          approve: o.approve,
        },
      };
    case 'pair-start-result':
      if (!hasOnly(o, ['kind', 'pairingCode', 'fingerprint', 'expiresInSec']))
        return fail('unknown field');
      if (
        typeof o.pairingCode !== 'string' ||
        !CODE.test(o.pairingCode) ||
        typeof o.fingerprint !== 'string' ||
        !FINGERPRINT.test(o.fingerprint) ||
        typeof o.expiresInSec !== 'number' ||
        !Number.isInteger(o.expiresInSec) ||
        o.expiresInSec < 1 ||
        o.expiresInSec > 3600
      )
        return fail('invalid field');
      return {
        ok: true,
        body: {
          kind: expected,
          pairingCode: o.pairingCode,
          fingerprint: o.fingerprint,
          expiresInSec: o.expiresInSec,
        },
      };
    case 'pair-status-result':
      if (!hasOnly(o, ['kind', 'status'])) return fail('unknown field');
      if (!['pending', 'approved', 'expired', 'rejected'].includes(o.status as string))
        return fail('status: invalid value');
      return { ok: true, body: { kind: expected, status: o.status as PairingStatus } };
    case 'pair-lookup-result':
      if (!hasOnly(o, ['kind', 'fingerprint', 'rekey'])) return fail('unknown field');
      if (typeof o.fingerprint !== 'string' || !FINGERPRINT.test(o.fingerprint))
        return fail('fingerprint: invalid format');
      if (typeof o.rekey !== 'boolean') return fail('rekey: expected boolean');
      return {
        ok: true,
        body: { kind: expected, fingerprint: o.fingerprint, rekey: o.rekey },
      };
  }
}
