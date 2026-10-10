# Handoff

## Goal

Build the remote console (protocol, agent crates, relay, dashboard, e2e) so a real host app only implements `AppBridge` and a `SecretStore`.

## State

- Batch 0 (scaffold): merged.
- Batch 1 (protocol): merged.
- Batch 2 (`agent-core`): merged. State machine, ring with coalescing, allowlist, arming and TTL rules, audit, cleanup, power guard, secrets, simulator with all 7 scripts. 73 unit + 7 contract + 60 behaviour + 17 script + 2 table tests + the creates-nothing test, plus the TS machine and allowlist against the same shared tables.
- Batch 3 (relay): merged. Two Workers (`relay`, `dashboard`), `RegistryDO` and `SessionDO`, Access JWT verification, pairing, Ed25519 agent auth, hibernation-safe validation, kill switch, audit. 115 tests in `relay/` (84 workers-runtime, 9 node config, plus eviction, clock and Ed25519 tests) and 261 in `protocol/ts`. Added `pair-lookup` and `pair-lookup-result` to the pairing schema, fixtures and a strict TS decoder (`protocol/ts/src/pairing.ts`).
- Batch 4 (`agent-ws`, `agent-sim`): merged. `agent-ws` has the identity key, the pairing client, the TLS config, the backoff and the transport thread (11 unit and 7 integration tests against a stand-in relay on localhost). `agent-sim` has `pair` and `run <script>`. Acceptance was run for real: pair, approve through the dashboard process, `agent-sim run watch-finish`, a browser socket on the dashboard process saw every event, a remote `done` was accepted and attributed `answered-remote`, and the transport thread was gone 10 ms after disarm.

## Next

**Batch 5: dashboard** (Vue SPA served by the `dashboard` Worker). Start from `main` with a new branch `batch-5-dashboard`. The relay and the agent both exist now, so the dashboard can be built and tried against the real thing: `agent-sim run <script>` plus the two `wrangler dev` processes (see Notes) is a full local stack.

Then Batch 6 (e2e, hardening, `docs/security.md` threat table, `docs/deploy.md`, `docs/integration-guide.md`, local tag `v0.1.0`).

## Needs the owner

- Nothing yet. Cloudflare setup comes after Batch 6 (`docs/deploy.md`).
- Batches 0 to 2 were pushed to `claude/new-session-tbofgd` at your request. The kickoff prompt said not to push; say so if you want later batches held back locally again.

## Notes

- Batch 4 details: local stack is `dev:relay` (8787) and `dev:dashboard` (8788) from `relay/`, with `cp .dev.vars.example .dev.vars` first (the dashboard's `package.json` script does not pass `--var`; the bypass comes from `.dev.vars`, which is gitignored). Then `cargo run -p agent-sim -- pair --data-dir <dir>`, approve the code with `POST /api/pair/approve` (Origin `http://localhost:8788`), then `agent-sim run watch-finish --data-dir <dir>`. The data folder defaults to `.agent-sim/` (gitignored). `ring` cannot be cross-compiled to the Windows target on Linux, so the Windows-target clippy command in CLAUDE.md works for `agent-core` only; `agent-ws` has no Windows-only code and CI's native Windows job covers it. The agent never sends `armed-state` yet, so the relay's `expired` rejection stays dormant (Batch 6 can add it). The transport sends nothing until it has answered the relay's first `resync`.

- Relay spike results: `@cloudflare/vitest-plugin` 1.4.0 runs on Vitest 5.0.3 and exports `evictDurableObject`, `evictAllDurableObjects`, `runInDurableObject`, `runDurableObjectAlarm` and `listDurableObjectIds`. `new_sqlite_classes` migrations are used (not the declarative `exports` lifecycle). A Durable Object bound with `script_name` from a second Worker works, including across two separate `wrangler dev` processes. With `-c a -c b` in one process only the first config is routed to the port, so local dev uses two processes (`dev:relay` on 8787, `dev:dashboard` on 8788). `crypto.subtle` `Ed25519` works in workerd, and Node's `ed25519` keys interoperate (raw 32 byte public key, 64 byte signature).
- Relay design points worth knowing: the agent sends no `armed-state` itself, so the relay treats an authenticated agent socket as armed and takes `expiresAtMs` from an agent `armed-state` event if one arrives (the Rust agent does not send one yet; the relay's `expired` rejection stays dormant until it does). The registry passes the public key and lock flag to the Session DO in internal `x-rc-*` headers, which the Workers build fresh (client headers are never forwarded). Rejections before the duplicate check (malformed, locked, disarmed, expired) are not stored in the dedup set; later ones are. Actions in flight when the agent disconnects are answered `disarmed`. An unknown event kind consumes its sequence number but is not stored or forwarded. A browser whose `lastSeq` is ahead of the relay's head (older session) gets `gap: false` and a fresh snapshot at the head. `wipe`/`delete` clears the stored session.
- Vitest in `relay/` keeps Durable Object storage across tests in one file, so tests that fill shared state (the Registry's pending table) reset it in `beforeEach`.
- `pnpm-workspace.yaml` now has `allowBuilds` set to true for `esbuild` and `workerd`; without it the workerd binary is not installed.
- Revisions to the plan, all small: `relay/` uses Vitest 5.0.3 (the plugin accepts it); `auth-ok` carries the negotiated version in the frame's `v` instead of a separate field; the `action` frame names its kind in `action`; added a `snapshot` frame (needed by `resync-result`); the browser picks its install by URL; progress frames carry the newest discrete seq instead of consuming one; after `auth-ok` the relay sends the agent a `resync`.
- The TS decoder is hand written because ajv generates code at runtime, which Workers forbid. ajv is used only in Node tests.
- The wire `step` enum keeps `done` so the simulator can prove the dashboard never treats it as terminal. The host adapter drops it.
- `pnpm` in CI mode (`CI=true`) forces a frozen lockfile: use `pnpm install --no-frozen-lockfile` after changing dependencies.
- The creates-nothing test is one test function on purpose: parallel test threads would make the thread count meaningless.
- Local-vs-remote attribution is approximate within the host's polling gap (about 200 ms in the real host): the first press wins and a close that follows an accepted remote action is attributed to it.

## Prompt for the next chat

```
Continue the remote console build in this repo (local main is the source of truth; push the designated session branch).
Read, in order: docs/HANDOFF.md, CLAUDE.md, docs/kickoff-prompt.md (the original brief, v2), docs/host-profile.md, docs/protocol.md, docs/architecture.md.
Batches 0 to 4 are done and merged. Do Batch 5 (dashboard) as designed in HANDOFF "Next". Plan mode is over: build, with every gate green before merging a batch branch into main with --no-ff. Use CI=true for pnpm and --no-frozen-lockfile after dependency changes. Push the designated branch when a batch is merged and open a draft PR if none exists. Do not deploy or change any Cloudflare account. Update docs/HANDOFF.md at the end of each batch.
```

## Questions for the owner

- None yet.
