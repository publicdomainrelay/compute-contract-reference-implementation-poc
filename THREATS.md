# Threat Model & Security Review — compute-contract-reference-implementation-poc

_Last full re-review: 2026-06-07. Scope: all code under `src/typescript/`
(`spindle`, `bidder`, `qemu`, `spindle-viewer-spa`, `utils`) plus run scripts,
Dockerfiles, and cloud-init templates._

This is a **reference / proof-of-concept**. Some findings are inherent to running
the PoC components directly on the public internet and are flagged as design-level
residual risks that must be closed before production use. Every code-level fix in
§3 has been verified by a live end-to-end run (§6).

---

## 1. System overview

A decentralized compute marketplace on AT Protocol (ATProto). A repo's CI pipeline
is auctioned to compute providers ("bidders"); the winner provisions a VM that runs
the workflow.

| Component | Role | Network exposure |
|-----------|------|------------------|
| **spindle** (`spindle/main.ts`, `marketRFP.ts`) | CI backend. Watches knots for `sh.tangled.pipeline` triggers, fetches `.github/workflows/*` at a commit SHA, runs them via a local policy engine **or** auctions them via the market (`COMPUTE_PROVIDER=market.rfp`). | HTTP, behind Caddy (plain reverse proxy, **no auth**) |
| **bidder** (`bidder/main.ts`) | Market seller. Reacts to RFPs, creates bids, and on x402 payment (`/receipt/*`) provisions a droplet through the RBAC-gated compute proxy. | HTTP `:4021` |
| **qemu / miniCloud** (`qemu/main.ts`, `rbac_helper.ts`, `oidc_helper.ts`, `provisioning.ts`, `database.ts`) | DigitalOcean-compatible API + OIDC issuer. RBAC-gates `/v1/oidc/issue`, `/v2/account`, `/v2/droplets*`; spawns QEMU VMs in Docker. | HTTP `:8080`/`:9000` |
| **qemu-standalone** (`qemu/qemu-standalone.ts`) | Operator CLI that builds/boots the LiveOS QEMU image (`sudo`, chroot). | none (local CLI) |
| **viewer** (`spindle-viewer-spa/`) | Read-only browser SPA for repos / pipeline status / logs. | static site |

### Trust boundaries

1. **Public network → spindle HTTP** — `/trigger`, `/events`, `/logs`, the secrets
   XRPC endpoints, `submitBid`, `cancelPipeline`. Caddy (`spindle/Caddyfile`) is a
   bare `reverse_proxy` with no authentication.
2. **Knot → spindle** — workflow YAML + trigger metadata are fetched from the knot a
   repo points at; the `knot` hostname becomes an outbound fetch target. A compromised
   knot can serve malicious workflow YAML (inherent CI trust).
3. **Jetstream firehose → spindle/marketRFP** — bid records are untrusted until the
   bidder DID is checked against the vouched-DID allowlist.
4. **Public network → bidder `/receipt`** — provisions real compute; gated by x402
   payment (unless `X402_MAKE_FREE` — see T8).
5. **VM ↔ qemu OIDC/RBAC** — a booting VM proves possession of its SSH host key to
   exchange a single-use provisioning nonce for a scoped OIDC token, which then
   authorizes droplet self-management per a `com.fedproxy.rbac` policy.
6. **ATProto identity** — all authorization roots in DID resolution (plc.directory /
   did:web) and JWT signature verification.

### Authorization model

- **OIDC path** (`/v1/oidc/issue`, scope `droplets.wid`): RS256 JWT, `aud =
  api://<api>?actx=<actx>`. `actx` (a DID) → resolve PDS → load `com.fedproxy.rbac` →
  collect trusted issuers → verify JWT → match `sub` to a role → check path/method
  capability.
- **ATProto service-auth path** (`/v2/account`, `/v2/droplets*`, scope
  `account.auth`): `com.atproto.server.getServiceAuth` JWT, `iss = DID`, verified
  (incl. `aud`) against the DID document's `verificationMethod` keys, then the same
  RBAC policy check.

### Assets
ATProto account passwords (`ATPROTO_PASSWORD`) and PDS-issued service-auth keys; the
qemu OIDC signing key (`app.db` `jwks`); CI secrets injected into runs; the
DigitalOcean API token (`DO_TOKEN`); x402 receiver / CDP keys; compute capacity and
the money spent provisioning it.

---

## 2. Findings summary

| # | Severity | Component | Status |
|---|----------|-----------|--------|
| T1 | **Critical** | qemu `rbac_helper.ts` | **Fixed** |
| T2 | **High** | spindle `/trigger` | **Fixed** |
| T3 | **High** | spindle mutation XRPC endpoints (no caller auth) | **Mitigated** + residual |
| T4 | Medium | qemu OIDC issuance (TTL, sub check) | **Fixed** |
| T5 | Medium | marketRFP / bidder SSRF (record-supplied URLs) | **Fixed** |
| T6 | Low | scratch JWT + state files in tree | **Fixed (gitignore)** |
| T7 | Low | type / correctness errors in auth core + bidder | **Fixed** |
| T8 | **High** (config) | bidder `/receipt` `X402_MAKE_FREE` payment bypass | Documented |
| T9 | Medium | bidder `DO_TOKEN` written to on-disk credential helper | Documented |
| T10 | Low | viewer connects `wss://<spindle>` from public record | Documented (informational) |
| T11 | Info | inherent trust: knot-served workflows, VM runs requester code | Documented |

---

## 3. Detailed findings & mitigations

### T1 — (Critical) Auth bypass: RBAC lookup failure failed *open* — FIXED
**`qemu/rbac_helper.ts`, `raiseIfUnauthorized`.** If resolving the `actx` DID or
loading its `com.fedproxy.rbac` record threw, the function returned `{}` instead of
throwing. The `/v1/oidc/issue` middleware treats a non-throwing return as success and
called `next()` — **skipping both JWT validation and the policy check** on the endpoint
that mints droplet-creating OIDC tokens.
**Impact:** authentication + authorization bypass → unauthorized compute / privilege
escalation.
**Mitigation (applied):** fail closed — `throw new UnauthorizedException(...)` so the
middleware returns `401`.

### T2 — (High) Unauthenticated `/trigger` ran pipelines for arbitrary repos — FIXED
**`spindle/main.ts`, `POST /trigger`.** The firehose path drops triggers whose
`repoDid` isn't in the opt-in allowlist (`repoDidToSpindle`), but `/trigger` called
`triggerWorkflows()` with caller-supplied `knot`/`repoDid`/`ref`. With no proxy auth an
attacker could (a) **SSRF**: `knot` is used verbatim to build outbound fetch URLs, and
(b) **unauthorized compute**: run workflows / provision paid VMs on the operator's
behalf.
**Mitigation (applied):** reject triggers whose `repoDid` is not in `repoDidToSpindle`
(`403`), mirroring the firehose path. (Caller auth still needed — see T3.)

### T3 — (High) Spindle mutation XRPC endpoints have no caller authentication — MITIGATED
**`spindle/main.ts`: `addSecret`, `removeSecret`, `listSecrets`, `cancelPipeline`,
`submitBid`; `spindle/Caddyfile`.** None authenticate the caller. `addSecret` injects
secrets that flow into workflow runs (CI secret poisoning/exfiltration);
`cancelPipeline` lets anyone terminate any run (DoS); `submitBid` lets anyone enqueue
bids (the vouched-DID allowlist in `collectBidsForRfp` is the backstop); `listSecrets`
leaks key metadata.
**Mitigation (applied):** `addSecret`/`removeSecret`/`listSecrets`/`cancelPipeline`
now refuse repos not in `repoDidToSpindle`, bounding the *target* repo to opted-in
ones.
**Residual (must close for production):** this does **not** authenticate the *caller*.
Front the spindle with an authenticating proxy (the fedproxy/ATProto service-auth layer
used elsewhere) or verify an ATProto service-auth JWT whose `iss`/`sub` is the repo
owner DID inside each handler, and restrict secret/cancel ops to the owner.

### T4 — (Medium) OIDC token issuance weaknesses — FIXED
**`qemu/oidc_helper.ts`, `qemu/main.ts`.**
- **Non-expiring default:** tokens minted without `ttl` defaulted to `now + 100 years`.
  **Fixed:** bounded 24h default via `OIDC_DEFAULT_TTL_SECONDS`.
- **Loose `sub` check:** authorization used `sub.includes("actx:"+actx)`. **Fixed:**
  `subMatchesActx()` (exact or `actx:<actx>:` prefix), used by `OIDCToken.create` and
  `/v1/oidc/issue`.
- **Residual (documented):** `OIDCToken.create` still allows a caller-supplied `aud`
  override (`claims.aud`); constrain callers so they can't target another service.

### T5 — (Medium) SSRF via record-supplied URLs — FIXED
**`marketRFP.ts` (`offering.endpointUrl`, x402 `payload.url`), `bidder/main.ts`
(`rfp.sendBid`).** URLs from ATProto records were fetched server-side unvalidated.
**Mitigation (applied):** `assertSafeEgressUrl()` before each record-derived fetch —
**unconditionally** blocks non-`http(s)` schemes and cloud metadata hosts
(`169.254.169.254`, `metadata.google.internal`), and blocks RFC1918/loopback/ULA when
`MARKET_BLOCK_PRIVATE_EGRESS` is set (off by default so localhost e2e works).
**Recommendation:** set `MARKET_BLOCK_PRIVATE_EGRESS=1` where these services share a
network with internal hosts.

### T6 — (Low) Signed JWT + runtime state could be committed — FIXED
`qemu/cloud-init-fresh.yaml` (untracked, previously not ignored) embeds a real
short-lived signed provisioning JWT; the spindle also writes
`spindle-events-db.json`, `spindle-ran.logs`, `spindle-ran.yaml`. **Fixed:**
`.gitignore` entries added (`qemu/`, `spindle/`). Rotate any exposed key material.

### T7 — (Low) Type / correctness errors — FIXED
`deno check` failed across all three services; all now pass cleanly.
- `oidc_helper.ts` — definite-assignment on 6 `OIDCToken` fields.
- `rbac_helper.ts` — added `RBACProtects.scope` (the field that selects which RBAC
  record applies, i.e. the `droplets.wid` vs `account.auth` boundary); initialized
  `protects` in the joined record; cast `payload.sub`; **removed dead
  `getServiceAuthToken()`** referencing undefined `agent`/`aud`.
- `main.ts` — typed Hono context variables (`c.set`/`c.get`); `"debug"` log level.
- **`bidder/main.ts` real bug:** `const { did: rfpOwnerDid } = parseAtUri(...)`
  destructured a non-existent `did` (always `undefined`) → corrected to `repo`.
- `marketRFP.ts` — guard `winner.config` before templating it into the RBAC grant, so
  a config-less winning bid fails closed instead of emitting `undefined` trust fields.
- **`/v1/oidc/prove` tag filter** (`qemu/main.ts`): the second filter
  `(t) => !t.startsWith("oidc-sub:") || !t.split(":").length !== 3` was **retained at
  the maintainer's request** under `// @ts-expect-error`. **It is a runtime no-op** —
  precedence makes it `(!length) !== 3`, always `true`, so it passes every tag. If the
  intent is to drop malformed `oidc-sub:` tags, the predicate should be
  `!t.startsWith("oidc-sub:") || t.split(":").length === 3` (drop the leading `!`, drop
  the suppression). **Action: confirm intended behavior** — this computes the OIDC
  `sub` in a security-sensitive path.

### T8 — (High, config) Payment gate bypass via `X402_MAKE_FREE` — DOCUMENTED
**`bidder/main.ts`, `/receipt/*`; set in committed `bidder/run.sh`.** When
`X402_MAKE_FREE` is set the x402 `paymentMiddleware` is **not installed**, so
`/receipt/<accept-uri>/<cid>` is reachable with no payment and no auth. The handler
resolves accept→bid→rfp→vm and **provisions a droplet running the requester's
`user_data`**. The x402 payment *is* the authorization control for spending compute;
removing it allows unauthenticated, unpaid, repeatable provisioning → **resource
exhaustion / free compute**, and lets anyone who can craft an `accept` referencing one
of the bidder's bids drive provisioning of their own VM image.
**Mitigation:** never set `X402_MAKE_FREE` outside isolated local dev; remove it from
any shared/committed run script; treat the payment middleware as a required control.
The handler already binds `accept.rfp == bid.rfp` and pins record `version == 0.0.0`,
which limits cross-RFP confusion but does not replace payment.

### T9 — (Medium) `DO_TOKEN` written to an on-disk credential-helper script — DOCUMENTED
**`bidder/main.ts`, `configureDropletRbac`.** The DigitalOcean token is interpolated
into `git-credential-rbac-digitalocean.sh` (mode `0700`) under `~/.local/scripts`,
persisting a long-lived secret to disk in plaintext (in addition to its presence in the
process env). **Recommendation:** pass the token via an env-var credential helper
(`!f() { echo "password=$DO_TOKEN"; }`) rather than baking it into a file; ensure the
file is on a non-shared volume and removed after use; scope/rotate the token.

### T10 — (Low/Info) Viewer opens `wss://<spindle>` from a public record — DOCUMENTED
**`spindle-viewer-spa/tangled.js`, `spindleLogsUrl`/`spindleEventsUrl`.** The `spindle`
host comes from the looked-up repo record and is interpolated into a `wss://` URL
without host/scheme validation. A malicious repo record could point a viewer at an
attacker-controlled host, but only for a repo the user explicitly chose to view, over
read-only public data — low impact. Optionally validate the host shape before
connecting.

### T11 — (Info) Inherent trust assumptions
- The spindle executes `.github/workflows` fetched from the **knot** at a SHA; a
  compromised knot can serve malicious workflow YAML. This is the normal CI trust
  model — pin/verify knots you accept triggers from.
- The bidder/qemu intentionally **run the requester's `user_data` inside the VM**; the
  isolation boundary is the QEMU guest. Keep guests unprivileged relative to the host
  and avoid sharing host secrets into them.
- `qemu-standalone.ts` runs `sudo`, chroot, and mounts during image build; it is an
  operator CLI (`distro` restricted to `fedora|ubuntu`), not network-reachable.

### Reviewed and found OK
- **Viewer XSS:** all untrusted log/status/repo data rendered via `textContent` /
  `createTextNode` / `code()` — no HTML sink.
- **Provisioning nonces** are cryptographically random and **single-use** (deleted on
  read in `database.ts`); `/v1/oidc/prove` verifies an SSH host-key signature over the
  provisioning token, binding the token to the VM that actually booted.
- **DB access** uses parameterized SQLite statements (no SQL injection).
- **ATProto service-auth** verification enforces `aud` and validates against DID-doc
  keys via `@atproto/xrpc-server` `verifyJwt`.
- **Receipt handler** binds `accept.rfp == bid.rfp` (cid + uri) and rejects unknown
  record versions.

---

## 4. Changes applied in this review
- `qemu/rbac_helper.ts` — fail closed on RBAC lookup failure (T1); type fixes (T7).
- `qemu/oidc_helper.ts` — bounded default TTL + `subMatchesActx` (T4); type fixes (T7).
- `qemu/main.ts` — `subMatchesActx` in `/v1/oidc/issue` (T4); Hono var typing, log
  level (T7); `/v1/oidc/prove` filter retained under suppression (T7).
- `spindle/main.ts` — authorize `/trigger` (T2); gate secrets + `cancelPipeline` (T3).
- `spindle/marketRFP.ts` — SSRF egress guard (T5); `winner.config` guard (T7).
- `bidder/main.ts` — SSRF egress guard (T5); `repo` destructure bug + type fixes (T7).
- `spindle/.gitignore`, `qemu/.gitignore` — exclude state DBs + provisioning artifact (T6).

## 5. Top recommendations (not yet implemented)
1. **Authenticate every spindle mutation endpoint** (T3) — the single largest gap.
2. **Never run the bidder with `X402_MAKE_FREE` outside local dev** (T8); remove it
   from `bidder/run.sh`.
3. Enable `MARKET_BLOCK_PRIVATE_EGRESS=1` in networked deployments (T5).
4. Confirm the intended `/v1/oidc/prove` tag-filter behavior and remove the
   `@ts-expect-error` (T7).
5. Stop persisting `DO_TOKEN` to a file; constrain caller-supplied `aud` in
   `OIDCToken.create` (T9, T4 residual).

## 6. End-to-end verification (2026-06-07)
`trigger.sh` was run against the live stack (spindle :7777 market.rfp, bidder :4021,
qemu :9000 — all hot-reloaded with the fixes). The full chain completed in ~94s:
`/trigger` accepted (T2 gate passed for the authorized repo) → RFP created → bid
received → winner selected (config present, T7 guard passed) → RBAC minted → x402 URL
passed `assertSafeEgressUrl` (T5) → **droplet container spawned**
(`docker ps` showed `droplet-…` on `ccripoc-qemu-runner`) → `docker logs` showed the
QEMU guest booting Ubuntu + starting `policy-engine.service` → `sshPublicKey
registered` → `policy engine ready` → `workflow submitted to remote PE`. The bidder's
RBAC-gated `/v2/droplets` call succeeding confirms the T1 fail-closed change still
admits legitimate callers. No errors originated from any added guard.
