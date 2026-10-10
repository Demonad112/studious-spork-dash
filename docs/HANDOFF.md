# Handoff

## Goal

Build the remote console (protocol, agent crates, relay, dashboard, e2e) so a real host app only implements `AppBridge` and a `SecretStore`.

## State

- Batch 0 (scaffold): merged.
- Batch 1 (protocol): merged.
- Batch 2 (`agent-core`): merged. State machine, ring with coalescing, allowlist, arming and TTL rules, audit, cleanup, power guard, secrets, simulator with all 7 scripts. 73 unit + 7 contract + 60 behaviour + 17 script + 2 table tests + the creates-nothing test, plus the TS machine and allowlist against the same shared tables.

## Next

- Batch 3: relay (Registry and Session DOs, Access JWT verification, pairing, agent auth, validation, audit, kill switch). Start with a spike: cross-script DO binding with `script_name`, and whether `@cloudflare/vitest-plugin` exports `evictDurableObject`.

## Needs the owner

- Nothing yet. Cloudflare setup comes after Batch 6 (`docs/deploy.md`).

## Notes

- Revisions to the plan, all small: `relay/` uses Vitest 5.0.3 (the plugin accepts it); `auth-ok` carries the negotiated version in the frame's `v` instead of a separate field; the `action` frame names its kind in `action`; added a `snapshot` frame (needed by `resync-result`); the browser picks its install by URL; progress frames carry the newest discrete seq instead of consuming one; after `auth-ok` the relay sends the agent a `resync`.
- The TS decoder is hand written because ajv generates code at runtime, which Workers forbid. ajv is used only in Node tests.
- The wire `step` enum keeps `done` so the simulator can prove the dashboard never treats it as terminal. The host adapter drops it.
- `pnpm` in CI mode (`CI=true`) forces a frozen lockfile: use `pnpm install --no-frozen-lockfile` after changing dependencies.
- The creates-nothing test is one test function on purpose: parallel test threads would make the thread count meaningless.
- Local-vs-remote attribution is approximate within the host's polling gap (about 200 ms in the real host): the first press wins and a close that follows an accepted remote action is attributed to it.

## Questions for the owner

- None yet.
