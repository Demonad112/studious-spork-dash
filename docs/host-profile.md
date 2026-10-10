# Host profile: DeepServer 2

What the remote-console layers need to know about the first real host app. Written on 2026-10-09 from a read of the host's code (`V2.0/` in the host repo: `CLAUDE.md`, `docs/plan.md`, `src-tauri/src/{lib,record,compare,cleanup}.rs`, `transfer-core` `lib.rs` and `watch.rs`, `src/lib/record.ts`, `src/pages/RecordPage.vue`, `src/styles.css`).

This file is the only description of the host this repo uses. Sessions working here do not open the host repo. If the host changes, the owner updates this file.

## 1. What the host is

| Item             | Value                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| App              | DeepServer 2: Compare two folders, Record a copy between them, Disk Cleanup                                                  |
| Stack            | Tauri 2.11 + Rust (edition 2021), Vue 3.5 + TypeScript, Tailwind CSS v4, `@lucide/vue`, no component library                 |
| Platforms        | Windows 10/11 and Windows Server 2016+ (x64, MSVC toolchain)                                                                 |
| Install          | NSIS, per machine; also a portable zip (`portable.txt` next to the exe moves data to `<exe dir>\Data\`)                      |
| Data folder      | `%LOCALAPPDATA%\DeepServer2\` (env overrides exist)                                                                          |
| Licence          | Apache-2.0. A GPL-2 engine lives elsewhere in the host repo; nothing from it may be copied                                   |
| Jobs at a time   | One record. A new compare or scan cancels the previous one                                                                   |
| Runtime          | Long jobs are `async` commands that call `tauri::async_runtime::spawn_blocking`; the app adds no tokio dependency of its own |
| Tauri identifier | `com.demonad112.deepserver2`                                                                                                 |

## 2. The job the dashboard is for: Record

Record lists the source folder, then either copies it (**Copy** mode) or watches another program copy it (**Watch** mode), and ends with a report of every file that did not arrive.

One command, `record_start`, runs the whole job and returns only when it ends. Progress goes to the page over a `tauri::ipc::Channel` held by that one call.

### Phases the host emits

| Host phase  | Meaning                                                                                                | Totals known? |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------- |
| `scanning`  | Listing the source. UI shows "N found", no percent                                                     | No            |
| `copying`   | Copy mode: copying and verifying                                                                       | Yes           |
| `watching`  | Watch mode: waiting for files to arrive                                                                | Yes           |
| `finishing` | Watch mode: final check of everything not yet arrived                                                  | Yes           |
| `done`      | **Closes a step, not the job.** Emitted after listing and again after the copy. The host UI ignores it | n/a           |

The job is over only when the command returns: `Ok(details)` with a run state of completed or cancelled, or `Err(text)`.

### Progress fields

| Host field                       | On the wire?                      | Note                                                            |
| -------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `filesDone`, `filesTotal`        | Yes                               | `filesTotal` is 0 while scanning: send `null`                   |
| `bytesDone`, `bytesTotal`        | Yes                               | Percent = bytes ratio; `null` while scanning or when total is 0 |
| `copied`, `skipped`, `notCopied` | Yes, as `ok`, `skipped`, `failed` | `notCopied` is the number the owner cares about most            |
| `phase`                          | Yes, as a step id                 | Map to kebab-case; drop `done`                                  |
| `current`                        | **No**                            | A relative file path                                            |
| `runId`                          | **No**                            | Host run id; the agent makes its own random `jobId`             |

Cadence: at most one progress message per 100 ms, and always the last one. Speed and time left are worked out in the UI from `bytesDone` and elapsed time (speed after 1 s, time left after 3 s, Copy mode only).

### Controls the host offers during a record

| Button           | When enabled                                                    | Host call         | Effect                                                                                          |
| ---------------- | --------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Finish and check | Watch mode only; phase is not `scanning`; not already finishing | `record_finish()` | Sets a flag. The watch loop notices within 200 ms, runs the final check, then the job completes |
| Cancel           | Any time a record is running                                    | `record_cancel()` | Sets a flag. Cooperative: the job stops at its next check and ends as cancelled                 |

Both return a bool ("something was running") and are safe to call twice.

Facts that shape the protocol:

- **There is no "Next" today.** Copy mode has no prompt at all. A pre-flight review with a conflict choice is on the host roadmap; that is the future user of `next`.
- **Finish is offered while progress continues.** Files keep arriving and counters keep moving while the button is enabled. The prompt does not pause the job.
- **The app can close the prompt by itself.** A watch finishes on its own once every file has arrived (and optionally after a quiet period).
- **The local user can press the same button.** Remote and local presses race; the first wins.
- **The running job outlives the page.** The UI keeps the job in a module-level object so leaving the page keeps Finish and Cancel. A closed UI channel is not an error; the job carries on. The bridge must behave the same way.

### How a record ends

| Outcome   | Host signal                                                                             | Wire status | Failure code                  |
| --------- | --------------------------------------------------------------------------------------- | ----------- | ----------------------------- |
| Completed | `Ok`, run state `completed`                                                             | `completed` | none                          |
| Cancelled | `Ok` with state `cancelled`, or `Err("Cancelled")` when cancelled before the copy began | `cancelled` | `cancelled`                   |
| Failed    | `Err(text)`; the text often contains a path                                             | `failed`    | Map known cases, else `other` |

Known failure texts to map: cannot write to the destination -> `destination-not-writable`; not enough space -> `not-enough-space`. Never forward the text.

Terminal summary (counts only): planned files and bytes, copied, copied bytes, skipped identical, not copied, not copied bytes, duration.

## 3. Other long jobs (later, progress and cancel only)

| Job            | Progress                                        | Controls | Notes                                               |
| -------------- | ----------------------------------------------- | -------- | --------------------------------------------------- |
| Compare        | Two scan counters, left and right, every 100 ms | Cancel   | Totals unknown throughout: percent is always `null` |
| Disk scan      | One scan counter every 100 ms                   | Cancel   | Same                                                |
| Retry, Recover | Same progress type as Record                    | Cancel   | Started locally only                                |

Job kinds for the wire enum: `record-copy`, `record-watch`, `compare`, `disk-scan`, `simulated`, `other`.

## 4. Never on the wire, never remotely reachable

Data that must not leave the PC:

- Source and destination paths, relative paths, file names, the "current file" field, the run folder.
- Machine name (`COMPUTERNAME`) and Windows user name. Both are stored in every run summary.
- Client, Ticket and Technician fields typed for the report.
- Error and reason text. Per-file failure reasons and hashes.
- Host run ids.

Host commands that must stay unreachable from the dashboard, whatever is added later: anything that deletes or recycles (`cleanup_delete`, `cleanup_quick_clean`), `app_restart_admin` (relaunches elevated), every command that takes a path (`record_start`, `compare_start`, `cleanup_scan`, `record_recover`, `record_retry`), report export, and "reveal in Explorer".

Remote surface for this host, in full: view progress, **Finish and check** (`done`), **Cancel** (`cancel`), status.

## 5. Integration seam

What the host will add when it adopts the crates (nothing here is built in this repo, but the API must make it this small):

1. **Dependency.** `agent-core` and `agent-ws` as Cargo git dependencies pinned to a tag.
2. **State.** One `RemoteControl` in Tauri managed state, next to `RecordState`.
3. **Tee sink.** The host already funnels progress through one trait:

   ```rust
   pub trait TransferSink {
       fn progress(&mut self, progress: &TransferProgress);
       fn item(&mut self, item: &ItemResult);
   }
   ```

   The adapter wraps the existing channel sink: forward to the channel as today, then call `bridge.progress(...)` with the mapped, minimised fields. `item` is not forwarded (it carries paths). This runs on the blocking job thread, up to ten times a second, so the bridge call must be cheap and must not block or fail.

4. **Lifecycle.** Where the host starts the one record job: `bridge.job_started(kind)`. On the first `watching` progress: `bridge.prompt_opened(done, finish-and-check, blocking = false)`. On `finishing`, or when the job ends: `bridge.prompt_closed(reason)`. When the command returns: `bridge.status(...)` with the summary or failure code.
5. **Actions.** `apply(Done)` calls the same function as the Finish button; `apply(Cancel)` the same as Cancel. Return `NotApplicable` when no record is running.
6. **Arm UI.** A Settings switch (off by default), an "armed" indicator in the custom title bar with a disarm click and viewer count, and a pairing screen that shows the code, fingerprint and optional QR.
7. **Secret store.** A DPAPI-backed `SecretStore` on Windows. In portable mode the key file sits in `Data\` but DPAPI ties it to the Windows user and PC, so a stick moved to another PC must pair again. That is acceptable; say so in the UI.
8. **Data dir.** The host passes its data folder (normal or portable). The agent never derives one.
9. **Power.** The host already keeps the PC awake for the life of a record with `SetThreadExecutionState`, which is tied to the calling thread. `PowerGuard` stays a no-op for this host unless a session must outlive a job.
10. **Exit and elevation.** The host refuses to restart elevated while a record runs. Any app exit ends the session; arming does not survive a restart, by design. The transport thread must join quickly so closing the window is not delayed.

## 6. Behaviours the simulator must reproduce

Each is a named `agent-sim` script and an e2e scenario.

| Script               | Sequence                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch-finish`       | `scanning` with null totals and rising "found" count -> step "done" (not terminal) -> `watching` with totals; prompt opens (`done`, non-blocking); progress keeps rising -> remote `done` accepted -> prompt closed `answered-remote` -> `finishing` -> status completed with a non-zero `failed` count |
| `watch-auto`         | As above, but every file arrives: prompt closed `auto`, then completed with `failed` 0                                                                                                                                                                                                                  |
| `watch-local-finish` | As above, but the "local user" finishes first: prompt closed `answered-local`; a later remote `done` gets `stale-prompt`                                                                                                                                                                                |
| `copy`               | `scanning` -> `copying` to 100 percent -> completed. No prompt at any point                                                                                                                                                                                                                             |
| `copy-fail`          | `scanning` -> status failed with `not-enough-space` before any copying                                                                                                                                                                                                                                  |
| `cancel-midway`      | `copying` -> remote `cancel` accepted -> a few more progress events -> status cancelled                                                                                                                                                                                                                 |
| `preflight-next`     | A blocking prompt (`next`, `continue`) before copying; progress pauses until answered. Models the host's planned pre-flight review                                                                                                                                                                      |

All scripts emit progress every 100 ms of simulated time (driven by the injectable clock in tests) so coalescing and the one-per-second send limit are exercised.

## 7. UI reference

The dashboard should read as the same product. The host's live panel shows, in order: a spinner with the step text; a 6px progress bar (pulsing third-width bar when percent is unknown); a four-column row of Files, Size, Speed, Not copied (two columns on narrow screens) in tabular numbers; then the buttons, primary first.

Step text used by the host: "Listing the source…", "Copying", "Watching the destination", "Checking what did not arrive…". Result wording: "All copied" in the success colour, or "N items not copied" in the danger colour.

Core tokens (copy these; add `--app-*` tokens for anything new rather than raw colours):

| Token                 | Light                    | Dark                      |
| --------------------- | ------------------------ | ------------------------- |
| `--app-bg`            | `#f3f3f3`                | `#202020`                 |
| `--app-layer`         | `rgb(255 255 255 / 0.5)` | `rgb(58 58 58 / 0.3)`     |
| `--app-card`          | `rgb(255 255 255 / 0.7)` | `rgb(255 255 255 / 0.05)` |
| `--app-card-hover`    | `rgb(249 249 249 / 0.8)` | `rgb(255 255 255 / 0.08)` |
| `--app-subtle`        | `rgb(0 0 0 / 0.04)`      | `rgb(255 255 255 / 0.06)` |
| `--app-subtle-strong` | `rgb(0 0 0 / 0.06)`      | `rgb(255 255 255 / 0.09)` |
| `--app-stroke`        | `rgb(0 0 0 / 0.08)`      | `rgb(255 255 255 / 0.07)` |
| `--app-stroke-strong` | `rgb(0 0 0 / 0.14)`      | `rgb(255 255 255 / 0.12)` |
| `--app-text`          | `#1b1b1b`                | `#ffffff`                 |
| `--app-muted`         | `#5d5d5d`                | `#c8c8c8`                 |
| `--app-faint`         | `#8a8a8a`                | `#9a9a9a`                 |
| `--app-accent`        | `#005fb8`                | `#60cdff`                 |
| `--app-accent-hover`  | `#1a6fc0`                | `#5abce9`                 |
| `--app-on-accent`     | `#ffffff`                | `#000000`                 |
| `--app-success`       | `#0f7b0f`                | `#6ccb5f`                 |
| `--app-warning`       | `#9d5d00`                | `#fce100`                 |
| `--app-danger`        | `#c42b1c`                | `#ff99a4`                 |
| `--app-danger-bg`     | `#fde7e9`                | `#442726`                 |

Tailwind names come from `@theme inline` (`--color-card: var(--app-card)` and so on), giving `bg-card`, `text-muted`, `border-stroke`, `text-accent`, `text-danger`. Fonts: `'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif` for body and the `Display` cut for titles; on a phone this falls through to the system font, which is fine. Focus ring: 2px solid `--app-text`, 1px offset. Buttons are 32px high in the desktop app; use 44px on touch.

## 8. Not verified

- The exact fields of the host's scan progress type (Compare, Disk scan) were not read. Treat them as counters with unknown totals.
- Whether the host already has a redacting secret wrapper. Assume not.
- Whether the host's pre-flight review will block. The `preflight-next` script is a model of a planned feature, not of shipped behaviour.
