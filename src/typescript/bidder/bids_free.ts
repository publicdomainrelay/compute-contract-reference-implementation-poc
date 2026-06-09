// Free settlement: settle a market.accept by *granting* compute at no cost.
//
// The no-payment twin of ./bids_x402.ts. Implements the same `Settlement`
// interface (./settlement.ts) on top of @publicdomainrelay/market-free. Because
// there is no payment there is no @x402/* middleware and no facilitator/CDP env
// — the receipt endpoint is open and mints a proof-of-grant on request.
//
//   GET /free/receipt/<accepts.free-at-uri>/<cid>
//
// The buyer mints an accepts.free, GETs this (un-gated) endpoint, and the bidder
// mints + returns a receipts.free proof-of-grant used as the market.accept
// payload. Provisioning still happens in submitAccept (see main.ts); this only
// records that the bidder agreed to provide the VM for free.

import type { Hono } from "hono";
import { createRecord, type StrongRef } from "../lib/market/mod.ts";
import {
  BIDS_FREE_NSID,
  mintGrantForAccepts,
  parseGrantPath,
  verifyFreeGrant,
} from "../lib/market-free/mod.ts";
import { receiptUrlFor, type Settlement, type SettlementCtx } from "./settlement.ts";

const PATH = "free/receipt";

/** Build the free (no-cost) settlement. Needs no extra env. */
export function createFreeSettlement(ctx: SettlementCtx): Settlement {
  const { getAgent, resolve, log, baseUrl } = ctx;

  return {
    mode: "free",
    bidPayloadNsid: BIDS_FREE_NSID,

    receiptUrl: (reqUrl) => receiptUrlFor(baseUrl, reqUrl, PATH),

    createBidPayload: (receiptUrl, nowIso): Promise<StrongRef> =>
      createRecord(getAgent(), BIDS_FREE_NSID, {
        $type: BIDS_FREE_NSID,
        url: receiptUrl,
        reason: "provided at no cost",
        createdAt: nowIso,
      }),

    verifyAcceptPayload: async (payment) => {
      await verifyFreeGrant({ payment, resolve, bidderDid: getAgent().assertDid });
      log("info", "free grant verified", { receiptsFree: payment?.uri });
    },

    mount: (app: Hono) => {
      // No payment middleware — the offer is free, so the endpoint is open.
      app.get(`/${PATH}/*`, async (c) => {
        const { acceptsUri, acceptsCid } = parseGrantPath(c.req.path, `${PATH}/`);
        log("info", "free receipt requested", { acceptsUri, acceptsCid });
        const ref = await mintGrantForAccepts({ agent: getAgent(), resolve, acceptsUri, acceptsCid });
        log("info", "receipts.free minted", { uri: ref.uri, cid: ref.cid, acceptsUri });
        return c.json({ uri: ref.uri, cid: ref.cid });
      });
    },
  };
}
