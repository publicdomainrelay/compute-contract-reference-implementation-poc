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

import { Agent, CredentialSession } from "@atproto/api";
import { createMarketClient } from "../mod.ts";

const session = new CredentialSession(new URL(Deno.env.get("ATPROTO_PDS") ?? "https://bsky.social"));
await session.login({
  identifier: Deno.env.get("ATPROTO_HANDLE")!,
  password: Deno.env.get("ATPROTO_PASSWORD")!,
});

// A signer-bound client signs + writes + forwards records for you: the submit
// methods take *unsigned* bodies. Pass the agent whose repo records are written
// to; the signer is resolved automatically (here from ATTESTATION_PRIVATE_KEY_HEX,
// else a generated ephemeral key). For a stable, published identity pass an
// explicit `signer` or `issuer`. For ref-only calls (submitRfp/submitAccept) you
// can omit `agent` entirely.
const market = createMarketClient(session, {
  agent: new Agent(session),
  privateKeyHex: Deno.env.get("ATTESTATION_PRIVATE_KEY_HEX"),
});

const bidderMarketRef = "did:web:bidder.example#pdr_temp_market";
const rfp = { uri: "at://…/rfp/1", cid: "bafy…" };

// 1. Requester asks a bidder to bid on an RFP.
await market.submitRfp(bidderMarketRef, { rfpUri: rfp.uri, rfpCid: rfp.cid });

// 2. Bidder submits a bid back to the RFP issuer (rfp.submitBid ref). Pass the
//    *unsigned* bid body — the client signs it, writes it to your repo, and
//    forwards the attested copy. There is no API that accepts an unsigned body.
const { ref: bidRef, ok } = await market.submitBid("did:web:requester.example#pdr_temp_market", {
  $type: "com.publicdomainrelay.temp.market.bid",
  /* …the rest of the bid record's fields… */
});
console.error("bid created:", bidRef.uri, "forwarded:", ok);

// 3. Requester settles by accepting the winning bid (bid.submitAccept ref). The
//    accept's `payload` is the receipt from your settlement layer — see the
//    market-x402 / market-free examples.
const receipt = await market.submitAccept(bidderMarketRef, {
  acceptUri: "at://…/accept/1",
  acceptCid: "bafy…",
});

// 4. Later, report a lifecycle event against that receipt (receipt.submitEvent).
//    Like the bid, you pass the unsigned event body and the client signs it.
await market.submitEvent(receipt.submitEvent, {
  $type: "com.publicdomainrelay.temp.market.event",
  /* …the rest of the event record's fields… */
});

console.error("contract settled; receipt:", receipt.uri);
