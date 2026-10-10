import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
  ALLOW_DEV_AUTH?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const remoteSets = new Map<string, JWTVerifyGetKey>();

function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  let set = remoteSets.get(teamDomain);
  if (set === undefined) {
    set = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    remoteSets.set(teamDomain, set);
  }
  return set;
}

export function allowedEmails(env: AccessEnv): string[] {
  return (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/** The dev bypass needs the variable AND a loopback host. It is never set in a tracked config. */
export function devAuthAllowed(env: AccessEnv, url: URL): boolean {
  return env.ALLOW_DEV_AUTH === 'true' && LOCAL_HOSTS.has(url.hostname);
}

/**
 * Verifies the Cloudflare Access assertion: signature, issuer, audience, expiry and an allowed
 * email. Returns null on any failure, including missing configuration (fail closed).
 */
export async function verifyAccess(
  req: Request,
  env: AccessEnv,
  jwks?: JWTVerifyGetKey,
): Promise<{ email: string } | null> {
  const url = new URL(req.url);
  if (devAuthAllowed(env, url)) return { email: 'dev@localhost' };
  const team = env.ACCESS_TEAM_DOMAIN ?? '';
  const aud = env.ACCESS_AUD ?? '';
  const emails = allowedEmails(env);
  if (team === '' || aud === '' || emails.length === 0) return null;
  const token = req.headers.get('cf-access-jwt-assertion');
  if (token === null || token === '') return null;
  try {
    const { payload } = await jwtVerify(token, jwks ?? remoteJwks(team), {
      issuer: `https://${team}`,
      audience: aud,
      algorithms: ['RS256'],
    });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    return emails.includes(email) ? { email } : null;
  } catch {
    return null;
  }
}
