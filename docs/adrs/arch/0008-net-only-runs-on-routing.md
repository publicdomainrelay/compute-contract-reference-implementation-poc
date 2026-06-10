# ADR 0008 — Route `runs-on: net-only` jobs to a local net-only policy engine

**Status:** Proposed · **Relates to:** THREATS T8, T11, T12, T13, T14 (reduced by
this); T19, T20, T21 (must be handled when adopting) · supersedes nothing

## Context

The `policy-engine/` package can run in a strict **net-only** sandbox: `${{ }}`
expressions and JS/TS `uses:` actions execute in in-process Deno Web Workers
granted `net` only — no filesystem, no subprocess, no host env — and `run:`
steps, composite actions, and action downloads are refused
(`src/eval.ts`, `src/action_worker.ts`, `src/workflow.ts assertExecAllowed`).
`bundled-actions-net-only/` provides sandbox-compatible `checkout` and
`paths-filter` actions.

Today this is a **global** switch (`--net-only` / `POLICY_ENGINE_NET_ONLY`); the
executor does not look at a job's `runs-on`, and the spindle picks compute globally
via `COMPUTE_PROVIDER` (local PE vs `market.rfp`). So the high-value property —
"a network-only workflow runs in the sandbox and never provisions a VM" — is
available in the engine but not selectable per workflow.

This matters for security, not just cost: the market.rfp path is where the largest
findings live (open compute provisioning via free settlement, T12/T8; record-trust
gaps T13/T14; running requester code on a VM, T11). A workflow that only needs the
network does not need any of it.

## Proposal

Make the sandbox a **per-job routing decision** driven by `runs-on`:

1. **Engine:** let `WorkflowExecutor` resolve the sandbox per job from its
   `runs-on` label (`net-only` ⇒ net-only sandbox) rather than only from the global
   flag. Keep the global flag as the default/override. Jobs whose `runs-on` is
   `net-only` but which contain a `run:`/composite step fail closed (already the
   behavior of `assertExecAllowed`).
2. **Spindle:** before dispatching, inspect the workflow's jobs. Route
   `runs-on: net-only` jobs to a **local net-only PE** (`/request/create` on a
   localhost-bound net-only engine) and only fall through to `market.rfp` (or the
   default local PE) for jobs that need a full runner. This is the concrete
   "skip the market.rfp flow" behavior.
3. **Document the matrix:** `net-only` → in-process sandbox, no provisioning;
   `self-hosted`/default → existing local PE or market.rfp per `COMPUTE_PROVIDER`.

## Consequences

- (+) Removes T8/T12/T13/T14 entirely for the net-only class (no market path runs)
  and shrinks T11 (sandbox replaces the VM as the isolation boundary).
- (+) Faster + cheaper for the common "lint/check/call an API" workflow; no bid
  window, no droplet, no SSH/OIDC dance.
- (−) **Must** be adopted together with the net-only hardening, or it trades one
  egress surface for another:
  - **T19:** the sandbox grants unrestricted `net`. Constrain it to an allowlist
    (`net: ["host:port", …]`) and/or egress-filter the PE host so workflow code
    can't reach internal/metadata addresses.
  - **T20:** do not enable `--fs-api` as part of the net-only promise (it re-grants
    FS over unauthenticated localhost HTTP); if needed for `checkout`, authenticate
    it and fix the `safeJoin` prefix check.
  - **T21:** keep the net-only PE bound to localhost behind the authenticated
    spindle; if exposed, front it with the service-auth middleware from ADR 0002.
- (−) Requires a workflow-parsing step in the spindle to read `runs-on` before
  dispatch (it already fetches + parses the YAML, so the data is in hand).
