# Handoff

## Goal

Build the remote console (protocol, agent crates, relay, dashboard, e2e) so a real host app only implements `AppBridge` and a `SecretStore`.

## State

- Batch 0 (scaffold): merged.
- Batch 1 (protocol): merged.
- Batch 2 (`agent-core`): merged. State machine, ring with coalescing, allowlist, arming and TTL rules, audit, cleanup, power guard, secrets, simulator with all 7 scripts. 73 unit + 7 contract + 60 behaviour + 17 script + 2 table tests + the creates-nothing test, plus the TS machine and allowlist against the same shared tables.
- Batch 3 (relay): merged. Two Workers (`relay`, `dashboard`), `RegistryDO` and `SessionDO`, Access JWT verification, pairing, Ed25519 agent auth, hibernation-safe validation, kill switch, audit. 115 tests in `relay/` (84 workers-runtime, 9 node config, plus eviction, clock and Ed25519 tests) and 261 in `protocol/ts`. Added `pair-lookup` and `pair-lookup-result` to the pairing schema, fixtures and a strict TS decoder (`protocol/ts/src/pairing.ts`).
- Batch 4 (`agent-ws`, `agent-sim`): merged. `agent-ws` has the identity key, the pairing client, the TLS config, the backoff and the transport thread (11 unit and 7 integration tests against a stand-in relay on localhost). `agent-sim` has `pair` and `run <script>`. Acceptance was run for real: pair, approve through the dashboard process, `agent-sim run watch-finish`, a browser socket on the dashboard process saw every event, a remote `done` was accepted and attributed `answered-remote`, and the transport thread was gone 10 ms after disarm.

- Batch 5 (`dashboard/`): done on branch `claude/batch-5-default-main-00mu2i` (session branch name; `main` is the repository default). Vue SPA: installs list, install page (live panel, prompt card, summary, manage), audit view, pairing approval (reads the code from `/pair#<code>` and clears the fragment). 56 Vitest tests: live reducer, rate maths, socket client with a fake socket, labels exhaustive against the protocol enums and the relay's audit codes, components, and house rules (no raw colours, no inline script or style, no `v-html`, token sets match). Tried for real: relay and dashboard `wrangler dev`, `agent-sim pair` approved through the UI, `watch-finish` watched and finished from the UI, audit page, at 390px and 1440px in light and dark, no console or CSP errors, no horizontal overflow.

## Next

Batch 6 (e2e, hardening, `docs/security.md` threat table, `docs/deploy.md`, `docs/integration-guide.md`, local tag `v0.1.0`).

## Needs the owner

- Nothing yet. Cloudflare setup comes after Batch 6 (`docs/deploy.md`).
- Batches 0 to 4 were pushed and merged through draft PRs (#1 to #3), as the session instructions required. `CLAUDE.md` still says "no remote pushes, no PRs": that rule was written for the original brief, so say if you want it reworded or later batches held back locally.

## Notes

- Batch 5 details: the `dashboard` Worker now has an `assets` block in `relay/wrangler.dashboard.jsonc` (`../dashboard/dist`, `run_worker_first`, SPA fallback), so run `pnpm --filter @remote-console/dashboard build` before `dev:dashboard`. `pnpm --filter @remote-console/dashboard dev` serves Vite on 1440 and proxies `/api` and `/ws` to 8788 with Origin rewritten. The relay CSP is `style-src 'self'` and `script-src 'self'`: no inline `style="..."` in templates (use classes in `style.css`), and the theme bootstrap is the separate file `public/theme-init.js`. Dynamic `:style` bindings are fine (CSSOM). The dashboard reuses the protocol package's `Machine` and `decideAction`, so a button is enabled exactly when the relay would forward the action. Progress frames carry the newest discrete seq and are never deduplicated. A seq gap, or an event before the first snapshot, makes the client send one `resync` (collapsed until the snapshot arrives); the relay does not forward unknown event kinds, so one of those also costs one resync. Pending states (`Finishing…`, `Cancelling…`) clear on the confirming event, a rejection, or a dropped connection. Speed shows after 1 s of samples, time left after 3 s with a known total. Added token `--app-track` for the bar track. The 4-hour `armed-state` countdown uses `expiresAtMs` from the relay.

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
Continue the remote console build in this repo (origin/main is the source of truth: run `git fetch origin main` first and branch from it; push the designated session branch).
Read, in order: docs/HANDOFF.md, CLAUDE.md, docs/kickoff-prompt.md (the original brief, v2), docs/host-profile.md, docs/protocol.md, docs/architecture.md.
Batches 0 to 5 are done. Do Batch 6 (e2e, hardening, docs, tag) as designed in HANDOFF "Next". Plan mode is over: build, with every gate green before merging a batch branch into main with --no-ff. Use CI=true for pnpm and --no-frozen-lockfile after dependency changes. Push the designated branch when a batch is merged and open a draft PR if none exists. Do not deploy or change any Cloudflare account. Update docs/HANDOFF.md at the end of each batch.
```

## Questions for the owner

- None yet.
