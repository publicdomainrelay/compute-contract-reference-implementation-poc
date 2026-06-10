# ADR 0006 — Centralize secret/credential handling; never write secrets to disk

**Status:** Proposed · **Relates to:** THREATS T9, T3

## Context

Secrets are handled inconsistently and one path persists a long-lived credential to
disk:

- `compute-provider-digitalocean/mod.ts` `configureDropletRbac` interpolates
  `DO_TOKEN` into a `git-credential-rbac-digitalocean.sh` shell script written to
  `~/.local/scripts` (mode 0700). The token now lives in the process env **and** in
  a plaintext file on disk, indefinitely, in addition to being embedded into a
  shell heredoc (T9).
- `bidder` reads `DIGITALOCEAN_TOKEN`, `RECV_ADDR`, `CDP_RECV_API_KEY_*`,
  `ATPROTO_PASSWORD`, `ATTESTATION_PRIVATE_KEY_HEX` directly from `Deno.env` at
  module load, scattered across files (`env.ts`, `bids_x402.ts`, `keys.ts`).
- `spindle` `secretsStore` holds repo CI secrets in plaintext memory.

There is no single inventory of which secrets exist, where they come from, or how
they're scoped — which makes rotation and "did we leak it" analysis hard.

## Proposal

1. **Never materialize `DO_TOKEN` to a file.** Use git's env-var credential helper
   form (`!f() { echo "username=token"; echo "password=$DO_TOKEN"; }; f`) so the
   token is read from the (already-present) env at git-invocation time and never
   written. If a file is unavoidable, write it under a private tmpdir and `rm` it in
   a `finally`.
2. **One config/secrets module per service** that reads and validates every secret
   at startup (fail fast on missing required ones), returns a typed frozen config,
   and is the only place that touches `Deno.env` for secrets. (`bidder/env.ts` is a
   good seed — extend it to cover all of them.)
3. Document each secret's scope and rotation in one table (asset inventory already
   started in THREATS §1 "Assets").

## Consequences

- (+) Removes the on-disk token (T9); rotation and leak-analysis become tractable;
  startup fails loudly instead of half-configured.
- (−) Requires touching every current `Deno.env.get(<secret>)` call site to route
  through the config module.
