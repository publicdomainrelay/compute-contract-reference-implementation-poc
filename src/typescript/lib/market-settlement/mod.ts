// @publicdomainrelay/market-settlement — pluggable settlement layer for the
// com.publicdomainrelay.temp.market.* bidder protocol.
//
// A `Settlement` binds a market.accept to a concrete payment (or no-cost grant)
// mechanism. The provisioning logic in the bidder never branches on which is
// wired in — it calls `settlement.verifyAcceptPayload` and `settlement.createBidPayload`
// through this interface.
//
//   createFreeSettlement  — no payment; mints a bids.free payload
//   createX402Settlement  — x402 payment gate; mints a bids.x402 payload

export * from "./settlement.ts";
export * from "./bids_free.ts";
export * from "./bids_x402.ts";
