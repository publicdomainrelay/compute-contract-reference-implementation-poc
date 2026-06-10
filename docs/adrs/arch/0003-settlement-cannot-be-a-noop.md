# ADR 0003 — Make "settled" un-fakeable in the Settlement contract

**Status:** Proposed · **Relates to:** THREATS T8, T12 (High)

## Context

The `Settlement` interface (`lib/market-settlement/settlement.ts`) is the
authorization boundary for spending compute: `bidder/main.ts` `onAccept` provisions
a droplet only after `settlement.verifyAcceptPayload(accept.payload)`. The x402
implementation enforces a real check (receipt authored by this bidder, CID-bound to
its `accepts.x402`). The free implementation's `verifyAcceptPayload` is an **empty
function** — so selecting free mode silently turns the provisioning path into open,
unauthenticated, repeatable compute (T12). The interface *allows* "settled" to mean
"nothing was checked", and a committed run script (`X402_MAKE_FREE=1`) picks exactly
that.

The shape of the bug is architectural: a security-critical verification is an
overridable method that is legal to leave empty, and the default deployment config
chooses the empty one.

## Proposal

Redesign the contract so "settled" cannot be a no-op:

1. `verifyAcceptPayload` must **return evidence** (e.g. the resolved, bidder-authored
   `receipts.*` strongRef), not `void`. A free settlement then *must* mint and
   verify a `receipts.free` (the `verifyFreeGrant` helper already exists and does
   exactly the author + CID-binding check) — there is nothing to "skip".
2. Make the caller (`onAccept`) treat a missing/!bidder-authored receipt as a hard
   refusal regardless of mode.
3. Gate the no-payment receipt endpoint (`hono-factory-market-bids` free path) with
   an explicit allowlist/quota so "free" means "free to a known counterparty", not
   "free to the internet".
4. Keep `SETTLEMENT=free` strictly a dev affordance: fail fast at startup if it is
   set together with a public `BASE_URL`.

## Consequences

- (+) Eliminates T12 by design; free vs paid differ only in *who pays*, not in
  *whether the contract is verified*.
- (+) Reuses `verifyFreeGrant`, which is already written but currently unused on the
  settle path.
- (−) Free mode now requires the buyer to fetch a `receipts.free` first (one extra
  round trip), matching the x402 flow.
