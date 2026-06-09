// Example: a minimal market receiver.
//
// Stands up the four `submitRfp` / `submitBid` / `submitAccept` / `submitEvent`
// procedures on `Deno.serve`, wiring the handler factories to a default
// `RecordResolver`. The handlers do the boilerplate every receiver shares (parse
// the body, verify the inter-service auth JWT, require the token issuer to author
// the referenced record, resolve the strongRef'd record); the callbacks below are
// where your domain logic goes.
//
// Run (from this directory):
//   deno run --allow-net --allow-env server.ts
//
// This example is deliberately settlement-agnostic — it treats `accept.payload`
// as opaque. To actually verify payment/grant before provisioning, call
// `verifyX402Payment` (from @publicdomainrelay/market-x402) or `verifyFreeGrant`
// (from @publicdomainrelay/market-free) at the marked spot in `onAccept`.

import { IdResolver } from "@atproto/identity";
import {
  createRecordResolver,
  createSubmitAcceptHandler,
  createSubmitEventHandler,
  createSubmitRfpHandler,
  DEFAULT_COMPUTE_EVENT_SERVICE_ID,
  DEFAULT_MARKET_SERVICE_ID,
  type MarketServerDeps,
  SUBMIT_ACCEPT_NSID,
  SUBMIT_EVENT_NSID,
  SUBMIT_RFP_NSID,
} from "../mod.ts";

// The core library is compute-agnostic; event payload NSIDs come from the
// compute lexicons. Inlined here so this example stays dependency-light.
const VM_DELETE_NSID = "com.publicdomainrelay.temp.compute.events.vm.delete";

const BASE_URL = Deno.env.get("BASE_URL") ?? "https://bidder.example";

const idResolver = new IdResolver();
const deps: MarketServerDeps = {
  // Host of this service's did:web. Pass a `(req) => string` instead when the
  // host varies per request (e.g. a multi-tenant deployment keyed on Host).
  hostname: new URL(BASE_URL).host,
  idResolver,
  // Inject your own resolver to share a cache or enforce a record-version guard;
  // `createRecordResolver` is the batteries-included default.
  resolve: createRecordResolver(idResolver),
  log: (level, msg, fields) => console.error(level, msg, fields ?? {}),
};

// submitRfp: routed by serviceId -> RFP payload NSID. Reply with a bid (or
// nothing to ignore the RFP).
const submitRfp = createSubmitRfpHandler({
  deps,
  callbacks: {
    [DEFAULT_MARKET_SERVICE_ID]: {
      "com.publicdomainrelay.temp.compute.vm": async ({ rfpUri, rfp }) => {
        console.error("RFP for a VM:", rfpUri, "payload:", rfp.payload?.uri);
        // ...mint a market.bid (+ its bids.x402/bids.free payload) and submit it
        // back via MarketClient.submitBid(rfp.submitBid, …); see examples/client.ts.
        return { body: { ok: true } };
      },
    },
  },
});

// submitAccept: settle the contract and return a strongRef to the receipt you
// mint, plus the service ref the caller should send lifecycle events to.
const submitAccept = createSubmitAcceptHandler({
  deps,
  serviceIds: [DEFAULT_MARKET_SERVICE_ID],
  onAccept: async ({ acceptUri, accept }) => {
    // 1. verify settlement proof here, e.g.:
    //    await verifyX402Payment({ payment: accept.payload, resolve, bidderDid });
    //    await verifyFreeGrant({ payment: accept.payload, resolve, bidderDid });
    // 2. resolve accept->bid->rfp->vm, provision, mint a market.receipt.
    console.error("settling accept:", acceptUri, "payload:", accept.payload?.uri);
    const submitEvent = `did:web:${new URL(BASE_URL).host}#${DEFAULT_COMPUTE_EVENT_SERVICE_ID}`;
    return { body: { id: "<rkey>", uri: "<receipt-uri>", cid: "<receipt-cid>", submitEvent } };
  },
});

// submitEvent: routed by serviceId -> event payload NSID.
const submitEvent = createSubmitEventHandler({
  deps,
  callbacks: {
    [DEFAULT_COMPUTE_EVENT_SERVICE_ID]: {
      [VM_DELETE_NSID]: async ({ event }) => {
        // Tear down the resource tracked for event.receipt. See the compute
        // library for a ready-made vm.delete handler (examples/vmDelete.ts).
        console.error("vm.delete for receipt:", event.receipt.uri);
        return { body: { ok: true } };
      },
    },
  },
  // background: true,  // respond 200 immediately, run teardown fire-and-forget
});

Deno.serve((req) => {
  const { pathname } = new URL(req.url);
  if (req.method === "POST") {
    if (pathname === `/xrpc/${SUBMIT_RFP_NSID}`) return submitRfp(req);
    if (pathname === `/xrpc/${SUBMIT_ACCEPT_NSID}`) return submitAccept(req);
    if (pathname === `/xrpc/${SUBMIT_EVENT_NSID}`) return submitEvent(req);
  }
  return new Response("not found", { status: 404 });
});
