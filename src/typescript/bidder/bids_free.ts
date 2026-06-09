import type { Hono } from "hono";
import { createRecord, type StrongRef } from "../lib/market/mod.ts";
import { BIDS_FREE_NSID } from "../lib/market-free/mod.ts";
import { type Settlement, type SettlementCtx } from "./settlement.ts";

/** Free settlement — no payment, no receipt endpoint, just mint the bid record. */
export function createFreeSettlement(ctx: SettlementCtx): Settlement {
  const { getAgent } = ctx;

  return {
    mode: "free",
    bidPayloadNsid: BIDS_FREE_NSID,

    receiptUrl: (_reqUrl) => "",

    createBidPayload: (_receiptUrl, _nowIso): Promise<StrongRef> =>
      createRecord(getAgent(), BIDS_FREE_NSID, {
        $type: BIDS_FREE_NSID,
        reason: "provided at no cost",
      }),

    verifyAcceptPayload: async (_payment) => {
      // Free bids have no receipt to verify.
    },

    mount: (_app: Hono) => {
      // No receipt endpoint needed for free bids.
    },
  };
}
