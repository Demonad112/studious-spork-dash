# Remote Console: working rules

Dashboard (Vue SPA, behind Cloudflare Access) <-> relay (Cloudflare Workers + Durable Objects) <-> agent (Rust, embedded in a Windows app). Brand-new independent repo. The only knowledge of the first host app is `docs/host-profile.md`. Never open, clone or reference the host repo or any other repo.

## Rules

- One batch = one branch (`batch-N-name`). Merge into `main` with `--no-ff` only when every gate is green. Never merge on red. A flaky test is a bug.
- No remote pushes, no PRs, no Cloudflare account changes. `docs/deploy.md` is for the owner to run.
- Wire protocol is kebab-case (`type`, event kinds, reason codes); structs are camelCase. Host enum spellings never reach the wire.
- No paths, file names, machine or user names, host run ids or secrets in events, logs, audit rows or fixtures. A contract test enforces it.
- Secrets use `SecretString` (`Debug` prints `**redacted**`).
- Remote actions are exactly `status`, `next`, `done`, `cancel`. Never add one that starts a job, takes a path, deletes, retries, recovers or elevates.
- All UI colours are `--app-*` tokens. No raw hex or palette colours in components.
- Rust: edition 2021, rustfmt, clippy `-D warnings`, test names are full snake_case sentences, doc comments in plain sentences. Crates are `<area>-core`.
- Update `docs/HANDOFF.md` at the end of every batch.

## Commands

| Task                | Command                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Install             | `corepack pnpm install`                                                                                                    |
| All gates           | `corepack pnpm quality`                                                                                                    |
| TS tests            | `corepack pnpm test:ts`                                                                                                    |
| Rust tests          | `corepack pnpm test:rust` (uses `--no-fail-fast`)                                                                          |
| Windows-only clippy | `cargo clippy --manifest-path agent/Cargo.toml -p agent-core --all-targets --target x86_64-pc-windows-msvc -- -D warnings` |
| Dev ports           | dashboard Vite 1440, `wrangler dev` 8787                                                                                   |

## Layout

`protocol/` schemas, fixtures, TS types (`protocol/ts`) · `agent/` Cargo workspace (`agent-core`, `agent-ws`, `agent-sim`) · `relay/` Workers · `dashboard/` Vue SPA · `e2e/` · `docs/`.

## Gotchas

- Linux clippy does not see `#[cfg(windows)]` code: also run the Windows-target clippy on any crate with Windows code.
- On the owner's laptop Windows Application Control can block test binaries (os error 4551): use `cargo test --workspace --no-fail-fast`.
- The Bash tool halves backslashes in heredocs: write files containing them with Write/Edit.
- Prettier covers `.md` and `.json`: format docs.
- `CI=true` makes pnpm freeze the lockfile and stops it asking to reinstall: set it on every pnpm call in the sandbox, and add `--no-frozen-lockfile` after changing dependencies.
- `esbuild` and `workerd` need `allowBuilds: true` in `pnpm-workspace.yaml` or their binaries are missing.
- Do not run `pkill`/`pgrep -f` on `wrangler`: the pattern matches the Bash tool's own shell and kills it.
- Vitest in `relay/` keeps Durable Object storage across tests in one file: reset what a test fills.
- pnpm may add `minimumReleaseAgeExclude` entries to `pnpm-workspace.yaml` for freshly released pins. That is expected.

## Version deviations from the kickoff prompt

| Item               | Prompt           | Used         | Why                                                            |
| ------------------ | ---------------- | ------------ | -------------------------------------------------------------- |
| Node               | 24               | 22 (sandbox) | The build sandbox ships Node 22.22. `engines` allows >=22.     |
| Vitest in `relay/` | pin separate 4.x | 5.0.3        | `@cloudflare/vitest-plugin` peer range is `^4.1.0 \|\| ^5.0.0` |

Every other pinned version resolved as given.
