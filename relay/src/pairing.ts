import { sha256Hex } from './encoding.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Eight Crockford base32 characters from the platform random source. */
export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => ALPHABET[b & 31]!).join('');
}

export function hashPairingCode(code: string): Promise<string> {
  return sha256Hex(`pairing-code-v1|${code}`);
}

export function hashIp(ip: string): Promise<string> {
  return sha256Hex(`ip-v1|${ip}`);
}

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_CAP_TOTAL = 20;
export const PAIRING_CAP_PER_IP = 3;
export const PAIR_STATUS_WINDOW_MS = 5 * 60 * 1000;
