import { createSignedRecord, type StrongRef } from "@publicdomainrelay/market";
import { BIDS_FREE_NSID } from "@publicdomainrelay/market-free";
import { type Settlement, type SettlementCtx } from "./settlement.ts";

/** Free settlement — no payment, no receipt endpoint, just mint the bid record. */
export function createFreeSettlement(ctx: SettlementCtx): Settlement {
  const { getAgent, getSigner } = ctx;

  return {
    mode: "free",
    bidPayloadNsid: BIDS_FREE_NSID,

    receiptUrl: (_reqUrl) => "",

    createBidPayload: (_receiptUrl, _nowIso): Promise<StrongRef> =>
      createSignedRecord(getAgent(), BIDS_FREE_NSID, {
        $type: BIDS_FREE_NSID,
        reason: "provided at no cost",
      }, getSigner()),

    verifyAcceptPayload: async (_payment) => {
      // Free bids have no receipt to verify.
    },

    bidsFactoryOptions: () => ({}),
  };
}
