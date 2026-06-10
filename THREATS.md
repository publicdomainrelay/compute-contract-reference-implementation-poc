# Threat Model & Security Review — compute-contract-reference-implementation-poc

_Last full re-review: 2026-06-09. Scope: all code under `src/typescript/`
(`spindle`, `bidder`, `qemu`, `spindle-viewer-spa`, `utils`, **and the extracted
`lib/*` packages**: `market`, `attestation`, `market-settlement`, `market-x402`,
`market-free`, `hono-factory-*`, `compute-provider-digitalocean`, `compute`,
`atproto-helpers`, `deno-hono-helpers`) plus run scripts, Dockerfiles, and
cloud-init templates. The component map and end-to-end auction flow analyzed here
are diagrammed in [README.md](./README.md)._

> **2026-06-09 note.** Since the 2026-06-07 review the bidder and spindle were
> refactored: their inline market/auth/provisioning logic moved into the shared
> `src/typescript/lib/*` packages and the bidder was rewritten on top of them
> (settlement abstraction, badge.blue attestation layer, Hono factories). Findings
> **T1–T11** below were written against the pre-refactor tree; the verified fixes
> still hold (re-confirmed: T1 fail-closed RBAC, T4 OIDC TTL/`sub`, and the T7
> `/v1/oidc/prove` tag filter is now correctly implemented — see §7). New findings
> against the refactored library layer are **T12–T18 in §7**, and the **T2/T3
> statuses are updated there** (`/trigger` is now authenticated; the secrets
> endpoints still are not).

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
| **spindle** (`spindle/main.ts`, `marketRFP.ts`) | CI backend. Watches knots **and the jetstream firehose** for `sh.tangled.pipeline` triggers, fetches `.github/workflows/*` at a commit SHA, runs them via a local policy engine **or** auctions them via the market (`COMPUTE_PROVIDER=market.rfp`), **actively notifying vouched bidders** (`sh.tangled.graph.vouch` → `market.offering`) via `submitRfp`. | HTTP `:8090`, behind Caddy (plain reverse proxy, **no auth**) |
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
3. **Jetstream firehose → spindle/marketRFP** — bid records (firehose + the
   `submitBid` XRPC push into `pendingBids`) are untrusted until the bidder DID is
   checked against the vouched-DID allowlist built from `sh.tangled.graph.vouch`
   (repo owner + knot members). The same discovery step fetches each candidate's
   record-supplied `market.offering.endpointUrl` and POSTs `submitRfp` to it — an
   outbound egress driven by record content (egress-validated; see T5).
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
| T2 | **High** | spindle `/trigger` | **Fixed** (now service-auth authenticated — §7) |
| T3 | **High** | spindle mutation XRPC endpoints (no caller auth) | **Partly closed**: `/trigger` authed; secrets/`cancelPipeline` **still unauthenticated** (§7) |
| T4 | Medium | qemu OIDC issuance (TTL, sub check) | **Fixed** |
| T5 | Medium | marketRFP / bidder SSRF (record-supplied URLs) | **Fixed** |
| T6 | Low | scratch JWT + state files in tree | **Fixed (gitignore)** |
| T7 | Low | type / correctness errors in auth core + bidder | **Fixed** (incl. `/v1/oidc/prove` filter — §7) |
| T8 | **High** (config) | bidder `/receipt` `X402_MAKE_FREE` payment bypass | Documented → superseded/generalized by **T12** |
| T9 | Medium | bidder `DO_TOKEN` written to on-disk credential helper | Documented (still present — §7) |
| T10 | Low | viewer connects `wss://<spindle>` from public record | Documented (informational) |
| T11 | Info | inherent trust: knot-served workflows, VM runs requester code | Documented |
| **T12** | **High** | `SETTLEMENT=free`/`X402_MAKE_FREE` → no settlement check on `submitAccept` → open compute provisioning | **§7 — new** |
| **T13** | Medium | badge.blue inline signatures verified with `bindKeys=false` → no authenticity guarantee | **§7 — new** |
| **T14** | Medium | `submitBid` trusts body `cid`/`record` without re-resolving from PDS | **§7 — new** |
| **T15** | Medium | `cancelPipeline` undefined-`trigger` ReferenceError (fails closed) + no caller auth | **§7 — new** |
| **T16** | Medium | knot/PE/PDS fetches not run through the egress (SSRF) guard | **§7 — new** |
| **T17** | Low | run scripts use `deno run --allow-all` | **§7 — new** |
| **T18** | Low/Info | x402 CDP facilitator auth provider is a stub (`return {}`) | **§7 — new** |
| **T19** | Medium | net-only PE sandbox grants **unrestricted** `net` to untrusted code (SSRF/exfil from PE host) | **§8 — new** |
| **T20** | Low | `--fs-api` re-grants filesystem to net-only workers over unauthenticated localhost HTTP; `safeJoin` prefix bug | **§8 — new** |
| **T21** | Low | policy-engine HTTP API has no caller authentication | **§8 — new** |

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
1. **Make free settlement bind to a bidder-issued grant** (T12) — call
   `verifyFreeGrant` in `createFreeSettlement.verifyAcceptPayload`, and remove
   `X402_MAKE_FREE`/`SETTLEMENT=free` from the committed run scripts. This is the
   single largest gap in the refactored tree (open compute provisioning).
2. **Authenticate the remaining spindle mutation endpoints** (T3/T15) —
   `addSecret`/`removeSecret`/`listSecrets`/`cancelPipeline`; and fix the
   `cancelPipeline` undefined-`trigger` bug.
3. **Enable badge.blue key binding** (`bindKeys: true`) and publish each
   producer's attestation key in its DID document — including the spindle's
   `did:web` doc, which currently has no `verificationMethod` (T13).
4. **Re-resolve `submitBid` records from the PDS** instead of trusting the inline
   body cid/record (T14).
5. **Route knot/PE/PDS fetches through the egress guard** and bind `knot` to the
   repo's recorded knot (T16); enable `MARKET_BLOCK_PRIVATE_EGRESS=1` in networked
   deployments (T5).
6. Stop persisting `DO_TOKEN` to a file (T9); constrain caller-supplied `aud` in
   `OIDCToken.create` (T4 residual); scope `--allow-all` in run scripts (T17);
   implement real x402 facilitator auth (T18).
7. **Wire `runs-on: net-only` to a local net-only policy engine** (§8, ADR 0008):
   for network-only workflows this skips the entire market.rfp/provisioning path,
   removing T8/T12/T13/T14 for that class and shrinking T11. Pair it with a `net`
   **allowlist** for the sandbox (T19), keep `--fs-api` out of the isolation
   promise (T20), and keep the PE non-public (T21).

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

---

## 7. Re-review 2026-06-09 — refactored library layer (`lib/*`)

The auction/auth/provisioning logic was extracted from the two monolithic
services into shared packages and the bidder was rewritten on top of them. The
core authentication design is sound: every market submit procedure verifies an
ATProto inter-service-auth JWT and requires the token's issuer to be the author
of the referenced record (`lib/market/server.ts` `authorize()`), referenced
records are fetched from their authoritative PDS with the strongRef **cid pinned**
(`lib/market/resolve.ts`), and the contract graph enforces `bid.rfp ==
accept.rfp` before any resource is touched (`lib/market/contract.ts`). The
findings below are gaps layered on top of that design.

### Status changes to earlier findings
- **T2 — FIXED (caller now authenticated).** `spindle/main.ts` `handleTrigger`
  now requires a service-auth JWT bound to `…spindle.trigger` whose issuer equals
  the trigger's declared `actor`, in addition to the repo-opt-in check. The bare
  `/trigger` alias shares the same handler, so the previously-unauthenticated path
  is closed.
- **T3 — only partly closed.** `addSecret` / `removeSecret` / `listSecrets`
  (`spindle/main.ts`) and `cancelPipeline` still authenticate **no caller** — they
  only check that the *target* repo opted into this spindle
  (`repoRegisteredToThisSpindle`). Anyone who can reach the spindle can still
  add/remove/list secrets for any opted-in repo and cancel its runs. (Mitigating
  fact today: the secret store is *write-only* — `submitWorkflow`/`marketRFP`
  never read `secretsStore`, so injected secrets don't yet reach runs — but
  `listSecrets` leaks key metadata and the store is a latent poisoning sink.)
  **Action unchanged from T3 residual:** verify a service-auth JWT whose issuer is
  the repo owner inside each of these handlers.
- **T7 `/v1/oidc/prove` filter — RESOLVED.** The no-op predicate under
  `@ts-expect-error` is gone; `qemu/main.ts:346` now filters tags with
  `t.startsWith("oidc-sub:") && t.split(":").length === 3 && t.split(":")[1] !==
  "actx"`, which correctly drops malformed/`actx` tags before computing the OIDC
  `sub`. No suppression remains.

### T12 — (High) `SETTLEMENT=free` / `X402_MAKE_FREE` removes the settlement check on `submitAccept` → open, repeatable compute provisioning
**`lib/market-settlement/settlement.ts` (`settlementModeFromEnv`),
`lib/market-settlement/bids_free.ts` (`createFreeSettlement.verifyAcceptPayload`),
`bidder/main.ts` (`onAccept`); set in committed `bidder/run.sh` &
`run-fedfork.sh`.** `settlementModeFromEnv()` treats `X402_MAKE_FREE` as an alias
for `SETTLEMENT=free`. In free mode the bidder's `onAccept` still calls
`settlement.verifyAcceptPayload(accept.payload)`, but the free implementation is a
**no-op** (`// Free bids have no receipt to verify.`). Nothing else proves the
contract is one the bidder agreed to: `resolveContractGraph` only checks
`bid.rfp == accept.rfp` and the (non-authoritative, see T13) record signatures —
it does **not** check that the bid was authored by this bidder, that the bidder
ever issued a grant, or that the RFP was one it bid on. The `authorize()` gate
only requires the caller to author *its own* accept.

**Impact.** Any DID can create an rfp + bid + accept entirely in its own repos
(`bid.rfp` pointing at its own rfp) and POST `submitAccept`; the bidder resolves
the graph, the free no-op "verifies", and it **provisions a real droplet running
the requester's `vm.user_data`** — unpaid, unauthenticated beyond
author-your-own-record, and repeatable → resource exhaustion + attacker-chosen
code running on the provider's compute. This generalizes T8 (which was scoped to
the x402 receipt endpoint) to the whole settle/provision path, and the committed
run scripts enable it.

**Mitigation.**
- Free mode must still bind the contract to the bidder: have
  `createFreeSettlement.verifyAcceptPayload` call the existing
  `verifyFreeGrant({ payment, resolve, bidderDid })` (it already checks the
  payload is a `receipts.free` authored by this bidder and CID-bound to its
  `accepts.free`), and gate the free receipt endpoint
  (`hono-factory-market-bids`) with an allowlist / rate limit.
- Treat `SETTLEMENT=free` / `X402_MAKE_FREE` as **local-dev only**; remove them
  from `bidder/run.sh` and `run-fedfork.sh`.
- Optionally have the bidder record the bids it actually authored and refuse to
  settle an accept whose bid isn't one of them.

### T13 — (Medium) badge.blue inline signatures are verified with `bindKeys=false`, so they prove integrity-against-a-self-chosen-key, not authenticity
**`lib/attestation/inline.ts` (`verifyInlineAttestation`), `lib/market/server.ts`
(`bindKeys` defaults false), `lib/market/contract.ts` & `spindle/marketRFP.ts`
(`verifyRecordSignatures` called with no `keysForDid`).** `verifyInlineAttestation`
recomputes the attestation CID and verifies the ECDSA signature using
**`entry.key` — the did:key embedded in the signature entry itself**, which is
fully attacker-controlled. Binding `entry.key` to the author/issuer DID document
only happens when `bindKeys` (→ `keysForDid`) is supplied, and it is **off by
default** everywhere in this tree: the bidder's `marketDeps` and the spindle's
`marketDeps` don't set it, and `resolveContractGraph` / the spindle's winning-bid
check pass no `keysForDid`. With binding off, a forged record can carry a valid
signature by a freshly-generated attacker key and pass `verifyRecordSignatures`.

**Impact.** The signature layer adds **no authenticity** on its own — it only
detects mutation relative to a key the same party picked. The actual authenticity
controls are ATProto service-auth (`authorize()`: issuer must author the record
URI) and cid-pinned PDS resolution. The risk is a *false sense of assurance*: the
`server.ts` comment ("signature validity only, which already proves the record is
untampered") overstates the guarantee, and any future code path that trusts a
record on its signature *without* the service-auth/PDS path (e.g. the provenance
bundle injected into the VM, or offline verification) would be forgeable.
Compounding it, the **spindle's `did:web` document publishes no
`verificationMethod`** (`spindle/main.ts` `/.well-known/did.json`), so even a
consumer that enabled `bindKeys` could not bind spindle-authored
rfp/accept/event signatures.

**Mitigation.** Set `bindKeys: true` in both services and have every producer
publish its attestation did:key as a Multikey `verificationMethod` in its DID
document (the bidder already does this via `attestationVerificationMethod`; the
spindle does not). Where binding is intentionally off, document in code that the
inline signature is *non-authoritative* and ATProto authorship is the control, so
no future caller mistakes it for proof of origin.

### T14 — (Medium) `submitBid` trusts the request body's `cid` and inline `record` without re-resolving from the PDS
**`lib/market/server.ts` (`createSubmitBidHandler`), `spindle/main.ts`
(`onBid`).** Unlike `submitRfp`/`submitAccept` (which resolve the referenced
record from its PDS by cid), `submitBid` takes the `record` and `cid`
**inline from the request body**; `authorize()` only verifies the JWT issuer
authored the bid `uri`. The cid is never checked to hash the record, and the
record is never re-fetched. A vouched-but-malicious bidder can therefore submit a
bid whose inline `record`/`cid` differ from what is actually in its repo. The
spindle pushes it straight into `pendingBids` and `scoreLowestCost` scores the
**unverified inline payload/cost**, so winner selection can be driven by data that
doesn't match any real record. (A bogus cid later breaks the bidder's
`resolveContractGraph`, which fails closed, but the mis-scored winner has already
been chosen and the legitimate competing bids passed over.)

**Mitigation.** In `createSubmitBidHandler`, ignore the inline `record`/`cid` and
re-resolve the bid from the PDS by `uri` (verifying the cid), or verify the
supplied cid is the badge.blue/atproto hash of the supplied record before
accepting it. Score only resolved records.

### T15 — (Medium) `cancelPipeline` references an undefined `trigger` (ReferenceError → 500) and has no caller authentication
**`spindle/main.ts` `POST /xrpc/sh.tangled.pipeline.cancelPipeline`
(line ~1782).** The handler destructures `{ pipeline, repo, workflow }` from the
body, then calls
`repoRegisteredToThisSpindle(c.req.header("host") ?? HOSTNAME, trigger.repoDid)` —
but **`trigger` is not in scope** in this handler. This throws a `ReferenceError`
caught by `app.onError`, so the endpoint **always returns 500** and cancellation
is currently non-functional (it fails *closed*, so there is no exposure today).
The intended reference is the body's `repo`. Separately, once fixed, the endpoint
still authenticates **no caller** (same class as T3): it would let anyone cancel
any run of any opted-in repo (DoS).

**Mitigation.** Use `repo` instead of `trigger.repoDid`; add service-auth caller
authentication (issuer must be the repo owner) before allowing a cancel, matching
`/trigger`.

### T16 — (Medium) knot / policy-engine / PDS fetches bypass the egress (SSRF) guard
**`spindle/main.ts` (`knotBaseUrl`, `fetchWorkflowTree`, `fetchWorkflowBlob`,
`submitWorkflow`, `resolvePDS`), `lib/market/egress.ts`.** `assertSafeEgressUrl`
is applied only to the x402 payment URL (T5). The `knot` hostname from a trigger
(or `meta.repo.knot` on the firehose path) is interpolated **verbatim** into
outbound `sh.tangled.repo.tree`/`blob` URLs, and the knot is **not validated
against the repo record's registered knot**. An authenticated owner of an
opted-in repo — or a poisoned `sh.tangled.pipeline` record — can therefore steer
the spindle's outbound fetches at an arbitrary host (including internal/cloud-
metadata addresses). The severity is bounded by the new `/trigger` auth + repo
opt-in, but the SSRF primitive remains and is broader than the single guarded
egress.

**Mitigation.** Validate the trigger's `knot` against the knot recorded for that
repo, and route knot/PE/PDS fetches through `assertSafeEgressUrl` (with
`blockPrivate` enabled in networked deployments), the same guard the market
egress uses.

### T17 — (Low) run scripts grant `deno run --allow-all`
**`bidder/run.sh`, `bidder/run-fedfork.sh`, `spindle/run-fedcicd.sh`.** These run
the services with full filesystem/network/subprocess/env permissions — including
the `DIGITALOCEAN_TOKEN` and the ability to spawn arbitrary processes (the bidder
does shell out to `git`). `spindle/run.sh` already scopes permissions
(`--allow-net --allow-env --allow-read --allow-write`). **Mitigation:** scope each
service to the permissions it actually needs; reserve `--allow-run` for the bidder
and constrain `--allow-read`/`--allow-write` paths.

### T18 — (Low/Info) x402 CDP facilitator auth provider is a stub
**`lib/market-settlement/bids_x402.ts` (`cdpAuthProvider`, `makeFacilitator`).**
`cdpAuthProvider` ignores the configured key id/secret and returns `{}`, and the
facilitator client is constructed with an `as any` cast. As a PoC stub this is
fine, but the x402 payment control that T8/T12 depend on is only as strong as a
correctly-authenticated facilitator; shipping this as-is would mean payment
verification runs against an unauthenticated/misconfigured facilitator.
**Mitigation:** implement real CDP auth (or fail fast when the keys are unset
while `SETTLEMENT=x402`) before treating x402 as an enforced control.

### Reviewed and found OK (refactored layer)
- **x402 accept-payload verification** (`lib/market-x402/server.ts`
  `verifyX402Payment`): requires the payload to resolve to a `receipts.x402`
  **authored by this bidder** and re-verifies the badge.blue remote-proof CID
  binds it to its `accepts.x402` — a copied/replayed receipt fails.
- **Contract graph** (`lib/market/contract.ts`): enforces `bid.rfp == accept.rfp`
  (cid + uri) before resolving payloads.
- **vm.delete authorization** (`lib/compute/eventDelete.ts`): requires the
  submitEvent token issuer to equal the `market.accept` author derived from the
  resolved receipt, and that a droplet is still tracked for that receipt.
- **Egress guard** (`lib/market/egress.ts`): unconditionally blocks non-`http(s)`
  schemes and `169.254.169.254` / `metadata.google.internal`; private ranges
  opt-in via `blockPrivate`.
- **Attestation CID** (`lib/attestation/cid.ts`): binds the repository DID into
  the signed payload, so the same record in another repo yields a different CID
  (replay defense), and strips `signatures`/`$sig` deterministically.
- **Droplet size is hardcoded** (`compute-provider-digitalocean` `createDroplet`:
  `s-1vcpu-512mb-10gb`), so an RFP cannot amplify resource usage via VM specs —
  the abuse vector is *count* (T12), not per-VM size.

---

## 8. Net-only policy engine as a mitigation option (assessed 2026-06-09)

Scope: `policy-engine/` (Deno + Hono port of the Go policy engine) and
`bundled-actions-net-only/` (net-only-compatible TS reimplementations of
`tangled/checkout` and `dorny/paths-filter`). Assessed for the goal: _can a
`runs-on: net-only` workflow run in a strict in-process sandbox and skip the
market.rfp / VM-provisioning flow entirely?_

### What net-only actually provides
`policy-engine/src/eval.ts` and `action_worker.ts` evaluate `${{ }}` expressions
and run JS/TS `uses:` actions inside in-process Deno **Web Workers with explicit
per-worker permissions** (`--unstable-worker-options`). In net-only mode the
worker gets `net` **only** — `read/write/run/env/sys/ffi/import` are all denied —
and `WorkflowExecutor.assertExecAllowed` (`workflow.ts`) **refuses `run` steps,
composite actions, and action downloads**. Action inputs are injected via a
`Deno.env` shim and `GITHUB_OUTPUT`/`ENV`/`PATH`/`STATE` writes are captured into
an in-memory VFS, so the worker never sees the host env or filesystem. This is an
OS-/runtime-enforced sandbox, not a convention — even with the host on
`--allow-all`, the worker can't exceed its permission set.

### How it helps existing findings (strong positive)
For any workflow that only needs the network (pure policy evaluation, API/HTTP
checks, lightweight `uses:` actions), routing it to a **local net-only policy
engine instead of `market.rfp`** removes whole attack surfaces at once:

- **T8 / T12 (open compute provisioning) — eliminated for that class.** No RFP, no
  bidder, no `accept`/settlement, no droplet ⇒ the free-settlement / `submitAccept`
  provisioning abuse path simply does not exist for net-only jobs.
- **T13 / T14 (record-trust gaps in the market path) — not reached** for net-only
  jobs, since none of the market submit/resolve flow runs.
- **T11 (inherent trust: VM runs requester code; isolation = QEMU guest) —
  shrunk.** The isolation boundary becomes an in-process Deno-permission sandbox
  with no FS/exec/host-secrets, which is a *cheaper and tighter* boundary than a
  VM for workloads that fit. Full workloads (anything needing `run:`/a shell/FS)
  still need the default sandbox or a VM, so T11 remains for those.

### Current gap to realize the option
Net-only is presently a **global** server switch (`--net-only` /
`POLICY_ENGINE_NET_ONLY`); `WorkflowExecutor` does **not** inspect a job's
`runs-on` to choose the sandbox, and `spindle` selects compute globally via
`COMPUTE_PROVIDER` (local PE vs `market.rfp`). So "`runs-on: net-only` skips the
market" is **not wired yet** — it requires per-job routing in the spindle (see
[ADR 0008](./docs/adrs/arch/0008-net-only-runs-on-routing.md)).

### New net-only-specific findings

#### T19 — (Medium) net-only sandbox grants *unrestricted* `net` to untrusted code
**`policy-engine/src/eval.ts` & `action_worker.ts` (`permissions().net = true`).**
The worker permission is `net: true`, which in Deno is **all hosts/ports**. Untrusted
expression and action code can therefore reach anything the policy-engine host can
route to — internal services and the cloud metadata endpoint
(`169.254.169.254` / `metadata.google.internal`) included — and exfiltrate
whatever it reads. This is the same egress concern as T5/T16, now *inside* the
sandbox: net-only removes FS/exec risk but keeps a full outbound-network
capability. **Mitigation:** pass an **allowlist** to the worker
(`net: ["api.github.com:443", "<knot host>:443", …]`) instead of `true`, and/or
run the PE host behind an egress firewall that blocks RFC1918/link-local/metadata.
Drive the allowlist from config the same way `MARKET_BLOCK_PRIVATE_EGRESS` drives
the market guard.

#### T20 — (Low) `--fs-api` re-grants filesystem access to net-only workers
**`policy-engine/src/fs_api.ts`.** When `--fs-api` is set, the engine binds an
**unauthenticated** Hono server on a random localhost port exposing
`GET/PUT /file`, `POST /mkdir`, `GET /ls`, and injects its URL into every worker.
Because net-only workers have unrestricted `net` (T19), they can call it over
`127.0.0.1` — so enabling `--fs-api` **re-grants filesystem access** (scoped to the
root dir) to code the sandbox was supposed to keep off disk, partially defeating
the net-only guarantee. The net-only `tangled/checkout` action depends on exactly
this. Additionally, the traversal guard `full.startsWith(root)` lacks a separator
boundary, so a sibling directory sharing the root's name prefix (root
`/tmp/pe-fsapi-abc` vs `/tmp/pe-fsapi-abc-evil`) passes the check.
**Mitigation:** treat `--fs-api` as incompatible with the net-only isolation
promise (document it), or require a per-run bearer token on the fs-api and fix
`safeJoin` to compare against `root + sep` (or use a relative-path containment
check). Scope the root to a per-run ephemeral dir (already the case) and never the
host root.

#### T21 — (Low) policy-engine HTTP API has no caller authentication
**`policy-engine/src/server.ts`.** `/request/create`, `/request/status/*`,
`/request/console_output*`, `/webhook/github` carry no caller auth (only permissive
CORS). Anyone who can reach the port can submit workflows for evaluation (in
net-only mode that means driving arbitrary outbound requests via T19, or in full
mode arbitrary `run:` execution). In the local/default deployment the PE must stay
bound to **localhost** behind the (authenticated) spindle; in the market path the
remote PE is fronted by fedproxy RBAC. **Mitigation:** keep the PE non-public; if a
net-only PE is exposed for `runs-on: net-only` routing, front it with the same
service-auth the spindle uses (ADR 0002) and never bind it to `0.0.0.0` without a
proxy.

### Reviewed and found OK (net-only)
- **Sandbox enforcement is real:** worker permissions deny `read/write/run/env/
  sys/ffi`; `run`/composite/download paths fail closed via `assertExecAllowed`.
- **No host-env leakage:** the `Deno.env` shim exposes only injected `INPUT_*`/
  `GITHUB_*`, never the host environment; `Deno.exit` is contained.
- **Unresolved expression conditions fail closed** (per README; `if:` gating).
