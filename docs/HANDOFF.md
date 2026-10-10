# Handoff

## Goal

Build the remote console (protocol, agent crates, relay, dashboard, e2e) so a real host app only implements `AppBridge` and a `SecretStore`.

## State

- Batch 0 (scaffold): merged.
- Batch 1 (protocol): merged. Schemas, 34 valid / 33 invalid / 8 lenient / 5 deny fixtures, TS decoder, Rust `wire` and `deny` modules, contract tests in both languages.

## Next

- Batch 2: `agent-core` state machine, ring, allowlist, arming, `AppBridge`, `SimulatedAppBridge`, sim scripts.

## Needs the owner

- Nothing yet. Cloudflare setup comes after Batch 6 (`docs/deploy.md`).

## Notes

- Revisions to the plan, all small: `relay/` uses Vitest 5.0.3 (the plugin accepts it); `auth-ok` carries the negotiated version in the frame's `v` instead of a separate field; the `action` frame names its kind in `action`; added a `snapshot` frame (needed by `resync-result`); the browser picks its install by URL.
- The TS decoder is hand written because ajv generates code at runtime, which Workers forbid. ajv is used only in Node tests to prove the schema agrees with the fixtures and the decoders.
- The wire `step` enum keeps `done` so the simulator can prove the dashboard never treats it as terminal. The host adapter drops it.
- `pnpm` in CI mode (`CI=true`) forces a frozen lockfile: use `pnpm install --no-frozen-lockfile` after changing dependencies.

## Questions for the owner

- None yet.
