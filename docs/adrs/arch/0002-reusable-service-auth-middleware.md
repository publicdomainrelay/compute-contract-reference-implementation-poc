# ADR 0002 — One reusable caller-authentication middleware for mutation endpoints

**Status:** Proposed · **Relates to:** THREATS T2 (fixed), T3 (partly open), T15

## Context

The market submit handlers (`lib/market/server.ts`) already centralize
service-auth verification well: `authorize()` verifies the JWT and requires the
issuer to author the referenced record. But the spindle's *own* mutation
endpoints grew ad-hoc, inconsistent authorization:

- `/trigger` — full service-auth (issuer == actor) **+** repo opt-in. ✅
- `addSecret` / `removeSecret` / `listSecrets` — repo opt-in **only**, no caller
  auth (T3).
- `cancelPipeline` — repo opt-in only, **and** a copy-paste bug referencing an
  undefined `trigger` variable (T15) so it 500s.

Each handler re-implements `repoRegisteredToThisSpindle(host, repoDid)` and the
`c.req.header("host") ?? HOSTNAME` dance by hand, which is how the `cancelPipeline`
bug slipped in and why two endpoints simply lack caller auth.

## Proposal

Provide one Hono middleware, e.g. `requireRepoOwner({ lxm })`, that:

1. verifies the inbound service-auth JWT via the existing `verifyServiceAuth`
   (signature + lxm + aud, per-tenant hostname),
2. extracts the body's `repo`/`repoDid` once,
3. asserts the token issuer **is** that repo's owner DID, and
4. asserts the repo opted into this spindle.

Apply it to `addSecret`, `removeSecret`, `listSecrets`, `cancelPipeline`, and
`/trigger` so every mutating route shares one audited code path. Handlers then
receive a typed `{ repo, issuerDid }` and never touch headers directly.

## Consequences

- (+) Closes T3/T15 by construction; impossible to add a mutation route that
  forgets caller auth; removes the host-header boilerplate that hid the T15 bug.
- (+) Matches the pattern already proven in `lib/market/server.ts` `authorize()`.
- (−) Requires defining the `lxm` for the secrets/cancel procedures and the
  viewer/clients to proxy them via the PDS (as `/trigger` already does).
