# Handoff

## Goal

Build the remote console (protocol, agent crates, relay, dashboard, e2e) so a real host app only implements `AppBridge` and a `SecretStore`.

## State

- Batch 0 (scaffold): merged.
- Batch 1 (protocol): merged.
- Batch 2 (`agent-core`): merged. State machine, ring with coalescing, allowlist, arming and TTL rules, audit, cleanup, power guard, secrets, simulator with all 7 scripts. 73 unit + 7 contract + 60 behaviour + 17 script + 2 table tests + the creates-nothing test, plus the TS machine and allowlist against the same shared tables.

## Next

**Batch 3: relay.** Nothing of it is written yet (an empty branch was discarded). Start from `main` with a new branch `batch-3-relay`. Design already decided, so do not re-litigate it:

### Spike first (30 minutes)

- Install in `relay/`: `jose@6.2.12`, `wrangler@4.149.0`, `@cloudflare/vitest-plugin@1.4.0` (peer range allows Vitest `^4.1.0 || ^5.0.0`, so use the house 5.0.3), `@remote-console/protocol` as `workspace:*`. Run `corepack pnpm install --no-frozen-lockfile` (CI=true freezes the lockfile).
- Check whether `@cloudflare/vitest-plugin` exports `evictDurableObject` and `evictAllDurableObjects` from `cloudflare:test`. If not, use `@cloudflare/vitest-pool-workers` 0.16.20 or later. The Cloudflare docs search tool was unavailable at the end of this session: re-verify against developers.cloudflare.com.
- Confirm a Durable Object bound with `script_name` from a second Worker works under `wrangler dev` (two config files, one process: `wrangler dev -c wrangler.relay.jsonc -c wrangler.dashboard.jsonc`).
- Decide `new_sqlite_classes` migration versus the newer declarative `exports` lifecycle from current docs. Default: `migrations` with `new_sqlite_classes`.

### Layout

```
relay/src/relay-worker.ts      public Worker; exports the Registry and Session DO classes
relay/src/dashboard-worker.ts  Access-protected Worker: assets, /api/*, /ws/browser
relay/src/registry-do.ts       installs, pending pairings, pairing audit
relay/src/session-do.ts        one per install: sockets, state, ring, dedup, bucket, audit
relay/src/{access,agent-auth,pairing,http,audit}.ts
relay/wrangler.relay.jsonc, wrangler.dashboard.jsonc, vitest.config.ts, test/
```

The dashboard Worker binds the same DOs with `script_name` set to the relay Worker. Handlers are factory functions (`createDashboardHandler({ jwks })`) so tests inject a local JWKS and call the handler directly with the relay test env.

### Behaviour

- **Browser auth**: verify `Cf-Access-Jwt-Assertion` with `jose` (signature via the team JWKS, issuer, `aud`, `exp`, email in the `ALLOWED_EMAILS` list) on every dashboard route including assets (`run_worker_first`). Fail closed. Mutating routes need a same-origin `Origin` and `application/json`; the WebSocket upgrade needs a same-origin `Origin`. Dev bypass only when `ALLOW_DEV_AUTH=true` in an untracked `.dev.vars` AND the host is localhost; a test parses both wrangler configs and asserts it is never enabled. Send CSP (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- **Pairing** (agent shows the code): `POST /pair/start {installId, publicKey}` on the relay Worker creates a pending row (cap 20 total, 3 per hashed IP, 10 minute TTL, single use), returns an 8 character Crockford base32 code (stored as SHA-256) and the fingerprint (first 8 bytes of SHA-256 of the raw public key as `xxxx-xxxx-xxxx-xxxx`). `POST /pair/status` is signed with the new key over `pair-status-v1|installId|timestampMs` (within 5 minutes). The dashboard calls `POST /api/pair/lookup {pairingCode}` (add `pair-lookup` and `pair-lookup-result` to `pairing.schema.json`, fixtures and a TS decoder) to show the fingerprint, then `POST /api/pair/approve`. Normalise typed codes (uppercase, O to 0, I and L to 1, drop spaces and hyphens). Rotation: `POST /api/installs/:id/rotate` clears the key and sets status `rekey`; the agent re-pairs with the same `installId`, and the owner approves again.
- **Agent auth**: `GET /agent/ws?install=<id>` on the relay Worker; check the Registry first (unknown install: 404, so random ids do not create DOs). In the Session DO: `hello` then `auth-challenge` (32 random bytes, single use, 60 s, stored in the socket attachment) then `auth-response`. Verify Ed25519 (`crypto.subtle`, standard name `Ed25519`, raw 32 byte key) over `agent-auth-v1|installId|sessionId|nonce|agentNonce`. Locked install: send `error locked` fatal and close. An alarm closes sockets that have not authenticated within 15 s (no `setTimeout`, it blocks hibernation). A new agent socket replaces an old one. After `auth-ok` send the agent `resync{lastSeq: head}`.
- **Hibernation**: `ctx.acceptWebSocket(ws, ['agent'|'browser'])`, `setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME))` in the constructor, keep little in the constructor. All validation state lives in DO SQLite, never only in memory: machine snapshot, session id, head seq, ring (64), dedup (128 action ids and results), token bucket (5/s), issued prompt ids (32), last terminal summary, audit (capped at 2,000 rows).
- **Session state**: apply agent events with the `Machine` from `@remote-console/protocol` (illegal events are dropped and audited). Discrete events must have `seq == head + 1`; progress carries the newest seq. A `snapshot` from the agent after resync is authoritative: restore the machine from it; if the resync result says `gap`, broadcast the snapshot to browsers, else forward the replayed events with `seq > old head`. A `hello` with a new `sessionId` resets the session; the previous terminal summary stays until then and survives agent disconnect.
- **Browser actions**: decode strictly (`reject_undecodable_action` semantics: unknown kind gives `unknown-action`, otherwise `malformed`). Order: malformed, locked, agent not connected or not armed (`disarmed`), expired, duplicate (return stored result; in flight: drop), rate limit, `decideAction` against stored state (`protocol/ts/src/machine.ts`), then forward to the agent. The agent's `action-result` is stored and broadcast to browsers. Max 1 agent and 3 browsers (`too-many-connections`). Send the agent a relay-origin `armed-state` (seq 0, `viewers`) when the browser count changes, and merged `armed-state` to browsers.
- **Browser protocol**: URL `/ws/browser?install=<id>`, then `hello`, `auth-ok`, the dashboard sends `resync{lastSeq}`; the relay answers `resync-result`, one `snapshot`, then ring events. A browser attached mid-job is served by the relay alone.
- **Kill switch**: `POST /api/installs/:id/revoke` sets `locked`, closes the agent socket, audits; `unlock` reverses. Also `rename`, `delete`.
- **Audit**: append-only table, no payloads, codes only: connect, disconnect, armed state, every action accepted or rejected with its reason, pairing, revoke, unlock. `GET /api/installs/:id/audit`.
- **Acceptance**: validation is still correct after a forced eviction (eviction helper); a config test proves production never enables dev auth; Ed25519 verify is tested with a key generated by the test; the same `state-machine.json` and `action-rules.json` tables already pass in TS.

### Then

- Batch 4: `agent-ws` (thread with its own current-thread tokio runtime, `tokio-tungstenite` with rustls and the `ring` provider, bundled `webpki-roots` with an OS-store switch, jittered reconnect, resync, join within 2 s, Ed25519 via `ed25519-dalek`) and the `agent-sim` CLI (`pair`, `run <script>`).
- Batch 5: dashboard. Batch 6: e2e, hardening, `docs/security.md`, `docs/deploy.md`, `docs/integration-guide.md`, local tag `v0.1.0`.

## Needs the owner

- Nothing yet. Cloudflare setup comes after Batch 6 (`docs/deploy.md`).
- Batches 0 to 2 were pushed to `claude/new-session-tbofgd` at your request. The kickoff prompt said not to push; say so if you want later batches held back locally again.

## Notes

- Revisions to the plan, all small: `relay/` uses Vitest 5.0.3 (the plugin accepts it); `auth-ok` carries the negotiated version in the frame's `v` instead of a separate field; the `action` frame names its kind in `action`; added a `snapshot` frame (needed by `resync-result`); the browser picks its install by URL; progress frames carry the newest discrete seq instead of consuming one; after `auth-ok` the relay sends the agent a `resync`.
- The TS decoder is hand written because ajv generates code at runtime, which Workers forbid. ajv is used only in Node tests.
- The wire `step` enum keeps `done` so the simulator can prove the dashboard never treats it as terminal. The host adapter drops it.
- `pnpm` in CI mode (`CI=true`) forces a frozen lockfile: use `pnpm install --no-frozen-lockfile` after changing dependencies.
- The creates-nothing test is one test function on purpose: parallel test threads would make the thread count meaningless.
- Local-vs-remote attribution is approximate within the host's polling gap (about 200 ms in the real host): the first press wins and a close that follows an accepted remote action is attributed to it.

## Prompt for the next chat

```
Continue the remote console build in this repo (branch claude/new-session-tbofgd, local main mirrors it).
Read, in order: docs/HANDOFF.md, CLAUDE.md, docs/kickoff-prompt.md (the original brief, v2), docs/host-profile.md, docs/protocol.md, docs/architecture.md.
Batches 0 to 2 are done and merged. Do Batch 3 (relay) exactly as designed in HANDOFF "Next", starting with the spike. Plan mode is over: build, with every gate green before merging a batch branch into main with --no-ff. Use CI=true for pnpm and --no-frozen-lockfile after dependency changes. Push the designated branch when a batch is merged and open a draft PR if none exists. Do not deploy or change any Cloudflare account. Update docs/HANDOFF.md at the end of each batch.
```

## Questions for the owner

- None yet.
