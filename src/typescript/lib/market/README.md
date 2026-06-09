# @publicdomainrelay/market

Helpers for the `com.publicdomainrelay.temp.market.*` lexicons and their
`submitRfp` / `submitBid` / `submitAccept` / `submitEvent` XRPCs.

Two halves:

- **server** — framework-agnostic `(Request) => Promise<Response>` handler
  factories that verify inter-service auth, require the token issuer to author
  the referenced record, resolve the strongRef'd record(s), and dispatch to
  *your* callback. `submitEvent` additionally routes by
  `serviceId → payload NSID`, so one endpoint can fan a
  `compute.events.vm.delete` payload to one handler and other event types to
  others.
- **client** — a `MarketClient` that calls those procedures on a counterparty
  via PDS service-proxying (the `atproto-proxy` header), built on an
  authenticated atproto `Agent`/session.

It uses the atproto libraries directly (`@atproto/xrpc`, `@atproto/xrpc-server`,
`@atproto/identity`, `@atproto/api`). The handlers take their dependencies by
injection — you pass an `IdResolver` (for JWT key lookup) and a `RecordResolver`
(for fetching referenced records), so you can share a single identity/cache
layer or swap implementations (e.g. fixtures in tests).

It also exports the small pieces both producers and consumers share:

- **records** — `createRecord` / `deleteRecord` / `listRecordsAll` / `resolvePds`,
  the write-and-discover helpers for the records you author (`./records.ts`).
- **auth** — `verifyServiceAuth` (alias of `verifyMarketServiceAuth`): the same
  inter-service-auth JWT verification the handlers use, exposed for *other*
  PDS-service-proxied endpoints (the reference spindle reuses it for its trigger).

Payments are out of scope here on purpose: a `market.accept` carries an opaque
`payload` strongRef and `submitAccept` doesn't care what it is. The
**[`@publicdomainrelay/market-x402`](../market-x402/README.md)** companion library
defines that payload for x402 and the settlement plumbing on both sides; import it
only if you settle with x402.

## Runtimes

- **Deno** — import via the `deno.json` import map (`deno run`/`deno check`
  resolve the `@atproto/*` bare specifiers there).
- **Node** — the runtime code uses only web-standard `Request`/`Response` plus
  the `@atproto/*` packages (no `Deno.*` / `node:*` APIs). Sources use explicit
  `.ts` import specifiers (the Deno convention), so load them through a
  TS-aware loader (`tsx`, `ts-node` ESM) or a bundler/`tsc` that preserves `.ts`
  resolution. See `package.json` `peerDependencies`.

## Server

```ts
import {
  createRecordResolver,
  createSubmitAcceptHandler,
  createSubmitEventHandler,
  DEFAULT_COMPUTE_EVENT_SERVICE_ID,
  DEFAULT_MARKET_SERVICE_ID,
  type MarketServerDeps,
} from "./mod.ts";
import { IdResolver } from "@atproto/identity";

const idResolver = new IdResolver();
const deps: MarketServerDeps = {
  // host of this service's did:web. Pass a function `(req) => string` instead
  // when the host varies per request — e.g. a multi-tenant spindle deriving
  // `did:web:<owner-subdomain>` from the inbound Host header.
  hostname: new URL(BASE_URL).host,
  idResolver,
  resolve: createRecordResolver(idResolver), // or inject your own
  log: (level, msg, fields) => console.error(level, msg, fields),
};

// Settlement: auth + accept resolution are done for you; you provision and
// return the receipt.
const submitAccept = createSubmitAcceptHandler({
  deps,
  serviceIds: [DEFAULT_MARKET_SERVICE_ID],
  onAccept: async ({ acceptUri, acceptCid, accept, issuerDid, resolve }) => {
    // ...resolve accept->bid->rfp->payload, provision, mint receipt...
    return { body: { id, uri, cid, submitEvent } };
    // Throw to surface an error through your framework's error handler;
    // or return { status, body } for an explicit XRPC error envelope.
  },
});

// Lifecycle events: routed by serviceId -> payload NSID.
const submitEvent = createSubmitEventHandler({
  deps,
  serviceIds: [DEFAULT_COMPUTE_EVENT_SERVICE_ID],
  callbacks: {
    [DEFAULT_COMPUTE_EVENT_SERVICE_ID]: {
      "com.publicdomainrelay.temp.compute.events.vm.delete": async ({ event, issuerDid, resolve }) => {
        // event is the resolved market.event; resolve(event.payload) for the
        // domain payload. Return { ok: true } (default) or { status, body }.
      },
    },
  },
  // background: true  // fire-and-forget the callback, respond 200 immediately
});
```

Mount them with whatever serves web `Request`s. With `Deno.serve` you can route
directly; with Hono, adapt via the raw request:

```ts
app.post(`/xrpc/${SUBMIT_ACCEPT_NSID}`, (c) => submitAccept(c.req.raw));
app.post(`/xrpc/${SUBMIT_EVENT_NSID}`, (c) => submitEvent(c.req.raw));
```

### Callback return values

A callback may return:

- nothing → `200 { ok: true }`
- `{ body }` → `200 body`
- `{ status, body }` → `status body` (use for XRPC error envelopes like
  `{ error: "Forbidden", message }`)
- *throw* → propagates to the host framework's error handler unchanged

## Client

```ts
import { createMarketClient } from "./mod.ts";

// Pass an authenticated atproto handler (a CredentialSession, an Agent, or
// anything @atproto/xrpc's XrpcClient accepts).
const market = createMarketClient(session);

// `target` is the counterparty's service DID ref, used as the atproto-proxy
// header; the caller's PDS mints the inter-service auth token.
await market.submitRfp("did:web:bidder.example#pdr_temp_market", { rfpUri, rfpCid });
await market.submitBid(rfp.submitBid!, { uri, cid, record: bidRecord });
const receipt = await market.submitAccept(bid.submitAccept!, { acceptUri, acceptCid });
await market.submitEvent(receipt.submitEvent, { uri, cid, record: eventRecord });
```

## Reference usage

`src/typescript/bidder/main.ts` is the reference consumer: it injects its own
`resolveAs` as the `RecordResolver` (preserving its record-version guard),
serves the four procedures through these handlers, and uses `MarketClient` for
the outbound `submitBid` call.
