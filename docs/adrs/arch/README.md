# Architecture improvement proposals

These are **suggestions for other agents to act on**, collected during the
2026-06-09 security review (see [`../../../THREATS.md`](../../../THREATS.md)).
They are architectural/structural improvements — not the security fixes
themselves, though several would make whole classes of the THREATS findings
hard to reintroduce.

Each file is an ADR-style proposal: _Context → Proposal → Consequences_, plus the
THREATS findings it relates to. Status of every entry is **Proposed** unless noted.

| ADR | Title | Relates to |
|-----|-------|-----------|
| [0001](./0001-single-guarded-outbound-fetch.md) | Route every outbound fetch through one guarded client | T5, T16 |
| [0002](./0002-reusable-service-auth-middleware.md) | One reusable caller-authentication middleware for mutation endpoints | T2, T3, T15 |
| [0003](./0003-settlement-cannot-be-a-noop.md) | Make "settled" un-fakeable in the Settlement contract | T8, T12 |
| [0004](./0004-authoritative-record-trust-model.md) | One documented authenticity control; signatures authoritative by default | T13, T14 |
| [0005](./0005-durable-state-store-abstraction.md) | Replace ad-hoc in-memory + JSON-file state with a store interface | T6, operational |
| [0006](./0006-secret-and-credential-handling.md) | Centralize secret/credential handling; never write secrets to disk | T9, T3 |
| [0007](./0007-least-privilege-runtime.md) | Least-privilege Deno permissions + config validation at startup | T17, T18 |
| [0008](./0008-net-only-runs-on-routing.md) | Route `runs-on: net-only` jobs to a local net-only policy engine (skip market.rfp) | T8, T11, T12, T13, T14, T19, T20, T21 |
