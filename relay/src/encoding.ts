const B64U_CHARS = /^[A-Za-z0-9_-]*$/;

export function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes unpadded base64url. Returns null for anything else. */
export function b64uDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64U_CHARS.test(text) || text.length % 4 === 1) return null;
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const raw = atob(padded);
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(data: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await sha256(data));
}

export function randomB64u(byteLength: number): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}
