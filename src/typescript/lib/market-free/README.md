# @publicdomainrelay/market-free

The **free** (no-cost) settlement layer for the
`com.publicdomainrelay.temp.market.*` protocol — the no-money twin of
[`@publicdomainrelay/market-x402`](../market-x402/README.md) and a companion to
[`@publicdomainrelay/market`](../market/README.md).

The core market library is settlement-agnostic: a `market.accept` carries an
opaque `payload` strongRef and `submitAccept` doesn't care what it points at.
This library is what you wire in when a bidder offers compute **for free**. There
is no payment — but settlement still flows through a receipt, so the bidder keeps
a verifiable, self-authored record that it granted the resource. That gives
`submitAccept` the exact same evidence shape it already checks for paid bids.

It mirrors `market-x402` field for field, minus the money: no facilitator, no
middleware, no paying fetch. If you understand one, you understand both.

## The three records

| NSID | Who writes it | Meaning |
|------|---------------|---------|
| `…market.bids.free` | bidder | free terms (`url`, optional `reason`), used as the bid payload |
| `…market.accepts.free` | buyer | acceptance of those terms; refs the bid |
| `…market.receipts.free` | bidder | proof of grant; refs the accepts.free, becomes the `market.accept` payload |

## Buyer

```ts
import { settleFreeGrant } from "../lib/market-free/mod.ts";

// winningBid: strongRef to the market.bid; bidPayload: strongRef to its bids.free
const proofOfGrant = await settleFreeGrant({
  agent,                       // authenticated buyer agent
  bid: winningBid,
  bidPayload,
  url: bidsFree.url,           // untrusted — egress-guarded before the GET
  egress: { blockPrivate: true },
});
// use proofOfGrant as the market.accept payload, then call market.submitAccept
```

`settleFreeGrant` mints the `accepts.free`, GETs `<url>/<acceptsUri>/<acceptsCid>`,
and returns the `receipts.free` strongRef the endpoint hands back. It throws on an
unsafe URL, a failed request, or a malformed response.

## Seller

```ts
import {
  FreeGrantError,
  mintGrantForAccepts,
  parseGrantPath,
  verifyFreeGrant,
} from "../lib/market-free/mod.ts";

// In the (un-gated) grant GET handler:
const { acceptsUri, acceptsCid } = parseGrantPath(reqPath, "free/receipt/");
const receiptRef = await mintGrantForAccepts({ agent, resolve, acceptsUri, acceptsCid });
return Response.json({ uri: receiptRef.uri, cid: receiptRef.cid });

// Inside the market.submitAccept onAccept callback, before provisioning:
await verifyFreeGrant({ payment: accept.payload, resolve, bidderDid: agent.assertDid });
// throws FreeGrantError(400, …) if missing / wrong type / not authored by us
```

`resolve` is a `RecordResolver` from `@publicdomainrelay/market` (inject your own
or use `createRecordResolver(idResolver)`).

## How it differs from `market-x402`

The shapes are identical; the difference is what the GET endpoint requires and
what the receipt proves:

| | `market-x402` | `market-free` |
|---|---|---|
| GET endpoint | payment-gated (your `@x402/*` middleware) | open, no gate |
| receipt means | proof of **payment** | proof of **grant** |
| buyer `fetch` | pass an x402-paying fetch to pay | plain `fetch` |
| verify failure | `X402PaymentError(402, …)` | `FreeGrantError(400, …)` |

Because both produce a receipt the bidder authored and reference from the
`market.accept` payload, a bidder can support either (or pick per deployment)
without changing its `submitAccept` settlement logic.

## Runtimes

Same as the core library: Deno via the `deno.json` import map; Node via a TS-aware
loader or bundler that preserves `.ts` specifiers. Runtime code uses only
web-standard `Request`/`Response`/`fetch` plus `@atproto/*`. In this repo it
imports the core library by relative path (`../market/mod.ts`); published
standalone it would depend on `@publicdomainrelay/market`.
