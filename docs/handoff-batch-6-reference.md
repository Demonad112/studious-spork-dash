> This file was compiled by an assistant from a prior conversation on this project. Treat it as background material, not verified fact — reason independently before relying on anything here, especially items presented as correct, decided, or working. It is meant to bring a new collaborator up to speed, not to define how they should proceed.

# Reference: Remote Console, Batch 6 in progress

## Quick Recap

Remote Console is a monorepo (`Demonad112/studious-spork-dash`): a Rust agent embedded in a Windows app, two Cloudflare Workers with Durable Objects (`relay` for agents, `dashboard` behind Access), and a Vue dashboard. Batches 0 to 5 are merged into `main` (the default branch). Batch 6 (e2e, hardening, docs, local tag `v0.1.0`) is partly done: the `e2e/` suite and an agent change are pushed on `claude/batch-5-default-main-00mu2i` with draft PR https://github.com/Demonad112/studious-spork-dash/pull/7. The docs, the embedding example, the HANDOFF update and the tag are not done yet.

## Working Context

**Done in Batch 6 so far (commit `bf0be6e`, PR #7):**

- `e2e/` package (`@remote-console/e2e`): vitest `globalSetup` builds `agent-sim`, builds the dashboard if `dashboard/dist` is missing, then starts `wrangler dev` for the relay (8797) and dashboard (8798). The dev auth bypass is passed as `--var ALLOW_DEV_AUTH:true`, so no `.dev.vars` file is needed. Each test pairs a fresh install through the real HTTP flow (`agent-sim pair`, then `POST /api/pair/approve`) and drives the relay with a `ws` client acting as the browser.
- 18 scenarios in `e2e/test/flow.e2e.ts` and `relay.e2e.ts`. They passed three runs in a row locally.
- `pnpm test:e2e` at the root, and a CI `e2e` job. The e2e package's script is named `e2e`, not `test`, so `pnpm test:ts` skips it.
- The agent transport (`agent/agent-ws/src/transport.rs`) now sends an `armed-state` event (seq 0, `expiresAtMs` from the layer) after the first relay `resync`. Before this the dashboard countdown and the relay's `expired` rejection were dormant. This is a behaviour change from the earlier design.

**Not done (from the kickoff brief, `docs/kickoff-prompt.md`):**

1. `docs/security.md`: finish the trust-boundary and threat table (the page currently says "finished in Batch 6").
2. `docs/deploy.md`: currently a stub ("To be written"). It is for the owner to run; no Cloudflare account changes by the agent.
3. `docs/integration-guide.md`: currently a stub. It should cover wiring `AppBridge`, the `SecretStore`, the arm toggle, the data dir, the transport and the "tee sink" pattern from `docs/host-profile.md`. It must require a visible "Remote control on" indicator with one-click disarm and the attached-dashboard count (D12).
4. `agent/agent-core/examples/embedding.rs` (or similar): own stand-in sink trait, no host code. Also document the MSRV.
5. Update `docs/HANDOFF.md` (Batch 6 status, new "Next", next-chat prompt), `docs/architecture.md` if useful.
6. Local tag `v0.1.0` after all gates are green and the branch is merged (local only per the brief; remote pushes of tags were not discussed).
7. Possible hardening items the brief lists: scenarios not covered by e2e because they are covered at a lower level (see below).

**Scenario coverage notes (inferred, worth re-checking):**

- Covered by `agent-core` tests with `ManualClock`: quiet 20-minute job not idle-disarmed, TTL expiry, creates-nothing.
- Covered by relay vitest only: replay with a real ring-overflow gap (the simulator emits too few discrete events to overflow the 64-event ring), `expired` rejection, rate-limit refill.
- e2e rate-limit test asserts "at least one rate-limited" in a burst of 12 `status` actions.

**Local environment facts:**

- Use `CI=true` on every pnpm call and `--no-frozen-lockfile` after dependency changes. The e2e dependencies (`ws` 8.21.0, `@types/ws` 8.18.1) are already in the lockfile.
- Husky pre-commit needs `CI=true` on `git commit`.
- Do not `pkill`/`pgrep -f` wrangler. The e2e teardown kills the process groups it started.
- The branch `claude/batch-5-default-main-00mu2i` was reset to `origin/main` after PR #6 merged, then pushed with new work. PR #7 is a fresh draft; PR #6 is merged and must not be reused.
- Gates run locally and green at the last commit: `corepack pnpm quality`, `test:ts` (protocol 261, relay 115, dashboard 56), `test:rust`, `test:e2e` x3. CI for PR #7 had not been checked yet when this was written.

## Deep Reference

### e2e harness API (`e2e/test/harness.ts`)

- `start(script, { watchFirst })` pairs an install, optionally connects a `Browser` first, starts `agent-sim run <script>`, registers cleanup.
- `Browser`: `connect(lastSeq)` does hello, auth-ok, resync, waits for snapshot. `action(kind, promptId?, actionId?)`, `result(id)`, `event(kind, match?)`, `events(kind?)`, `lastSeq()` (snapshot and non-progress events; armed-state frames carry seq 0).
- `Install.pair()`, `install.run(script)`; `Agent.output`, `exited()`, `kill()`.
- Prompt ids must match `^[A-Za-z0-9-]{1,32}$`; a UUID (36 chars) is answered `malformed`, not `stale-prompt`.
- Relay `resync-result.fromSeq` is `lastSeq + 1` (or `head + 1` when the browser is ahead).
- The terminal event is `{kind:'status', status:'completed'|'cancelled'|'failed', failureCode?, summary?}`.

### Simulator timing (`agent/agent-core/src/sim.rs`)

100 ms ticks. Listing takes 10 ticks (indeterminate progress), then the watch scripts open a `done` prompt. `watch-finish` waits for a remote or local done; `watch-auto` closes the prompt itself (reason `auto`) after all files arrive; `watch-local-finish` closes it after 5 watch ticks (`answered-local`). `agent-sim run` exits 0 once the job finishes, the layer disarms and the transport thread has stopped within 2 s.

### Transport change

In `on_text` (`transport.rs`), when the first `Frame::Resync` is received, after answering it, the transport sends `Frame::Event(EventFrame { seq: 0, body: ArmedState { armed: true, expires_at_ms: rc.view().expires_at_ms, viewers: None } })`. The relay's `onAgentArmedState` stores it and rebroadcasts the merged armed frame (with viewer count) to browsers.

### Project rules worth re-reading (`CLAUDE.md`)

Wire kebab-case, structs camelCase; no paths, names, host run ids or secrets in events, logs, audit rows or fixtures; remote actions exactly `status`, `next`, `done`, `cancel`; all UI colours are `--app-*` tokens; Rust clippy `-D warnings`, test names are full snake_case sentences; Prettier covers `.md` and `.json`; update `docs/HANDOFF.md` at the end of every batch; merge with `--no-ff` only when every gate is green.
