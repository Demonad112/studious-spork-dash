import { b64uDecode, sha256, toHex } from './encoding.ts';

/** The string an agent signs to prove it holds the install's key. */
export function agentAuthMessage(
  installId: string,
  sessionId: string,
  nonce: string,
  agentNonce: string,
): string {
  return `agent-auth-v1|${installId}|${sessionId}|${nonce}|${agentNonce}`;
}

/** The string an agent signs to ask how its pairing is going. */
export function pairStatusMessage(installId: string, timestampMs: number): string {
  return `pair-status-v1|${installId}|${timestampMs}`;
}

async function importKey(publicKey: string): Promise<CryptoKey | null> {
  const raw = b64uDecode(publicKey);
  if (raw === null || raw.length !== 32) return null;
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return null;
  }
}

/** True when the base64url text is a usable raw Ed25519 public key. */
export async function isValidPublicKey(publicKey: string): Promise<boolean> {
  return (await importKey(publicKey)) !== null;
}

/** Verifies an Ed25519 signature (base64url) over a UTF-8 message. Never throws. */
export async function verifySignature(
  publicKey: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const key = await importKey(publicKey);
  const sig = b64uDecode(signature);
  if (key === null || sig === null || sig.length !== 64) return false;
  try {
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      sig,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/** First 8 bytes of SHA-256 of the raw public key, as `xxxx-xxxx-xxxx-xxxx`. */
export async function fingerprint(publicKey: string): Promise<string> {
  const raw = b64uDecode(publicKey);
  if (raw === null) throw new Error('invalid public key');
  const hex = toHex((await sha256(raw)).slice(0, 8));
  return hex.match(/.{4}/g)!.join('-');
}
