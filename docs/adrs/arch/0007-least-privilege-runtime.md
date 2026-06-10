# ADR 0007 — Least-privilege Deno permissions + config validation at startup

**Status:** Proposed · **Relates to:** THREATS T17, T18

## Context

- `bidder/run.sh`, `bidder/run-fedfork.sh`, and `spindle/run-fedcicd.sh` launch with
  `deno run --allow-all`, granting full FS/net/env/subprocess access — including the
  DO token and the ability to spawn arbitrary processes. (The bidder *does* shell
  out to `git`, so it needs `--allow-run`, but not unrestricted.) `spindle/run.sh`
  already scopes permissions and is the model to follow.
- Insecure/incomplete config is accepted silently and only surfaces at request time:
  the x402 facilitator auth provider is a stub returning `{}` (T18), and several
  required secrets are read lazily, so a misconfigured `SETTLEMENT=x402` deployment
  can run with a non-functional payment control.

## Proposal

1. **Scope permissions per service** to the minimum: explicit `--allow-net=<hosts>`,
   `--allow-env=<names>`, `--allow-read=<paths>`, `--allow-write=<paths>`, and
   `--allow-run=git` only where a subprocess is genuinely needed. Pin them in the
   committed run scripts and/or `deno.json` tasks.
2. **Validate config at startup, fail fast.** A single startup check that asserts:
   required secrets present; `SETTLEMENT=free`/`X402_MAKE_FREE` refused when
   `BASE_URL` is public (ties to ADR 0003); x402 facilitator credentials present and
   the auth provider non-stub when `SETTLEMENT=x402` (T18). Refuse to start
   otherwise rather than degrading to an unenforced control.
3. Replace the `as any` facilitator construction with a typed wrapper so missing
   CDP auth is a compile/startup error, not a runtime no-op.

## Consequences

- (+) A compromised dependency or workflow can't reach beyond the service's actual
  needs; misconfiguration is caught before traffic, not mid-auction.
- (−) Permission lists need maintenance as endpoints/hosts change; startup becomes
  stricter (intended).
