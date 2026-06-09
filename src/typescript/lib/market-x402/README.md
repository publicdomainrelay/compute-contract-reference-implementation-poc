# @publicdomainrelay/market-x402

The x402 payment layer for the `com.publicdomainrelay.temp.market.*` protocol —
a companion to [`@publicdomainrelay/market`](../market/README.md).

The core market library is payment-agnostic: a `market.accept` carries an opaque
`payload` strongRef and `submitAccept` doesn't care what it points at. This
library says what that payload is when you settle with **x402**, and provides the
plumbing on both sides. Importing it is optional — a deployment that settles some
other way never pulls it in.

It deliberately has **no dependency on `@x402/*` / facilitator packages**. The
payment gating (middleware, facilitator, scheme) stays your concern; this library
only handles the three atproto records and the verification rules around them.

## The three records

| NSID | Who writes it | Meaning |
|------|---------------|---------|
| `…market.bids.x402` | bidder | payment terms (`cost`, `currency`, `url`, …), used as the bid payload |
| `…market.accepts.x402` | buyer | acceptance of those terms; refs the bid |
| `…market.receipts.x402` | bidder | proof of payment; refs the accepts.x402, becomes the `market.accept` payload |

## Buyer

```ts
import { settleX402Payment } from "../lib/market-x402/mod.ts";

// winningBid: strongRef to the market.bid; bidPayload: strongRef to its bids.x402
const proofOfPayment = await settleX402Payment({
  agent,                       // authenticated buyer agent
  bid: winningBid,
  bidPayload,
  url: bidsX402.url,           // untrusted — egress-guarded before the GET
  egress: { blockPrivate: true },
  // fetch: x402Fetch,         // pass an x402-paying fetch to actually pay
});
// use proofOfPayment as the market.accept payload, then call market.submitAccept
```

`settleX402Payment` mints the `accepts.x402`, GETs
`<url>/<acceptsUri>/<acceptsCid>`, and returns the `receipts.x402` strongRef the
endpoint hands back. It throws on an unsafe URL, a failed request, or a malformed
response.

## Seller

```ts
import {
  mintReceiptForAccepts,
  parseReceiptPath,
  verifyX402Payment,
  X402PaymentError,
} from "../lib/market-x402/mod.ts";

// In the x402-payment-gated GET handler (payment already cleared by middleware):
const { acceptsUri, acceptsCid } = parseReceiptPath(reqPath, "x402/receipt/");
const receiptRef = await mintReceiptForAccepts({ agent, resolve, acceptsUri, acceptsCid });
return Response.json({ uri: receiptRef.uri, cid: receiptRef.cid });

// Inside the market.submitAccept onAccept callback, before provisioning:
await verifyX402Payment({ payment: accept.payload, resolve, bidderDid: agent.assertDid });
// throws X402PaymentError(402, …) if missing / wrong type / not authored by us
```

`resolve` is a `RecordResolver` from `@publicdomainrelay/market` (inject your own
or use `createRecordResolver(idResolver)`).

## Runtimes

Same as the core library: Deno via the `deno.json` import map; Node via a TS-aware
loader or bundler that preserves `.ts` specifiers. Runtime code uses only
web-standard `Request`/`Response`/`fetch` plus `@atproto/*`. In this repo it
imports the core library by relative path (`../market/mod.ts`); published
standalone it would depend on `@publicdomainrelay/market`.
