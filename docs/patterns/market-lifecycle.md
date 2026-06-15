# Market Protocol Lifecycle

RFP → Bid → Accept → Event state machine with handler factories, attestation signing, and `EventCallbacks` dispatch tables.

## Where used

- `lib/market/server.ts` — handler factories: `createSubmitRfpHandler`, `createSubmitBidHandler`, `createSubmitAcceptHandler`, `createSubmitEventHandler`
- `lib/market/auth.ts` — `verifyMarketServiceAuth`, `extractBearer`
- `lib/market/types.ts` — `Resolved<T>`, `strongRef`
- `lib/market/discovery.ts` — `discoverBiddersFromRegistries`
- `lib/market/client.ts` — client-side XRPC callers
- `lib/market/mod.ts` — barrel re-exports
- `lib/compute/eventDelete.ts` — compute event handler (vm.delete)
- `lib/hono-factory-market/mod.ts` — Hono factory wrapper
- `lib/hono-factory-market-bids/mod.ts` — settlement layer (free grants + x402 receipts)
- `lib/hono-factory-ephemeral-compute-bidder/mod.ts` — full bidder lifecycle

## Lifecycle

```
Buyer                     Market/Registry                 Provider (Bidder)
  │                            │                               │
  │  1. Publish RFP record     │                               │
  │─────────────────────────▶  │                               │
  │                            │  2. submitRfp (service auth)  │
  │                            │─────────────────────────────▶ │
  │                            │                               │  onRfp: create + sign bid
  │                            │  3. submitBid (service auth)  │
  │                            │◀───────────────────────────── │
  │  4. Choose bid, create     │                               │
  │     accept record          │                               │
  │─────────────────────────▶  │                               │
  │                            │  5. submitAccept (service auth)
  │                            │─────────────────────────────▶ │
  │                            │                               │  onAccept: provision compute
  │                            │                               │  + create receipt record
  │                            │                               │
  │                            │  6. submitEvent (service auth)│
  │                            │◀───────────────────────────── │  onVmDelete: teardown
  │                            │                               │
  │  7. Verify attestations    │                               │
  │     via network.attested   │                               │
  │     .verify                │                               │
```

## Handler factory pattern

Every submit handler follows the same structure:

```ts
export function createSubmitXxxHandler(cfg: XxxConfig): (req: Request) => Promise<Response> {
  const { deps, callbacks } = cfg;
  return async (req) => {
    // 1. Parse JSON body
    const body = await readJson(req);
    if (!body) return xrpcError("InvalidRequest", "invalid JSON", 400);

    // 2. Verify service-auth JWT + assert issuer == record author
    const auth = await authorize(req, deps, LXM, serviceIds, recordUri, log, label);
    if (auth instanceof Response) return auth;

    // 3. Verify badge.blue attestation on the record
    const sigErr = await verifyAuthored(deps, record, recordUri, keysForDid, log, label);
    if (sigErr) return sigErr;

    // 4. Delegate to caller's domain callback
    return finish(await callback({ uri, cid, record, issuerDid, resolve, log, req }));
  };
}
```

Key properties:
- **Framework-agnostic** — handlers take web-standard `Request`, return `Response`
- **Service auth gating** — every handler verifies AT Protocol inter-service JWT
- **Author === issuer** — token issuer must match record author
- **Attestation verification** — badge.blue signatures checked (can be disabled)

## Event dispatch table

`submitEvent` uses a two-level routing table:

```ts
type EventCallbacks = Record<string, Record<string, EventCallback>>;
//                           ^serviceId    ^payloadNsid

callbacks: {
  "compute-provider": {
    "com.publicdomainrelay.temp.compute.events.vm.delete": onVmDelete,
    "com.publicdomainrelay.temp.compute.events.vm.create": onVmCreate,
  },
  "package-registry": {
    "com.publicdomainrelay.temp.package.events.publish": onPublish,
  },
}
```

Dispatch picks the bucket: `serviceId` from token `aud#fragment`, then `payloadNsid` from event payload record. Unknown pairs return `200 { ok: true }` (idempotent ignore).

Background dispatch: `{ background: true }` fires callback without awaiting, responds immediately. Used for slow operations (VM teardown).

## Settlement layers

`hono-factory-market-bids` mounts two optional settlement routes:

| Mode | Route | Purpose |
|---|---|---|
| Free | `GET /<path>/*` | Parse grant path → mint free grant for accepted contracts |
| x402 | `GET /<path>/*` | Parse receipt path → mint x402 receipt (with payment middleware) |

## Attestation verification

`network.attested.verify` endpoint checks badge.blue signatures:

1. Fetch record by AT URI (optionally at specific CID)
2. Iterate `record.signatures[]` entries
3. **Inline entries** — recompute canonical CID + verify ECDSA signature. Optionally bind signing `did:key` to author DID document (`bindKeys` mode).
4. **Remote proofs** — resolve strongRef to proof record, verify it binds to subject record's canonical CID.

## Key design decisions

1. **Handler factories, not classes** — each handler is a closure over config. No `this`, no inheritance.

2. **Deps bag** — `MarketServerDeps` is a plain object with `idResolver`, `resolve`, `log`, `hostname`. Injected once, shared across handlers.

3. **`hostname` as string or function** — `hostname: string | ((req: Request) => string)`. Static for single-tenant bidder, dynamic for multi-tenant spindle.

4. **Ignore unknown events** — unknown `(serviceId, payloadNsid)` pairs return 200, not 400. Allows gradual rollout of new event types.

5. **`verifySignatures: false` by default** — attestation verification is opt-in (`bindKeys: true`). Keyless producers (ephemeral signing keys) are not rejected.

## When to use

- Multi-party protocol with RFP/Bid/Accept lifecycle
- AT Protocol service-to-service calls via PDS proxying
- Need attestation/notarization of records

## Don't use for

- Direct user-to-service calls (use OAuth, not service auth)
- Single-party workflows (overengineered — just use XRPC directly)
