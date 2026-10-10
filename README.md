# Remote Console

A dashboard, reachable only by its owner, that can view and control a Windows desktop app that opts in.

```
Agent (Rust, in the app) --outbound WSS--> Relay (Cloudflare Worker + DOs) <--WSS-- Dashboard (Vue SPA, behind Access)
```

- The agent never listens. It dials out only while the local user has armed it.
- Remote actions are limited to `status`, `next`, `done`, `cancel`.
- Events carry counters and codes only: no paths, names or machine identity.

See `docs/architecture.md`, `docs/protocol.md`, `docs/security.md`, `docs/deploy.md` and `docs/integration-guide.md`. Working rules are in `CLAUDE.md`.

## Quick start

```
corepack pnpm install
corepack pnpm quality
```

Licensed under Apache-2.0.
