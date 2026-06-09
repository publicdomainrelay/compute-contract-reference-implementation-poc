// Example: driving the market procedures as a client.
//
// A `MarketClient` is an authenticated XrpcClient plus the embedded market
// lexicons. Every call is routed to the counterparty's service via PDS
// service-proxying — you pass the `did:web:HOST#<service-id>` ref as `target`
// and the caller's own PDS mints the inter-service auth JWT. The four calls
// trace one contract end to end.
//
// Run (from this directory):
//   ATPROTO_PDS=https://bsky.social ATPROTO_HANDLE=you.example ATPROTO_PASSWORD=… \
//     deno run --allow-net --allow-env client.ts

import { CredentialSession } from "@atproto/api";
import { createMarketClient } from "../mod.ts";

const session = new CredentialSession(new URL(Deno.env.get("ATPROTO_PDS") ?? "https://bsky.social"));
await session.login({
  identifier: Deno.env.get("ATPROTO_HANDLE")!,
  password: Deno.env.get("ATPROTO_PASSWORD")!,
});

// Pass any handler @atproto/xrpc accepts: a CredentialSession, an Agent, etc.
const market = createMarketClient(session);

// These refs/records would come from your own repo + the counterparty's
// offering record; they are placeholders so the example type-checks.
const bidderMarketRef = "did:web:bidder.example#pdr_temp_market";
const rfp = { uri: "at://…/rfp/1", cid: "bafy…" };

// 1. Requester asks a bidder to bid on an RFP.
await market.submitRfp(bidderMarketRef, { rfpUri: rfp.uri, rfpCid: rfp.cid });

// 2. Bidder submits a bid back to the RFP issuer (rfp.submitBid ref).
await market.submitBid("did:web:requester.example#pdr_temp_market", {
  uri: "at://…/bid/1",
  cid: "bafy…",
  record: { /* the com.publicdomainrelay.temp.market.bid record */ },
});

// 3. Requester settles by accepting the winning bid (bid.submitAccept ref). The
//    accept's `payload` is the receipt from your settlement layer — see the
//    market-x402 / market-free examples.
const receipt = await market.submitAccept(bidderMarketRef, {
  acceptUri: "at://…/accept/1",
  acceptCid: "bafy…",
});

// 4. Later, report a lifecycle event against that receipt (receipt.submitEvent).
await market.submitEvent(receipt.submitEvent, {
  uri: "at://…/event/1",
  cid: "bafy…",
  record: { /* the com.publicdomainrelay.temp.market.event record */ },
});

console.error("contract settled; receipt:", receipt.uri);
