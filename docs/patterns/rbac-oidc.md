# RBAC with OIDC Workload Identity

Machine-to-machine auth using OIDC RS256 JWTs with `actx:` scoped subjects, JWKS discovery, and SSH challenge proofs for VM provisioning.

## Where used

- `lib/oidc-helper/mod.ts` — `OIDCToken.create`, `OIDCToken.validate`, `configureOidc`
- `lib/rbac-helper/mod.ts` — `raiseIfUnauthorized` (OIDC path)
- `lib/hono-factory-workload-identity-droplet-oidc-poc/mod.ts` — OIDC issuer app
- `lib/hono-factory-workload-identity-droplet-oidc-poc/provisioning.ts` — nonce + SSH chain
- `lib/hono-factory-compute-provider-local/mod.ts` — OIDC middleware on `/v1/*` routes

## Flow

```
Client requests OIDC token from issuer:
  │
  ├─1. POST /v1/oidc/issue
  │     │
  │     ├─1a. raiseIfUnauthorized (OIDC path):
  │     │     │
  │     │     ├─ Peek unverified aud → extract actx (DID/UUID) + api
  │     │     ├─ Resolve actx → PDS → fetch com.fedproxy.rbac records
  │     │     ├─ Collect trusted issuers from role.definition.iss
  │     │     ├─ Verify JWT against those issuers via OIDC discovery + JWKS
  │     │     └─ Match sub → roles → policies → check capability
  │     │
  │     └─1b. OIDCToken.create(actx, claims, api)
  │           — RS256 signed, audience "api://<api>?actx=<actx>"
  │           — Default TTL: 24h (env OVERRIDE: OIDC_DEFAULT_TTL_SECONDS)
  │
  └─2. Client uses OIDC token to authenticate to resource servers

Provisioning flow (VM creation):
  │
  ├─3. ProvisioningData.create(actx, claims, dropletId, nonceStore)
  │     │
  │     ├─3a. Generate crypto-random nonce (hex)
  │     ├─3b. Create short-lived OIDCToken with nonce in claims
  │     ├─3c. Build cloud-init with SSH signing script
  │     └─3d. associateWithDroplet(nonce, dropletId)
  │
  ├─4. POST /v1/oidc/prove
  │     │
  │     ├─4a. validateSshSignature — verify Ed25519 SSH signature via ssh-keygen
  │     ├─4b. Get public key via ssh-keyscan polling
  │     ├─4c. Verify OIDC token (same chain as validate)
  │     └─4d. Verify nonce matches droplet
  │
  └─5. VM identity proven → access granted
```

## OIDC token structure

```ts
// Creation (lib/oidc-helper/mod.ts:177-222)
const token = await new jose.SignJWT(payload)
  .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
  .setIssuer(issuerUrl)
  .setAudience(`api://${api}?actx=${actx}`)
  .setIssuedAt()
  .setExpirationTime(expTime)
  .sign(keys.privateKey);
```

Audience format: `api://<api>?actx=<actx>` — the `actx` query param carries the actor context (DID or account UUID). Parsed by `parseAudience()`.

Subject format: `actx:<actx>[:role:...:...]` — enforced by `subMatchesActx()`. Must be exact match or `actx:<actx>:` prefix. No loose substring matching (security).

## Pluggable configuration

```ts
configureOidc({
  getIssuerUrl: () => dynamicUrl,  // lazy — issuer URL known only after relay registration
  store: persistentJwkStore,        // injectable persistence (default: in-memory)
  defaultTtlSeconds: 3600,          // default token lifetime
});
```

- **`getIssuerUrl`** — lazy getter. Callers whose issuer URL is only known at runtime (after XRPC relay registers a `did:web`) pass a closure.
- **`JwkStore`** — interface with `getJwkPem`/`saveJwkPem`. Default memory store replaced by SQLite in `qemu/database.ts`.
- **Signing key** — RS256 4096-bit. Auto-generated once, persisted via JwkStore. Public JWK exposed via `getPublicJwk()` with kid thumbprint.

## Multi-issuer validation

```ts
// lib/oidc-helper/mod.ts:224-273
static async validate(token, getIssuers?) {
  // 1. Peek unverified aud → extract actx + api
  const unverified = jose.decodeJwt(token);
  const { actx, api } = parseAudience(unverified.aud);

  // 2. Collect issuers: own + callbacks from RBAC role.definition.iss
  const issuers = [...new Set([ownIssuer, ...extraIssuers])];

  // 3. Try each issuer:
  for (const issuer of issuers) {
    if (issuer === ownIssuer) {
      jwks = own signing key;
    } else {
      // Fetch /.well-known/openid-configuration → jwks_uri → createRemoteJWKSet
      const config = await fetch(`${issuer}/.well-known/openid-configuration`);
      jwks = getRemoteJwks(config.jwks_uri);  // cached
    }
    await jose.jwtVerify(token, jwks, { issuer, audience: expectedAud });
  }
}
```

## OIDC Issuer app routes

`hono-factory-workload-identity-droplet-oidc-poc` exposes:

| Route | Purpose |
|---|---|
| `GET /.well-known/openid-configuration` | OIDC discovery — issuer, jwks_uri, token_endpoint |
| `GET /.well-known/jwks` | Public JWK for token verification |
| `POST /v1/oidc/issue` | Mint OIDC token (RBAC-gated via `raiseIfUnauthorized`) |
| `POST /v1/oidc/prove` | Prove VM identity via SSH challenge |

## SSH challenge proof

VM proves ownership of Ed25519 host key by signing a challenge nonce:

```ts
// provisioning.ts:230-273
async function validateSshSignature(pubkey, signatureB64, challenge) {
  // 1. Write pubkey to temp file
  // 2. Write challenge to temp file with ssh- prefix wrapper
  // 3. Run: ssh-keygen -Y verify -f pubkey -n file -s sig -I $(hostname)
  // Returns: true if Ed25519 signature valid
}
```

## When to use

- Workload identity for VMs/containers that need to prove who they are
- Multi-tenant services where tenants bring their own OIDC issuer
- Need short-lived, scoped tokens for machine-to-machine calls

## Don't use for

- Browser user auth — use AT Protocol OAuth (see `compute-spa/src/lib/auth.svelte.ts`)
- ATProto inter-service calls — use service auth JWTs, not OIDC RS256
