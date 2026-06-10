# ADR 0001 — Route every outbound fetch through one guarded client

**Status:** Proposed · **Relates to:** THREATS T5 (fixed), T16 (open)

## Context

`assertSafeEgressUrl` (`lib/market/egress.ts`) is a solid SSRF guard, but it is
called only at the two record-derived market URLs. Every other outbound `fetch`
calls the network directly with no guard:

- `spindle/main.ts`: `fetchWorkflowTree` / `fetchWorkflowBlob` (knot host, verbatim
  from the trigger), `submitWorkflow` (`POLICY_ENGINE_URL`), `resolvePDS`
  (plc.directory / did:web), the `/logs` PE streaming fetches.
- `lib/market/records.ts` `listRecordsAll`, `lib/market/resolve.ts`,
  `lib/atproto-helpers/misc.ts` `getRecord` — all fetch PDS endpoints derived from
  DID documents.

The guard being opt-in and per-call means new outbound calls default to *unguarded*
(this is exactly how T16 arose). There is also no shared timeout, retry, or
allow/deny policy — each call reinvents `AbortSignal.timeout(...)` (or omits it).

## Proposal

Introduce a single `createFetch({ blockPrivate, allowHosts?, timeoutMs })` in a
shared lib (e.g. `lib/net`) that wraps `fetch`, runs `assertSafeEgressUrl` on the
resolved URL, applies a default timeout, and is the **only** outbound HTTP entry
point. Inject it (like `RecordResolver` is injected) so tests can stub it.

- Counterparty-supplied URLs (knot, offering endpoint, x402 url) go through it
  with `blockPrivate` driven by `MARKET_BLOCK_PRIVATE_EGRESS`.
- For the knot specifically, also pass the repo's *recorded* knot so the client can
  reject a knot host that doesn't match the repo record (closes T16's binding gap).
- Lint/grep rule (or a thin `globalThis.fetch` ban in service entry points) to keep
  raw `fetch` out of new code.

## Consequences

- (+) New outbound calls are guarded by default; SSRF becomes a single audited
  chokepoint; uniform timeouts/retries.
- (−) Touches many call sites; DID/PDS resolution inside `@atproto/*` libraries
  still fetches directly (acceptable — those targets are derived from signed DID
  docs, not free-form attacker input), so document that boundary.
