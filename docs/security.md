# Security

The full trust-boundary and threat table is finished in Batch 6. This page records what the relay enforces today.

## Two Workers

| Worker      | Reachable by        | Routes                                                                |
| ----------- | ------------------- | --------------------------------------------------------------------- |
| `relay`     | the public internet | `POST /pair/start`, `POST /pair/status`, `GET /agent/ws?install=<id>` |
| `dashboard` | Cloudflare Access   | static assets, `/api/*`, `GET /ws/browser?install=<id>`               |

The dashboard Worker binds the relay's Durable Objects with `script_name`. A single protected hostname cannot serve both, because Access in front of the agent route would block the agent.

## Browser authentication

- Every dashboard route, assets included, verifies the `Cf-Access-Jwt-Assertion` header with `jose`: RS256 signature from the team JWKS, issuer `https://<team domain>`, audience, expiry, and an email on the `ALLOWED_EMAILS` list. Missing configuration fails closed.
- `POST` routes need a same-origin `Origin` header and `application/json`. The WebSocket upgrade needs a same-origin `Origin`.
- The development bypass needs `ALLOW_DEV_AUTH=true` (in an untracked `.dev.vars`) and a loopback host. No tracked config mentions it, and a test proves that.
- Responses carry a strict CSP (`default-src 'none'` with `'self'` for scripts, styles, fonts, images and connections), `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

## Pairing

1. The agent generates an install id and an Ed25519 key, then calls `POST /pair/start`. The relay answers with an 8 character Crockford base32 code and the key fingerprint (first 8 bytes of SHA-256 of the raw public key, `xxxx-xxxx-xxxx-xxxx`).
2. The owner types the code into the dashboard. `POST /api/pair/lookup` shows the fingerprint so the owner can compare it with the one on the PC. `POST /api/pair/approve` accepts or rejects.
3. The agent polls `POST /pair/status`, signed with the new key over `pair-status-v1|installId|timestampMs` (timestamp within 5 minutes).

Limits: at most 20 pending pairings, 3 per hashed client address, 10 minute lifetime, single use. Codes are stored as SHA-256 only. An install that is already paired cannot start a pairing; the owner rotates it first (`POST /api/installs/:id/rotate`), which clears the key and kicks the agent. The agent then pairs again with the same install id and the owner approves again.

## Agent authentication

`hello`, then `auth-challenge` (32 random bytes, single use, 60 s), then `auth-response` with an Ed25519 signature over `agent-auth-v1|installId|sessionId|nonce|agentNonce`. The relay stores only the public key. An unknown install id is refused before any Durable Object is created. A socket that has not authenticated within 15 s is closed by an alarm. A new agent socket replaces the old one.

## Kill switch

`POST /api/installs/:id/revoke` marks the install locked in the Registry, closes the agent socket with a fatal `locked` error and rejects every browser action with `locked`. The agent cannot reconnect until `unlock`.

## What the relay stores

A Session Durable Object keeps, per install: the machine snapshot, session id, head sequence number, a ring of the last 64 discrete events, the last 128 action ids with their results, the last 32 prompt ids, a rate-limit bucket and an audit table capped at 2,000 rows. Audit rows hold a code and a short kebab-case detail, never a payload, path, name or address.
