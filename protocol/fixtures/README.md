# Golden fixtures

Shared by the Rust and TypeScript contract tests.

| Directory         | Contract                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `valid/`          | Must pass the JSON Schema, both validators, and round-trip through the Rust types unchanged.                                                                                                                             |
| `invalid/`        | Must be rejected by the JSON Schema and both validators.                                                                                                                                                                 |
| `lenient/`        | `{ input, normalized }`. Events a receiver must accept: `normalized` is the expected result (unknown enum values mapped to `other`, extra fields dropped) or `null` for an ignored (unknown) event that keeps its `seq`. |
| `deny/`           | Must be flagged by the deny-list scanner (paths, drive letters, forbidden keys).                                                                                                                                         |
| `pairing/valid`   | HTTP pairing bodies that pass `pairing.schema.json`.                                                                                                                                                                     |
| `pairing/invalid` | HTTP pairing bodies that fail it.                                                                                                                                                                                        |

Oversize frames (over 16 KiB) are generated inside the tests rather than stored.
No fixture in `valid/`, `lenient/` or `pairing/` may contain a path separator, a drive letter, or a key from `../deny-list.json`. `invalid/` may, because some of its cases exist to prove those are rejected.
