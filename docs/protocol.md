# Protocol (version 1)

JSON text frames over WebSocket. Every frame is an object with `v` (the version) and `type`. Maximum size 16 KiB, measured in UTF-8 bytes. Struct fields are camelCase; `type`, event kinds and every reason or enum code are kebab-case. Host enum spellings never reach the wire: the host adapter maps them.

## Decoding rules

- **Strict** for everything a peer acts on: `hello`, `auth-*`, `action`, `action-result`, `resync`, `resync-result`, `ping`, `pong`, `error`. Unknown fields, bad ids, bad enum values and wrong field combinations are rejected as `malformed`.
- **Lenient** for `event` and `snapshot` (forward compatibility). Unknown event kinds are ignored but keep their `seq`. An unknown value in an enum that has an `other` member (`jobKind`, `step`, `labelId`, `failureCode`) is mapped to `other`. An unknown value in an enum without one (`expects`, `reason` of `prompt-closed`, `status`) makes the whole event unknown. Extra fields are dropped.
- Size is checked before parsing. Error text names a field, never a value.

## Frames

| type             | Direction                        | Carries                                                                                            |
| ---------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `hello`          | agent or browser -> relay        | `role`, `protocolVersions`; agent only: `installId`, `sessionId`, `appId`, `agentVersion`          |
| `auth-challenge` | relay -> agent                   | `nonce` (32 random bytes, base64url, single use, 60 s)                                             |
| `auth-response`  | agent -> relay                   | `agentNonce`, `signature` (Ed25519, base64url)                                                     |
| `auth-ok`        | relay -> agent, browser          | `serverTimeMs`. The frame's `v` is the negotiated version.                                         |
| `event`          | agent -> relay -> browser        | `seq`, `kind`, payload                                                                             |
| `action`         | browser -> relay -> agent        | `actionId`, `action` (`status`, `next`, `done`, `cancel`), `promptId` (required for next and done) |
| `action-result`  | agent or relay -> browser        | `actionId`, `outcome`, `reason` (only when rejected), optional `state`                             |
| `resync`         | browser -> relay, relay -> agent | `lastSeq`                                                                                          |
| `resync-result`  | relay or agent -> requester      | `fromSeq`, `toSeq`, `gap`; followed by one `snapshot` and then the replayed `event` frames         |
| `snapshot`       | relay or agent -> requester      | everything needed to rebuild a view: state, job, latest progress, open prompt, last terminal       |
| `ping` / `pong`  | both                             | nothing. Byte-constant frames `{"v":1,"type":"ping"}` and `{"v":1,"type":"pong"}`.                 |
| `error`          | relay or agent                   | `code`, `fatal`                                                                                    |

The `action` frame names its kind in `action` because `type` already says the frame is an action. A browser selects the install it watches by URL (`/ws/browser?install=<id>`), not in `hello`.

### Event kinds

| kind            | Payload                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `job-started`   | `jobId` (32 hex), `jobKind`                                                                                                              |
| `step`          | `step`                                                                                                                                   |
| `progress`      | `step`, `percent` (0-100 or null), `filesDone`, `filesTotal` (nullable), `bytesDone`, `bytesTotal` (nullable), `ok`, `skipped`, `failed` |
| `prompt-opened` | `promptId`, `expects` (`next` or `done`), `labelId`, `blocking`, optional `text` (80 chars, no controls, no path separators)             |
| `prompt-closed` | `promptId`, `reason`                                                                                                                     |
| `status`        | `status` (`completed`, `cancelled`, `failed`), optional `failureCode`, optional `summary` (counts only)                                  |
| `armed-state`   | `armed`, `expiresAtMs` (nullable), optional `viewers` (set by the relay only)                                                            |

`null` for `percent`, `filesTotal` and `bytesTotal` means "not known yet". Speed and time left are computed by the dashboard from byte deltas and never sent. A step named `done` closes a step, not the job: only `status` ends a job.

### Enums

| Enum          | Values                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jobKind`     | `record-copy`, `record-watch`, `compare`, `disk-scan`, `simulated`, `other`                                                                                  |
| `step`        | `listing-source`, `copying`, `watching`, `finishing`, `done`, `other`                                                                                        |
| `labelId`     | `finish-and-check`, `continue`, `confirm`, `other`                                                                                                           |
| close reason  | `answered-remote`, `answered-local`, `auto`, `superseded`, `timed-out`, `job-ended`                                                                          |
| `failureCode` | `cancelled`, `destination-not-writable`, `not-enough-space`, `source-unavailable`, `internal`, `other`                                                       |
| reject reason | `disarmed`, `expired`, `unknown-action`, `invalid-state`, `stale-prompt`, `malformed`, `rate-limited`, `locked`                                              |
| session state | `idle`, `running`, `awaiting-user`, `completed`, `cancelled`, `failed`                                                                                       |
| error code    | `malformed`, `unsupported-version`, `unauthorized`, `not-paired`, `locked`, `expired`, `too-many-connections`, `rate-limited`, `frame-too-large`, `internal` |

## Data minimisation

Events carry counters, enum ids and codes only. Never on the wire: paths, file names, machine or Windows user names, host run ids, client, ticket or technician fields, error text, hashes. `protocol/deny-list.json` lists the field names; value patterns reject path separators and drive letters. Contract tests scan every fixture and, from Batch 2, every event the simulator emits.

## Sequencing and replay

- `seq` is a monotonic u64 per session, starting at 1. `armed-state` events from the relay use `seq` 0 and are not replayed.
- Progress is coalesced into a latest-progress snapshot. The replay ring (agent 256, relay 64) holds discrete events only.
- The transport sends the progress snapshot at most once per second (configurable) and always flushes it before a discrete event, so ordering holds.
- `resync(lastSeq)` is answered by `resync-result`, then one `snapshot`, then every later event the ring still holds. `gap: true` means the ring no longer reaches back to `lastSeq`: the client rebuilds from the snapshot alone.

## Authentication

Browsers authenticate at the HTTP upgrade with the Cloudflare Access JWT, then send `hello` and receive `auth-ok`.

Agents: `hello`, then `auth-challenge`, then `auth-response` carrying an Ed25519 signature over the UTF-8 string

```
agent-auth-v1|<installId>|<sessionId>|<nonce>|<agentNonce>
```

The relay stores only the public key. The nonce is single use and expires in 60 s.

## Version negotiation and bump rules

`hello.protocolVersions` lists the versions the sender speaks. The relay picks the highest it also speaks and uses it as `v` from `auth-ok` onwards. No overlap: `error` with `unsupported-version`, fatal.

| Change                                                                                           | Bump? |
| ------------------------------------------------------------------------------------------------ | ----- |
| New optional field, new event kind, new value in an event enum                                   | No    |
| New required field, removed or renamed field, changed meaning, new frame type a peer must act on | Yes   |
| Any change to the action vocabulary, an action's fields, or reject-reason semantics              | Yes   |

## Pairing (HTTP)

Bodies are defined in `protocol/schemas/pairing.schema.json`: `pair-start`, `pair-start-result`, `pair-status`, `pair-status-result`, `pair-approve`. See `docs/security.md` for the flow and limits.
