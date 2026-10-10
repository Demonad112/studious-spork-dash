# Architecture

```
Agent (Rust, in the app) --outbound WSS--> Relay (Worker + Durable Objects) <--WSS-- Dashboard (Vue SPA, behind Access)
```

The agent never listens. It dials out only while the local user has armed it. The relay is the only public endpoint: browser routes sit behind Cloudflare Access and also verify the Access JWT; agent routes sit outside Access and use their own cryptographic authentication.

## Agent (`agent/`)

| Crate        | Role                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `agent-core` | Transport-free layer: wire types, state machine, replay ring, allowlist, arming, audit, cleanup. No sockets, no threads. |
| `agent-ws`   | The outbound WebSocket transport, identity key and pairing client. One thread while armed, none otherwise.               |
| `agent-sim`  | A stand-in app with named scripts, used for development and e2e. CLI: `pair` and `run <script>`.                         |

### The integration surface

A host app touches exactly three things:

1. **`AppBridge::apply(action)`**: the layer calls this when a remote `done`, `next` or `cancel` passes validation. It should call the same function as the matching local button and answer `Applied` or `NotApplicable`.
2. **`AppEvents`**: the host reports its job with `job_started`, `step`, `progress`, `prompt_opened`, `prompt_closed` and `status`. Every call takes `&self`, is `Send + Sync`, returns immediately, cannot fail, and does nothing while disarmed. It is safe to call from a blocking worker thread ten times a second.
3. **A `SecretStore`** for the private key, and a data folder.

Arming is a local gesture only: the host calls `RemoteControl::arm` (or implements `ArmTrigger`). There is no code path from a received frame to arming.

### Inside `RemoteControl`

- One mutex guards the session. Every method computes what to do under the lock and runs side effects (host callbacks, audit rows, power guard, waker) after releasing it, so a bridge may call back into the layer from `apply`.
- A **session** exists from arm to disarm: its own random id, sequence space, replay ring (256 discrete events), state machine, token bucket (5/s) and duplicate cache (128 action ids).
- **Progress is coalesced**: only the latest is kept, and at most one is queued per second. The pending snapshot is always queued before the next discrete event, so ordering holds.
- **Time-driven rules** run from `tick()` (about once a second): TTL expiry (4 h default, 12 h, until the job ends, hard cap 24 h); idle disarm after 15 minutes with no job running (a quiet long job is never idle); disarm after the terminal status has been flushed unless the host asked to stay armed; the prompt timeout policy (`Hold`, or `AutoCancel` which closes the prompt as `timed-out` and asks the app to cancel).
- **Attribution of a close**: the host reports what it saw. A local press that follows an accepted remote `done` or `next` for the same prompt is reported as `answered-remote`. A remote action that arrives after the prompt closed gets `stale-prompt`.

### Revert guarantees

Disabled or disarmed, the agent opens no ports and creates no files, folders or threads (`tests/creates_nothing.rs` proves it). It writes only under the `data_dir` the host passes in. Anything persistent goes through the `CleanupRegistry`, which is emptied on every disarm; stale leftovers from a crashed run are swept on arm.

### The transport (`agent-ws`)

`AgentWs::install` sets the layer's waker. Arming starts one thread named `remote-console-ws` with its own current-thread tokio runtime; disarming (or a new session id) makes it close the socket and exit, normally within a few milliseconds and always within the 2 s the host is promised. Disarmed, no thread, socket or file exists.

- **Connection:** `tokio-tungstenite` over rustls with the `ring` provider and the bundled `webpki-roots`. The `os-roots` cargo feature plus `WsConfig::trust_os_store` trusts the operating system store instead. `ws://` is allowed for development; the layer's config validation decides which URLs are accepted.
- **Handshake:** `hello`, `auth-challenge`, `auth-response` (Ed25519 over `agent-auth-v1|installId|sessionId|nonce|agentNonce`), `auth-ok`. The transport then marks the layer connected and answers the relay's `resync` through `RemoteControl::handle_frame`. It sends nothing else until that first resync has been answered.
- **Keepalive:** the byte-constant `ping` frame every 25 s; the relay answers without waking. Nothing heard for 75 s drops the connection.
- **Reconnect:** exponential 1 s to 60 s with jitter; the delay resets after a connection stayed authenticated for 10 s. A `locked`, `not-paired` or `unauthorized` error waits about 60 s instead, and `locked` also sets the layer's locked flag (cleared by the next `auth-ok`).
- **Identity:** `Identity` keeps a random install id and an Ed25519 seed in the host's `SecretStore` (names `remote-console-install-id`, `remote-console-signing-key`). `agent-sim` stores them as plain files under its data folder; a real host supplies DPAPI.
- **Pairing:** `agent_ws::pairing::{pair_start, pair_status}` are blocking `ureq` calls meant for the one-off enrolment screen, not the transport thread.
- **Observer:** an optional closure receives `TransportEvent`s (`Connecting`, `Authenticated`, `Disconnected(code)`, `Waiting(ms)`). They carry codes only.

## Relay (`relay/`)

Two Workers share two Durable Object classes (both SQLite-backed, migration `v1`).

| Part           | Role                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay` Worker | Public. Pairing endpoints and the agent WebSocket. Exports `RegistryDO` and `SessionDO`.                                                            |
| `dashboard`    | Behind Access. Assets, `/api/*`, the browser WebSocket. Binds the same classes with `script_name`. Handlers are factories so tests inject a JWKS.   |
| `RegistryDO`   | One instance. Installs, pending pairings, pairing audit.                                                                                            |
| `SessionDO`    | One per install. Hibernatable sockets (1 agent, 3 browsers), the stored machine, replay ring, dedup set, token bucket, issued prompt ids and audit. |

Everything the relay needs to validate an action lives in Durable Object SQLite, so an eviction changes nothing. The relay applies agent events with the same `Machine` as the agent and checks browser actions with the same `decideAction` before forwarding them; the agent checks again and never trusts the relay.

Local development runs two processes: `pnpm --filter @remote-console/relay dev:relay` (port 8787) and `dev:dashboard` (port 8788; copy `relay/.dev.vars.example` to `relay/.dev.vars` for the dev auth bypass). The dashboard process reaches the relay's Durable Objects across processes.

## Shared contracts

`protocol/fixtures` holds golden frames and two behaviour tables (`state-machine.json`, `action-rules.json`). Rust and TypeScript both run them, so the agent and the relay cannot drift apart.
