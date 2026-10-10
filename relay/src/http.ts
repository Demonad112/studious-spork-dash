export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export const MAX_BODY_BYTES = 4096;

export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

export function fail(status: number, error: string): Response {
  return json({ error }, status);
}

/** Adds the security headers to a response that is not a WebSocket upgrade. */
export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101 || res.webSocket) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Reads a small JSON body. Returns null for a wrong type, a body over the cap, or bad JSON. */
export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) return null;
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** True when the request's Origin header is exactly the request's own origin. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return origin !== null && origin === new URL(req.url).origin;
}

export function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
}

export const INSTALL_ID = /^[0-9a-f]{32}$/;

/** Headers that carry trusted facts from a Worker to a Durable Object. Never forwarded from a client. */
export const INTERNAL_PREFIX = 'x-rc-';

/** Copies only the upgrade headers, then adds the trusted ones. */
export function forwardUpgrade(req: Request, internal: Record<string, string>): Request {
  const headers = new Headers();
  for (const k of [
    'upgrade',
    'connection',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
  ]) {
    const v = req.headers.get(k);
    if (v !== null) headers.set(k, v);
  }
  for (const [k, v] of Object.entries(internal)) headers.set(INTERNAL_PREFIX + k, v);
  return new Request(req.url, { method: 'GET', headers });
}
