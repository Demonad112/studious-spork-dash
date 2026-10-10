# Remote Console: kickoff prompt (v2)

Paste everything below the line into a new Claude Code session opened in the empty new repository. Attach `host-profile.md` with it.

---

## ROLE

Senior full-stack architect (Rust, TypeScript, Cloudflare Workers). Work in plan mode: produce a plan, wait for my "go", then build. This is a brand-new, independent repository.

## INPUTS

- This prompt.
- `host-profile.md` (attached). Commit it as `docs/host-profile.md` in Batch 0. It is the ONLY source of knowledge about the first host app (DeepServer 2). It was written from a read of that app's code on 2026-10-09.
- Do not open, clone, search or reference the host repository or any other repository. If the profile is missing something, state an assumption, record it in `docs/HANDOFF.md` under "Questions for the owner", and continue.

## MISSION

Build, from the ground up, a "remote console": a dashboard (a website only I can log into, mostly from my phone) that can view and control a Windows desktop application that opts in.

Reach this stage: with a SIMULATED app (`agent-sim`) I can arm the agent on a PC, open the dashboard from any device, see live progress, and press Finish / Next / Cancel when the app offers them, with everything reverting when the session ends. Later, a real app only implements one trait and supplies a credential store. Integration must be a small adapter, never a refactor.

The simulated app must behave like the real host described in `docs/host-profile.md` (section "Behaviours the simulator must reproduce"), so that passing e2e against the sim means the real adapter will work.

## TERMS

- **Install**: one enrolled copy of the agent (random 128-bit `installId`, one keypair).
- **Session**: one armed period on an install (random `sessionId`, own `seq` space). Ends on disarm.
- **Job**: one long-running task inside a session (random `jobId`). One job at a time per install.
- **Prompt**: a control the app is currently offering (`promptId`, `expects`). At most one open.
- **Armed**: the local user has switched remote control on. Only a local gesture can arm.

## HOUSE SETUP (the owner's conventions; replicate them)

- Rust edition 2021, rustfmt, `cargo clippy --workspace --all-targets -- -D warnings`, Apache-2.0, authors `["Demonad112"]`. serde 1.0.228 (derive), serde_json 1.0.150. Pin the toolchain in `rust-toolchain.toml`.
- Crates named `<area>-core`; flat modules re-exported from `lib.rs`; inline `#[cfg(test)]` tests plus `tests/` for integration; typed error enums with a `Result` alias; doc comments in plain sentences; test names are full snake_case sentences (`a_file_touched_again_after_arriving_is_counted_once`).
- Serde: structs camelCase. The host serialises enum values in camelCase too (`sizeAndTime`, `notCopied`). **The wire protocol in this repo uses kebab-case for `type`, event kinds and reason codes, by decision.** Document that the host adapter maps between the two; never leak host enum spellings onto the wire.
- New rule for this repo (not an existing host convention): secrets are wrapped in a `SecretString` whose `Debug` prints `**redacted**`.
- Frontend: Node 24 via corepack, pnpm@11.9.0, Vue 3.5.43 + TypeScript 5.9.3, Vite 8.3.2, Vitest 5.0.3 (jsdom), Tailwind CSS v4.3.3 (`@tailwindcss/vite`), `@lucide/vue`, prettier 3.9.9, vue-tsc 3.3.12, vue-router 5.3.1, husky + lint-staged (`prettier --write`; `rustfmt --edition 2021` for `*.rs`). No component library. Use these versions if they resolve; otherwise the nearest compatible, and list each deviation in the plan and in `CLAUDE.md`.
- Root `quality` script = prettier `--check`, typecheck (vue-tsc and tsc), rustfmt `--check`, clippy `-D warnings`. Prettier covers `.md` and `.json`, so format all docs.
- UI: Windows 11 Fluent look. Segoe UI Variable, 14px body, 28px page titles, 8px card radius, one accent, tabular numbers, light and dark themes. ALL colours are `--app-*` CSS tokens (light in `:root`, dark under `:root[data-theme='dark']`) exposed to Tailwind through `@theme inline`; never raw hex or palette colours in components. Start from the token set in `docs/host-profile.md`. One obvious primary action per screen.
- The dashboard is **mobile-first**: design at 390px wide, then 1440px. Touch targets at least 44px. The host app is checked at 175% scaling; the dashboard must not break at 200% zoom.
- Dev ports: dashboard Vite on **1440** (the host apps use 1420 and 1430), `wrangler dev` on 8787.
- Workflow: one batch = one branch; `git init -b main`; merge a batch into `main` (`--no-ff`) only when all gates are green; never merge on red; a flaky test is a bug to fix, not retry. Maintain `docs/HANDOFF.md` (short session state: Goal, State, Next, Needs the owner, Notes) and a root `CLAUDE.md` (rules, commands, layout, gotchas). Reference notes live in `docs/`, never only in the scratchpad. No remote exists yet: do not push.
- Known environment gotchas to carry into `CLAUDE.md`: Linux clippy does not see `#[cfg(windows)]` code, so also run `cargo clippy --all-targets --target x86_64-pc-windows-msvc -- -D warnings` on any crate with Windows code; on the owner's laptop Windows Application Control can block test binaries (os error 4551), so use `cargo test --workspace --no-fail-fast`; the Bash tool halves backslashes in heredocs, so write such files with Write/Edit.

## SYSTEM SHAPE

```
Agent (Rust, embedded in a Windows app) --outbound WSS--> Relay (Cloudflare Worker + Durable Objects) <--WSS-- Dashboard (Vue SPA, behind Cloudflare Access, 2FA)
```

- The agent never listens for inbound connections. It dials out only while armed locally.
- The relay is the only public endpoint. Browser routes sit behind Cloudflare Access; agent routes sit outside Access and use their own cryptographic auth.

## COMMITTED DECISIONS

Challenge only with a concrete reason. `[CHANGED]` marks a change from the first version of this prompt; `[NEW]` marks an addition. Both came from reading the host app and current Cloudflare docs.

### D1. Protocol (`protocol/`)

Versioned (`v: 1`) JSON messages. One source of truth: JSON Schema files plus golden fixtures in `protocol/fixtures/`, consumed by BOTH the Rust and TS test suites (contract tests). Max frame 16 KiB. Inbound actions: strict schema, unknown fields rejected. Events: unknown kinds and unknown enum values are ignored or mapped to `other` (forward compatible). Define version negotiation and bump rules.

| type             | direction                        | carries                                                                                                                                                            |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hello`          | agent or browser -> relay        | `role`, `protocolVersions`, agent only: `installId`, `sessionId`, `appId`, `agentVersion`                                                                          |
| `auth-challenge` | relay -> agent                   | `nonce`                                                                                                                                                            |
| `auth-response`  | agent -> relay                   | `agentNonce`, `signature`                                                                                                                                          |
| `auth-ok`        | relay -> agent, browser          | negotiated `v`, `serverTimeMs`                                                                                                                                     |
| `event`          | agent -> relay -> browser        | `seq`, `kind`, payload                                                                                                                                             |
| `action`         | browser -> relay -> agent        | `actionId`, `type`, `promptId` (for next/done)                                                                                                                     |
| `action-result`  | agent or relay -> browser        | `actionId`, `outcome` (accepted, rejected), `reason`                                                                                                               |
| `resync`         | browser -> relay, relay -> agent | `lastSeq`; answered with a `resync-result` header (`fromSeq`, `toSeq`, `gap`) followed by the snapshot and events as separate frames, never one frame over the cap |
| `ping` / `pong`  | both                             | nothing. **Byte-constant frames** `[NEW]` so the relay can answer with `setWebSocketAutoResponse` without waking the Durable Object                                |
| `error`          | relay or agent                   | `code`, `fatal`                                                                                                                                                    |

Event kinds: `job-started`, `step`, `progress`, `prompt-opened`, `prompt-closed` `[NEW]`, `status`, `armed-state`.

### D2. Data minimisation

Events carry only: `percent`, files and bytes done/total, three counters (`ok`, `skipped`, `failed`), a step id from an enum, a job kind from an enum, status, a failure CODE from an enum, prompt objects and a terminal summary of counts.

- `[CHANGED]` `percent`, `filesTotal` and `bytesTotal` are **nullable**. `null` means "not known yet" (the host lists the source before it knows totals). The dashboard shows an indeterminate bar for `null`.
- `[NEW]` Speed and time left are computed by the dashboard from byte deltas, as the host UI does. They are not sent.
- `[NEW]` Errors travel as codes (`cancelled`, `destination-not-writable`, `not-enough-space`, `source-unavailable`, `internal`, `other`), never as text: the host's error strings contain paths.
- NO file paths, file names, machine names, Windows user names, run ids from the host, or client/ticket/technician fields. The deny-list with the exact host fields is in `docs/host-profile.md`; a contract test must fail if any fixture or simulator event contains a path separator or a drive letter pattern.
- Prompt labels are ids from an enum (`finish-and-check`, `continue`, `confirm`, `other`). Optional free text is capped at 80 chars with control characters stripped.
- The install's display name is typed in the dashboard. The agent never sends a hostname.

### D3. Events and replay

Monotonic u64 `seq` per session. Progress is COALESCED into a latest-progress snapshot; the replay ring (default 256) holds discrete events only. `resync(lastSeq)` returns the later events plus the snapshot, or a gap marker so the client rebuilds from the snapshot.

- `[NEW]` The host emits progress every 100 ms. `agent-core` accepts that rate; the transport sends the snapshot at most once per second (configurable) and always flushes the latest snapshot BEFORE any discrete event, so ordering holds.
- `[NEW]` The relay persists the latest snapshot, state, open prompt and a small ring (64) in Durable Object storage, so a browser that attaches mid-job is served by the relay alone. Hibernation resets in-memory state; nothing needed for validation may live only in memory.
- `[NEW]` The relay keeps the last terminal summary after the agent disconnects, so the dashboard still shows "Completed, 3 not copied" until the next session starts.

### D4. State machine (identical in `agent-core` AND the relay)

| From                  | Trigger                                 | To                             |
| --------------------- | --------------------------------------- | ------------------------------ |
| Idle                  | `job-started`                           | Running                        |
| Running               | `prompt-opened`                         | AwaitingUser(prompt)           |
| AwaitingUser          | `prompt-closed` (any reason)            | Running                        |
| Running, AwaitingUser | `status` completed / cancelled / failed | Completed / Cancelled / Failed |
| terminal              | `job-started` (session still armed)     | Running                        |

- `[CHANGED]` **Prompts are non-blocking by default.** `progress` and `step` are legal in AwaitingUser: the host's "Finish and check" button is offered while files are still arriving. Prompts carry `promptId`, `expects` (next, done), `labelId` and `blocking` (bool, informational).
- `[NEW]` `prompt-closed` reasons: `answered-remote`, `answered-local`, `auto` (the app finished by itself), `superseded`, `timed-out`, `job-ended`. The local user can always press the same button in the app; a remote action that loses that race gets `stale-prompt`.
- `[NEW]` A step or phase named "done" is NOT terminal. Only a `status` event ends a job.
- `[NEW]` `accepted` for `cancel` or `done` means "requested". Cancel is cooperative in the host; the terminal `status` event is the confirmation. The dashboard shows "Cancelling…" / "Finishing…" until it arrives.
- Allowed actions: `status` always; `next` only if the open prompt expects next; `done` only if it expects done; `cancel` in Running and AwaitingUser. Action = `{actionId (8-64 chars [A-Za-z0-9-]), promptId, type}`. Allowlist-only, fail closed. Reject reasons: `disarmed`, `expired`, `unknown-action`, `invalid-state`, `stale-prompt`, `malformed`, `rate-limited`, `locked`. A duplicate `actionId` returns the original result and never re-applies (bounded dedup, 128). Token-bucket rate limit (5/s). BOTH sides validate; the agent never trusts the relay.
- `[NEW]` Never add an action that starts a job, takes a path, deletes, retries, recovers or elevates. The profile lists the host commands that must stay unreachable.

### D5. Agent auth

Ed25519 keypair generated on the agent at enrollment. The relay stores ONLY the public key, so a relay breach cannot impersonate the agent. Connect flow: relay sends a random nonce; the agent signs the domain-separated string `agent-auth-v1|installId|sessionId|nonce|agentNonce`; the relay verifies. Workers WebCrypto lists `Ed25519` for sign/verify (checked 2026-10-09; use the standard name, not `NODE-ED25519`). Re-verify; if it has changed, use ECDSA P-256 on both sides and note it. The private key goes through a `SecretStore` trait (in-memory impl now; DPAPI impl is a documented future Windows task).

### D6. Enrollment `[CHANGED]`: pairing code shown by the agent

Reason: I use the dashboard from my phone. A 128-bit code minted on the phone would have to be typed into the PC. Reverse it:

1. Agent generates `installId` and keypair, then POSTs `{installId, publicKey}` to `/pair/start` (no Access, rate limited, at most 20 pending, 10-minute TTL, single use). The relay returns a short pairing code (8 chars, Crockford base32, stored hashed).
2. The agent shows the code and the key fingerprint (first 8 bytes of SHA-256 of the public key, grouped). The host may render it as a QR code of `https://<dashboard>/pair#<code>`; the code is in the fragment so it never reaches server logs.
3. In the dashboard (behind Access) I enter or scan the code, see the same fingerprint, type a display name and approve. Only then does the Registry store the public key.
4. The agent polls `/pair/status` (signed with the new key) until approved, expired or rejected.

Support revoke and key rotation. A "Registry" Durable Object holds install metadata (id, display name, public key, locked flag); one "Session" Durable Object per install holds the sockets. In the plan, compare this with the original design (dashboard mints a 128-bit one-time code, agent POSTs it to `/enroll`) in three lines and keep whichever I pick at plan review; default to the pairing flow.

### D7. Browser auth

Cloudflare Access (email OTP or passkey, my identity only) in front of the dashboard, and the Worker MUST also verify the `Cf-Access-Jwt-Assertion` JWT itself: signature via the team JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), issuer, `aud`, `exp`, and an allowed-email list from env. Never trust headers alone. Check the WebSocket `Origin`, and check `Origin` plus JSON content type on every mutating HTTP route. Dev bypass exists ONLY behind `ALLOW_DEV_AUTH=true` in an untracked `.dev.vars`, with a test asserting the production wrangler config never enables it.

`[NEW]` Send a strict Content-Security-Policy with the SPA (no inline script, `connect-src 'self'`, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

### D8. Relay behaviour

Session DO uses WebSocket hibernation (`acceptWebSocket` with tags for role); at most 1 agent socket and 3 browser sockets; relays agent -> browser events; browser -> agent actions only after relay-side validation against the last known state read from storage; kill switch (dashboard "Revoke" closes the agent socket and sets `locked` so the agent cannot reconnect until unlocked); append-only audit log in SQLite DO storage, capped (2,000 rows) and viewable in the dashboard (connect/disconnect, arm state, every action accepted or rejected with reason code, pairing, revoke). No payload secrets in logs. The rate-limit bucket and the dedup set must survive hibernation.

`[NEW]` **Access and agent routes cannot share one protected hostname.** One-click Access on a `workers.dev` URL protects the whole Worker, which would block the agent. Resolve this in the plan from current docs. Default: two Workers, `relay` (public; agent routes; owns both Durable Object classes) and `dashboard` (behind Access; static assets and browser routes; binds the same Durable Objects with `script_name`). Fallback: one Worker on a custom domain with a path-scoped Access application. Either way browser routes fail closed on the JWT check.

### D9. Agent (Rust workspace)

- `agent-core`: std-only, synchronous, no threads or sockets. State machine, event ring with coalescing, action allowlist, armed gate, prompt-timeout policy (hold | auto-cancel), config struct (`enabled = false` by default, `validate()`), `AuditSink` (`JsonlAuditSink`, size-rotated, lazily created, plus `Memory`), `CleanupRegistry` with stale-artifact sweep, `PowerGuard` and `SecretStore` traits with no-op/in-memory impls, injectable `Clock` (`SystemClock`, `ManualClock`; unit tests never sleep). `RemoteControl` is `Send + Sync` behind one `Mutex`; compute effects under the lock and dispatch AFTER releasing it.
- `[CHANGED]` Arming: via an `ArmTrigger` trait, with a TTL chosen at arm time (4 h default; 12 h; "until this job ends"; hard cap 24 h). Auto-disarm on TTL, on drop, and on **idle 15 min counted only while no job is active**. A long copy must not be disarmed for being quiet. When the TTL ends mid-job the job carries on locally; only the remote side closes. After a terminal state the agent sends the `status` event, closes cleanly, and disarms unless `stay_armed_after_job` is set.
- `AppBridge` trait = the ONLY integration surface for a host app: app -> layer (`job_started`, `step`, `progress`, `prompt_opened`, `prompt_closed`, `status`) and layer -> app (`apply(action) -> Applied | NotApplicable`). `[NEW]` The emit side takes `&self`, is `Send + Sync`, never blocks, never returns an error and is a no-op when disarmed: the host calls it from a blocking worker thread next to its own UI channel and must never slow or fail a job because of it. Ship `SimulatedAppBridge`.
- `agent-ws`: the real outbound transport. A dedicated thread with its own current-thread tokio runtime so it embeds in a Tauri 2 host without touching the host's runtime; `tokio-tungstenite` with rustls using the **`ring` crypto provider** `[NEW]` (the default `aws-lc-rs` needs NASM/CMake on Windows MSVC builders) and no OpenSSL; reconnect with jittered backoff for as long as the session is armed; resume via `resync(lastSeq)`. Nothing is spawned or connected until armed; disarm or drop stops and joins the thread within 2 s so the host can exit.
- `[NEW]` TLS trust: decide in the plan between bundled roots (`webpki-roots`; fails closed behind corporate TLS inspection) and the OS store. Default to bundled roots with an explicit config switch for the OS store, and record the residual risk: an inspecting proxy trusted by the OS could read minimised events and inject allowlisted actions. HTTP proxy support is out of scope; say so in `docs/security.md`.
- `agent-sim`: a CLI binary with `pair` and `run` subcommands that plays named scripts (see the profile): `watch-finish`, `watch-auto`, `watch-local-finish`, `copy`, `copy-fail`, `preflight-next`, `cancel-midway`. It is the stand-in app for development and e2e.
- `examples/embedding.rs` plus `docs/integration-guide.md`: exactly how a host wires `AppBridge`, the `SecretStore`, the arm toggle, the data dir and the transport, using the "tee sink" pattern from the profile (the host's progress sink forwards to its UI channel AND to the bridge). The example defines its own stand-in sink trait; it must not contain host code.
- `[NEW]` The host will consume these crates as a Cargo git dependency pinned to a tag. Keep the public API small, document the MSRV, and tag `v0.1.0` at the end of Batch 6 (local tag only).

### D10. Dashboard (Vue SPA)

Installs list with status (offline / armed / running / waiting); a live panel that mirrors the host's own (step text, bar that is indeterminate when percent is `null`, Files "x of y" or "x found", Size, Speed and time left computed locally, a "Not copied" count in the danger colour when above zero); a prompt card whose Finish/Next buttons are enabled ONLY when the open prompt expects them; Cancel; pending states for requested actions; a connection indicator with last-seen time; the terminal summary; the audit view; Revoke/Unlock; the pairing approval screen with fingerprint; a theme toggle. Resumes via resync on reconnect. Served as static assets from a Worker.

### D11. Revert guarantees

With the feature off or disarmed the agent opens no ports and creates no files, threads, firewall rules, services, scheduled tasks or registry keys (a test proves it). Any future persistent artifact goes through the `CleanupRegistry`. The agent writes only under the `data_dir` the host passes in; it never works out its own location (the host has a portable mode).

### D12. Local control always wins `[NEW]`

The integration guide must require the host to show a visible "Remote control on" indicator while armed, with a one-click disarm, and the count of attached dashboards (the relay sends it in `armed-state`). Arming is never possible remotely.

## REPO LAYOUT (adjust only with reason)

`protocol/` (schemas, fixtures, README) · `agent/` (Cargo workspace: `agent-core`, `agent-ws`, `agent-sim`, `examples/`) · `relay/` (Worker(s), Durable Objects, wrangler config, vitest) · `dashboard/` (Vue SPA) · `e2e/` · `docs/` (`architecture.md`, `protocol.md`, `security.md`, `deploy.md`, `integration-guide.md`, `host-profile.md`, `HANDOFF.md`) · `.github/workflows/ci.yml` · `CLAUDE.md` · `README.md` · `SECURITY.md` · `LICENSE` (Apache-2.0).

## BATCHES (one branch each, in order)

| #   | Batch                                                                                                         | Done when                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 0   | Scaffold: monorepo, tooling, `quality` script, CI, `CLAUDE.md`, docs skeleton, `docs/host-profile.md`         | `corepack pnpm quality` green on an empty workspace; CI file lints                                                  |
| 1   | Protocol: schemas, fixtures, TS and Rust types, contract tests                                                | The same fixtures pass in both suites; the no-paths test fails on a planted path                                    |
| 2   | `agent-core` + `SimulatedAppBridge` + all sim scripts + unit tests                                            | Every row of the state and action tables has a test; no test sleeps                                                 |
| 3   | Relay: Registry and Session DOs, Access JWT verification, pairing, agent auth, validation, audit, kill switch | Validation still correct after a forced eviction (use the eviction test helper); prod config cannot enable dev auth |
| 4   | `agent-ws` + `agent-sim` + pairing flow                                                                       | `agent-sim run watch-finish` against `wrangler dev` shows events arriving; thread joins within 2 s on disarm        |
| 5   | Dashboard                                                                                                     | All screens at 390px and 1440px, light and dark; buttons enabled only when allowed                                  |
| 6   | e2e + hardening + security checklist + `docs/deploy.md` + tag `v0.1.0`                                        | Every scenario below passes three times in a row                                                                    |

e2e (local relay runtime + `agent-sim` + a Node WebSocket client standing in for the browser): progress -> prompt -> done -> completed; progress continues while a prompt is open; indeterminate then known totals; `watch-auto` closes the prompt without an action; `watch-local-finish` makes the remote `done` return `stale-prompt`; cancel is "accepted" then confirmed by `status`; browser attaches mid-job and is served by the relay; reconnect and replay, including a gap; duplicate and stale actions; revoke and locked reconnect; rate limits; disarmed and expired rejections; TTL expiry mid-job; a quiet 20-minute job is NOT idle-disarmed (ManualClock); the terminal summary survives agent disconnect; the "creates nothing" test.

## CLOUDFLARE RULES

Verify against CURRENT Cloudflare docs, not memory, and not this table alone. If a Cloudflare documentation-search tool is available, use it. Read-only.

| Topic                   | Seen in docs on 2026-10-09 (re-verify)                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ed25519                 | Workers Web Crypto lists `Ed25519` (Secure Curves) for sign, verify, generateKey, importKey, exportKey                                                                                                                                                                                                 |
| Access on `workers.dev` | Can be enabled per Worker (Settings > Domains & Routes) for `workers.dev` and preview URLs; no custom domain needed. Docs still say to validate the JWT in the Worker                                                                                                                                  |
| JWT validation          | Docs example uses `jose` (`createRemoteJWKSet`, `jwtVerify`) with env `TEAM_DOMAIN` and `POLICY_AUD`. A `ctx.access` identity API is mentioned; check it, keep explicit checks                                                                                                                         |
| Hibernation             | `ctx.acceptWebSocket(ws, tags)` (max 10 tags, 256 chars); `serializeAttachment` max 16,384 bytes; `setWebSocketAutoResponse` pair max 2,048 chars each; in-memory state is reset on hibernation; `setTimeout`/`setInterval` prevent hibernation; close frames auto-replied from compat date 2026-04-07 |
| DO storage              | New namespaces must be SQLite-backed (`new_sqlite_classes` migration). A newer declarative `exports` class lifecycle was announced mid-2026; check which to use                                                                                                                                        |
| Test integration        | Docs now name `@cloudflare/vitest-plugin` and install `vitest@^4.1.0`; older pages name `@cloudflare/vitest-pool-workers` (0.16.20+ has `evictDurableObject`). This may not accept the house Vitest 5.0.3: if so, pin a separate Vitest in `relay/` and list the deviation                             |
| Free plan               | Durable Objects are available on Workers Free (SQLite only). State the expected request and duration usage for a 12 h armed session in the plan                                                                                                                                                        |

Do NOT deploy, create, or modify anything in any Cloudflare account. `docs/deploy.md` must give exact copy-paste steps for me: wrangler secrets and vars, the Access application and policy (or the one-click route) for the dashboard Worker, confirming the agent routes are reachable without Access, pairing the first install, and rollback.

## PLAN PHASE (stop for my "go"; about 4 pages)

1. Conclusion in 5 lines or fewer.
2. Repo tree and per-batch task list: files, acceptance criteria, effort S/M/L.
3. Protocol message table with one example payload each, the event-kind table, and the state and action tables.
4. Trust-boundary and threat table (asset, threat, mitigation, residual risk). Include: relay breach, stolen Access session, pairing-code guessing and pending-slot flooding, TLS inspection, replay across sessions, a hostile relay sending actions, a local user racing a remote action.
5. Test strategy per layer plus the e2e scenarios.
6. Ranked risks, assumptions, and every decision you want to change with the reason. Explicitly answer: one Worker or two; pairing flow or minted code; bundled roots or OS store; which Vitest in `relay/`.
7. "Integration readiness": what the host must implement or supply (AppBridge via a tee sink, SecretStore, arm trigger and indicator, data dir, relay URL, pairing UI) and what stays unchanged, checked line by line against `docs/host-profile.md`.

## BUILD PHASE (after "go")

Execute Batches 0-6. Each batch ends with all gates green (or the stated scoped equivalent), an updated `docs/HANDOFF.md`, and a merge into local `main`. Stop at the end with a short summary of what is done and what I must do manually (Cloudflare setup, pushing the repo).

## OUTPUT RULES

Conclusion first; tables where they help; if you revise any decision or finding, say so explicitly and state what changed. If something material is ambiguous, state an assumption and continue instead of asking.

## DO NOT

- Open, read or reference any other repository, including the host's.
- Copy code from anywhere under a licence other than Apache-2.0 or MIT.
- Add inbound listeners on the agent, tunnels, or persistent OS changes.
- Add any remote action beyond status, next, done and cancel.
- Put paths, names, customer data, or secrets in events, logs, audit rows or fixtures.
- Deploy to or modify any Cloudflare account, push, or open PRs.
