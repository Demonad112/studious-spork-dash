# Protocol

Source of truth for the wire format, version 1.

| Path                              | What                                                                    |
| --------------------------------- | ----------------------------------------------------------------------- |
| `schemas/frame.schema.json`       | JSON Schema for every WebSocket frame                                   |
| `schemas/pairing.schema.json`     | JSON Schema for the HTTP pairing bodies                                 |
| `fixtures/`                       | Golden fixtures consumed by both test suites (see its README)           |
| `deny-list.json`                  | Field names and value patterns that must never appear in events or logs |
| `ts/`                             | TypeScript types, decoder and scanner (`@remote-console/protocol`)      |
| `../agent/agent-core/src/wire.rs` | Rust types and decoder                                                  |

Three implementations agree on the same fixtures: the JSON Schema (via ajv in Node tests), the TypeScript decoder (used by the relay and dashboard, hand written because Workers forbid the code generation ajv relies on), and the Rust decoder.

The prose specification is `docs/protocol.md`.
