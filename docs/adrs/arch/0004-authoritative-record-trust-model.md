# ADR 0004 — One documented authenticity control; signatures authoritative by default

**Status:** Proposed · **Relates to:** THREATS T13, T14

## Context

There are currently **two** overlapping mechanisms that look like they establish
record authenticity, and it is unclear which one is load-bearing:

1. **ATProto identity** — service-auth JWT (`authorize()`: issuer authored the URI)
   + cid-pinned PDS resolution. This is real and enforced.
2. **badge.blue inline signatures** — `verifyRecordSignatures`. But with
   `bindKeys=false` (the default everywhere) it verifies against a did:key embedded
   in the signature entry itself, so it proves nothing about origin (T13). It reads
   like an authenticity control but isn't one.

Worse, the two mechanisms aren't applied consistently: `submitBid` trusts an inline
body record/cid and *skips* the PDS resolution that every other path relies on
(T14), and the spindle's `did:web` document publishes no `verificationMethod`, so
badge.blue binding could not work for spindle-authored records even if enabled.

## Proposal

Pick one trust model, make it the default, and document it at the boundary:

- **Resolve-then-trust:** every record a handler acts on is fetched from its
  authoritative PDS by cid (already true for rfp/accept/event/contract-graph).
  Extend this to `submitBid` — ignore the inline body record/cid and re-resolve
  (closes T14). The inline body becomes a hint, never the source of truth.
- **Signatures authoritative by default:** set `bindKeys: true` and have every
  producer publish its attestation did:key in its DID document
  (`attestationVerificationMethod` — the bidder already does; add it to the
  spindle's `/.well-known/did.json`). Then a valid signature *does* prove origin
  and can be relied on off the resolve path (e.g. the provenance bundle injected
  into the VM).
- Where binding is deliberately off, change the comment in `lib/market/server.ts`
  from "proves the record is untampered" to "non-authoritative; ATProto authorship
  is the control", so no future code mistakes it for proof of origin.

## Consequences

- (+) A single, stated authenticity invariant; no path (like `submitBid`) can
  quietly opt out of it.
- (+) Makes the badge.blue layer meaningful for offline/forwarded artifacts.
- (−) Requires producers to publish keys and verifiers to resolve DID docs (already
  cached via `createDidKeyResolver`); a slight per-verify cost when binding is on.
