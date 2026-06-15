# RBAC with AT Protocol Service Auth

Inter-service authorization using AT Protocol `getServiceAuth` JWTs, DID-document key verification, and `com.fedproxy.rbac` records stored on the operator's PDS.

## Where used

- `lib/rbac-helper/mod.ts` — `raiseIfUnauthorizedServiceAuth`, `validateATProtoServiceAuth`
- `lib/market/auth.ts` — `verifyMarketServiceAuth`, `extractBearer`
- `lib/hono-factory-atproto-repo/crypto/service-auth.ts` — `signServiceAuth`
- `lib/market/server.ts` — `authorize()` in every submit handler
- `lib/hono-factory-compute-provider-local/mod.ts` — RBAC middleware on `/v2/*` routes

## Flow

```
Incoming request with Authorization: Bearer <serviceAuthJWT>
  │
  ├─1. extractBearer() — parse Bearer token from header
  │
  ├─2. verifyJwt(token, null, lxm, resolveKey) — verify signature + lxm + expiry
  │     via @atproto/xrpc-server. `resolveKey` fetches DID doc verificationMethod.
  │
  ├─3. Assert aud matches service DID (bare or #serviceId fragment)
  │
  ├─4. raiseIfUnauthorizedServiceAuth():
  │     │
  │     ├─4a. validateATProtoServiceAuth(token, service)
  │     │     — Parse iss, resolve DID doc, verify JWT signature
  │     │
  │     ├─4b. Resolve OPERATOR_HANDLE → operator DID → operator PDS
  │     │
  │     ├─4c. getServiceAllowlist(operatorPds, operatorDid, service, scope)
  │     │     — Paginated fetch of com.publicdomainrelay.temp.auth.allowlist.rbacDid
  │     │     — One record per service+scope, lists allowed issuer DIDs
  │     │
  │     ├─4d. checkAllowedToUseService(allowlist, iss)
  │     │     — Throws if token iss not on operator's allowlist
  │     │
  │     ├─4e. getRBACRecord(issuerPds, iss, service, scope)
  │     │     — Paginated fetch of com.fedproxy.rbac from issuer's PDS
  │     │     — Merges policies + roles across all matching records
  │     │
  │     └─4f. checkRBACPolicy(rbac, sub, path, method)
  │           — Match sub → roles → policies → path schema → capability enum
  │           — HTTP method → capability: GET→read, POST→create, PUT→update, DELETE→delete
  │
  └─5. Request authorized (or UnauthorizedException thrown)
```

## Token minting (caller side)

```ts
// lib/hono-factory-atproto-repo/crypto/service-auth.ts
export async function signServiceAuth(signer: Signer, opts: ServiceAuthOptions): Promise<string> {
  const iss = signer.did();  // did:key:z...
  const payload = {
    iss,
    aud: opts.aud,   // did:web:service.example.com or did:web:...#serviceId
    iat: now,
    exp: now + (opts.expiresInSec ?? 60),
    jti: crypto-random,
    lxm: "com.example.doThing",  // lexicon method
  };
  // Sign ES256K with secp256k1 key
}
```

## Token verification (receiver side)

```ts
// lib/market/auth.ts
export async function verifyMarketServiceAuth(opts): Promise<ServiceAuthResult> {
  const token = extractBearer(authHeader);
  // verifyJwt with null aud — we assert aud by hand to tolerate bare DID + #fragments
  const payload = await verifyJwt(token, null, lxm, (did) => idResolver.did.resolveAtprotoKey(did));
  // Build acceptable aud set: did:web:host, did:web:host#serviceId1, ...
  const acceptable = new Map();
  for (const did of [serviceDid, ...extraAudienceDids]) {
    acceptable.set(did, undefined);
    for (const id of serviceIds) acceptable.set(`${did}#${id}`, id);
  }
  if (!acceptable.has(aud)) throw;
  return { issuerDid: iss.split("#")[0], audience: aud, serviceId: acceptable.get(aud) };
}
```

## RBAC record shape

Stored as `com.fedproxy.rbac` on the operator's PDS:

```json
{
  "protects": {
    "droplets": { "service": "compute-provider", "scope": "droplets.wid" }
  },
  "policies": {
    "droplet-admin": {
      "schemas": {
        "/v2/droplets": {
          "properties": {
            "capability": { "enum": ["create", "read", "update", "delete"] }
          }
        }
      }
    }
  },
  "roles": {
    "operator": {
      "definition": {
        "iss": "https://oidc-issuer.example.com",
        "sub": "actx:alice-account-id",
        "policies": ["droplet-admin"]
      }
    }
  }
}
```

## Operator allowlist

Stored as `com.publicdomainrelay.temp.auth.allowlist.rbacDid`:

```json
{
  "protects": {
    "main": { "service": "compute-provider", "scope": "droplets.wid" }
  },
  "allowed": {
    "trusted_issuers": ["did:plc:abc123", "did:web:trusted.example.com"]
  }
}
```

## Key design decisions

1. **Dual authorization** — operator allowlist (who can call) + issuer RBAC (what they can do). Both must pass.

2. **PDS as RBAC store** — RBAC records live in AT Protocol repos, not a separate database. Fetch is paginated, merged across records.

3. **Path glob matching** — policy schemas support `*` wildcards: `/v2/droplets/*` matches `/v2/droplets/abc123`.

4. **HTTP method → capability mapping** — GET→read, POST→create, PUT→update, DELETE→delete. No custom action strings.

5. **Fail closed** — any lookup/validation failure throws `UnauthorizedException`. Never default to authorized.

## When to use

- AT Protocol service-to-service calls via PDS proxying
- Multi-tenant services where each tenant manages their own RBAC records on their PDS
- Need operator-controlled allowlist on top of tenant-controlled RBAC

## Don't use for

- Browser-to-service calls (use OIDC, not service auth — browsers can't mint `getServiceAuth` tokens)
- Non-AT Protocol services
