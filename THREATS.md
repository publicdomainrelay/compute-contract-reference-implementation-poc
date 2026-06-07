# Threat Model & Security Review — compute-contract-reference-implementation-poc

_Last reviewed: 2026-06-07. Scope: `src/typescript/{spindle,bidder,qemu,spindle-viewer-spa}`._

This document describes the trust model of the reference implementation, enumerates
the threats against it, and records the issues fixed in this review pass. It is a
**reference / proof-of-concept**; a few findings are inherent to running the PoC
components directly on the public internet and are called out as design-level
residual risks that must be closed before production use.

---

## 1. System overview

A decentralized compute marketplace built on AT Protocol (ATProto). Four components:

| Component | Role | Listens |
|-----------|------|---------|
| **spindle** (`spindle/main.ts`) | CI backend. Watches knots for `sh.tangled.pipeline` triggers, fetches `.github/workflows/*` from the knot at a commit SHA, runs them via a local policy engine **or** provisions a remote VM via the market (`COMPUTE_PROVIDER=market.rfp`). | HTTP (`PORT`/unix socket), behind Caddy |
| **marketRFP** (`spindle/marketRFP.ts`) | Market buyer. Creates `compute.vm` + `market.rfp` records, discovers vouched bidders, scores bids, accepts a winner, mints `com.fedproxy.rbac`, submits the workflow to the won VM's policy engine. | — (outbound only) |
| **bidder** (`bidder/main.ts`) | Market seller. Reacts to RFPs (`/hook/rfp`, `/xrpc/...submitRfp`), creates bids, and on x402 payment (`/receipt/*`) provisions a DigitalOcean droplet through an RBAC-gated proxy. | HTTP `:4021` |
| **qemu / miniCloud** (`qemu/main.ts`) | DigitalOcean-compatible API + OIDC issuer. RBAC-gates `/v1/oidc/issue`, `/v2/account`, `/v2/droplets*`; spawns local QEMU VMs. | HTTP `:8080` |
| **viewer** (`spindle-viewer-spa/`) | Read-only browser SPA for repos / pipeline status / logs. | static |

### Trust boundaries

1. **Public network → spindle HTTP** (`/trigger`, `/events`, `/logs`, secrets XRPC,
   `submitBid`, `cancelPipeline`). Fronted by Caddy as a **plain reverse proxy with no
   auth** (`spindle/Caddyfile`).
2. **Knot → spindle**: workflow YAML and trigger metadata are fetched from a knot the
   repo points at. The knot is semi-trusted; its hostname becomes an outbound fetch
   target.
3. **Jetstream firehose → spindle/marketRFP**: bid records are untrusted until the
   bidder DID is checked against the vouched-DID allowlist.
4. **VM ↔ qemu OIDC/RBAC**: a provisioned VM proves possession of its SSH host key to
   exchange a provisioning nonce for a scoped OIDC token (`provisioning.ts`,
   `/v1/oidc/prove`). The token then authorizes droplet self-management via
   `com.fedproxy.rbac` policy.
5. **ATProto identity**: all authorization roots in DID resolution (plc.directory /
   did:web) and JWT signature verification.

### Authorization model

- **OIDC path** (`/v1/oidc/issue`, scope `droplets.wid`): RS256 JWT, `aud =
  api://<api>?actx=<actx>`. `actx` (a DID) → resolve PDS → load `com.fedproxy.rbac` →
  collect trusted issuers → verify JWT → match `sub` to a role → check the path/method
  capability schema.
- **ATProto service-auth path** (`/v2/account`, `/v2/droplets*`, scope `account.auth`):
  `com.atproto.server.getServiceAuth` JWT, `iss = DID`, verified against the DID
  document's `verificationMethod` keys, then the same RBAC policy check.

### Assets

ATProto account credentials and service-auth signing keys; the qemu OIDC signing key
(`app.db`); CI secrets injected into workflow runs; the DigitalOcean API token
(`DO_TOKEN`); compute capacity and the funds spent provisioning it.

---

## 2. Findings

| # | Severity | Component | Status |
|---|----------|-----------|--------|
| F1 | **Critical** | qemu `rbac_helper.ts` | **Fixed** |
| F2 | **High** | spindle `/trigger` | **Fixed** |
| F3 | **High** | spindle mutation XRPC endpoints | **Mitigated** + documented residual |
| F4 | Medium | qemu `oidc_helper.ts` / `/v1/oidc/issue` | **Fixed** |
| F5 | Medium | marketRFP / bidder (SSRF) | **Fixed** |
| F6 | Low | scratch JWT + state files in tree | **Fixed** |
| F7 | Low | type/correctness errors (auth core + bidder) | **Fixed** |

---

### F1 — (Critical) Auth bypass: RBAC lookup failure failed *open* — FIXED

**Location:** `qemu/rbac_helper.ts`, `raiseIfUnauthorized` (the `catch` after
`getRBACRecord`).

**Before:** if resolving the `actx` DID or loading its `com.fedproxy.rbac` record
threw (DID doesn't resolve, no record, PDS unreachable, malformed `aud`), the function
returned an empty object `{}` instead of throwing. The `/v1/oidc/issue` middleware
treats a non-throwing return as success, so it called `next()` — **skipping both OIDC
token signature validation and the RBAC policy check**. `/v1/oidc/issue` is the most
privileged endpoint in the system: it mints OIDC tokens that authorize droplet
creation. Any token whose `aud` actx had no resolvable RBAC record reached the issuer
with an empty, un-validated auth context.

**Impact:** authentication + authorization bypass on token issuance → unauthorized
compute / privilege escalation.

**Fix:** fail closed — `throw new UnauthorizedException(...)` when the RBAC context
cannot be established; the middleware converts it to `401`.

---

### F2 — (High) Unauthenticated `/trigger` ran pipelines for arbitrary repos (SSRF + unauthorized compute) — FIXED

**Location:** `spindle/main.ts`, `POST /trigger`.

**Before:** the jetstream knot-event path drops triggers whose `repoDid` is not in
`repoDidToSpindle` (the opt-in allowlist), but the public `POST /trigger` endpoint
called `triggerWorkflows()` directly with **caller-supplied** `knot`, `repoDid`,
`ref`. With Caddy adding no auth, any internet caller could:
- **SSRF:** `knot` is used verbatim to build outbound fetch URLs (`fetchWorkflowTree`
  / `fetchWorkflowBlob` → `${knotBaseUrl(knot)}/xrpc/...`), letting an attacker point
  the spindle at internal hosts.
- **Unauthorized compute:** drive workflow execution on the local policy engine, or
  under `COMPUTE_PROVIDER=market.rfp` cause the operator to create RFPs and **pay for
  VMs** on the attacker's behalf.

**Fix:** reject triggers whose `repoDid` is not in `repoDidToSpindle` (`403`),
mirroring the firehose path; this bounds `knot`/`repoDid` to operator-trusted values.
_Caller authentication is still required for full protection — see F3._

---

### F3 — (High) Spindle mutation XRPC endpoints have no caller authentication — MITIGATED

**Location:** `spindle/main.ts`: `addSecret`, `removeSecret`, `listSecrets`,
`cancelPipeline`, `submitBid`; `spindle/Caddyfile` (plain `reverse_proxy`).

**Issue:** none of these endpoints authenticate the caller. `addSecret` injects
secrets later passed into workflow runs (CI secret poisoning / exfiltration);
`cancelPipeline` lets anyone mark any run terminal (DoS); `submitBid` lets anyone
enqueue bids (the downstream vouched-DID allowlist in `collectBidsForRfp` is the
backstop); `listSecrets` returns key metadata for any repo.

**Mitigation applied:** `addSecret`, `removeSecret`, `listSecrets`, and
`cancelPipeline` now refuse repos not in `repoDidToSpindle`, bounding the *target*
repo to ones that opted into this spindle.

**Residual risk (must close for production):** this does **not** authenticate the
*caller*. Front the spindle with an authenticating proxy (the fedproxy / ATProto
service-auth layer the rest of the system already uses) or verify an ATProto
service-auth JWT whose `iss`/`sub` matches the repo owner DID inside each handler, and
restrict `addSecret`/`removeSecret`/`cancelPipeline` to the repo owner.

---

### F4 — (Medium) OIDC token issuance weaknesses — FIXED

**Location:** `qemu/oidc_helper.ts` (`OIDCToken.create`), `qemu/main.ts`
(`/v1/oidc/issue`).

- **Non-expiring default:** tokens minted without an explicit `ttl` defaulted to
  `now + 100 years` — a leaked token stayed valid forever. **Fixed:** bounded default
  of 24h, overridable via `OIDC_DEFAULT_TTL_SECONDS`.
- **Substring `sub` check:** authorization used `sub.includes("actx:" + actx)`, a loose
  test a crafted subject could satisfy. **Fixed:** introduced `subMatchesActx()`
  (exact match or `actx:<actx>:` prefix), used by both `OIDCToken.create` and the
  `/v1/oidc/issue` handler.

Residual (documented, not changed): `OIDCToken.create` still lets a caller override the
derived `aud` via `claims.aud`; callers that can reach `create` should be constrained
so they cannot target a service they are not authorized for.

---

### F5 — (Medium) SSRF via record-supplied URLs — FIXED

**Location:** `marketRFP.ts` (`offering.endpointUrl`, x402 `payload.url`),
`bidder/main.ts` (`rfp.sendBid`).

URLs read from ATProto records were fetched server-side with no validation. **Fixed:**
added `assertSafeEgressUrl()` (in both `marketRFP.ts` and `bidder/main.ts`) applied
before each record-derived fetch. It **unconditionally** blocks non-`http(s)` schemes
and cloud link-local metadata hosts (`169.254.169.254`,
`metadata.google.internal`), and **additionally** blocks RFC1918 / loopback / ULA
ranges when `MARKET_BLOCK_PRIVATE_EGRESS` is set (off by default so localhost dev/e2e
keeps working). **Recommendation:** enable `MARKET_BLOCK_PRIVATE_EGRESS=1` in any
deployment where these services share a network with internal hosts.

---

### F6 — (Low) Signed JWT and runtime state could be committed — FIXED

`qemu/cloud-init-fresh.yaml` (untracked, previously **not** gitignored) embeds a real
short-lived signed provisioning JWT. The spindle also writes
`spindle-events-db.json`, `spindle-ran.logs`, `spindle-ran.yaml` next to the source.
**Fixed:** added `.gitignore` entries (`qemu/.gitignore`, `spindle/.gitignore`) so
these generated / secret-bearing artifacts cannot be committed by accident. Rotate any
provisioning key material that may have been exposed.

---

### F7 — (Low) Type / correctness errors — FIXED

`deno check` failed across all three TypeScript services. Fixed:

- **`qemu/oidc_helper.ts`** — 6 `OIDCToken` properties had no definite assignment
  (assigned via `Object.assign`); added `!` assertions.
- **`qemu/rbac_helper.ts`** — `RBACProtects` lacked the `scope` field that
  `getRBACRecord` matches on (the very boundary separating `droplets.wid` from
  `account.auth` records); `joined` RBAC record omitted `protects`; `payload.sub`
  accessed on an untyped JWT payload; **removed dead `getServiceAuthToken()`** that
  referenced undefined `agent`/`aud`.
- **`qemu/main.ts`** — typed Hono context variables (`Hono<{ Variables: { authToken } }>`)
  to fix `c.set`/`c.get`; added `"debug"` to the logger level union.
- **`qemu/main.ts` `/v1/oidc/prove` tag filter (action required):** the second tag
  filter `(t) => !t.startsWith("oidc-sub:") || !t.split(":").length !== 3` was retained
  at the maintainer's request (kept under `// @ts-expect-error`). **It does not
  type-check** because operator precedence makes it parse as `(!length) !== 3`, which
  is `boolean !== number` and therefore **always `true`** — i.e. the filter is a
  runtime no-op that passes every tag. If the intent was to drop malformed `oidc-sub:`
  tags, the predicate should be `!t.startsWith("oidc-sub:") || t.split(":").length === 3`
  (drop the leading `!` and remove the suppression). This computes the OIDC `sub` in a
  security-sensitive path, so the intended behavior should be confirmed.
- **`bidder/main.ts`** — **real bug:** `const { did: rfpOwnerDid } = parseAtUri(...)`
  destructured a non-existent `did` (always `undefined`); corrected to `repo`. Plus
  `ContentfulStatusCode` cast in `onError` and a localized cast for the `@x402`
  facilitator `authProvider` field.
- **`spindle/marketRFP.ts`** — guarded `winner.config` before templating it into the
  RBAC grant, so a config-less winning bid fails closed instead of emitting an RBAC
  record with `undefined` in its trust fields.

All of `spindle`, `bidder`, and `qemu` now pass `deno check` cleanly.

---

## 3. Known residual / out-of-scope (not changed)

- **No caller authentication on spindle endpoints (F3 residual)** — the largest gap;
  requires a deployment-level auth design.
- **`qemu/main_test.ts` is broken** — it imports a `handler` export `main.ts` has never
  provided (the server calls `Deno.serve` at import time). Pre-existing; fixing it
  needs refactoring `main.ts` to export the Hono app, a behavioral change beyond this
  security pass.
- **Lint style** — the codebase uses unversioned `jsr:`/`npm:` specifiers throughout
  (`deno lint` `no-unversioned-import`); pre-existing and not security-relevant.
- **Viewer SPA** — renders all untrusted log/status/repo data via `textContent` /
  `createTextNode`; no XSS sink found.

---

## 4. Changes applied in this review

- `qemu/rbac_helper.ts` — fail closed on RBAC lookup failure (F1); type fixes (F7).
- `qemu/oidc_helper.ts` — bounded default TTL + `subMatchesActx` (F4); type fixes (F7).
- `qemu/main.ts` — `subMatchesActx` in `/v1/oidc/issue` (F4); Hono var typing, logger
  level, dead-filter removal (F7).
- `spindle/main.ts` — authorize `/trigger` (F2); gate secrets + `cancelPipeline` to
  opted-in repos (F3).
- `spindle/marketRFP.ts` — SSRF egress guard (F5); `winner.config` guard (F7).
- `bidder/main.ts` — SSRF egress guard (F5); `repo` destructure bug + type fixes (F7).
- `spindle/.gitignore`, `qemu/.gitignore` — exclude state DBs + provisioning artifact (F6).

## 5. Top recommendations (not yet implemented)

1. **Authenticate every spindle mutation endpoint** (F3) — the single largest gap.
2. Enable `MARKET_BLOCK_PRIVATE_EGRESS=1` in networked deployments (F5).
3. Constrain caller-supplied `aud` override in `OIDCToken.create` (F4 residual).
4. Export the Hono app from `qemu/main.ts` and repair `main_test.ts`.
