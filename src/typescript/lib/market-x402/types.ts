// Wire shapes for the x402 payment records. Loose/structural, matching the
// convention in @publicdomainrelay/market — strict validation is the caller's
// or the XrpcClient's job.

import type { StrongRef } from "../market/mod.ts";

/**
 * com.publicdomainrelay.temp.market.bids.x402 — the payment terms a bidder
 * advertises (used as the bid's payload). `url` is the x402 payment endpoint the
 * buyer GETs to settle and obtain a receipts.x402 proof-of-payment.
 */
export type BidsX402 = {
  $type?: string;
  cost: unknown;
  currency: string;
  frequency: string;
  prepay: boolean;
  url: string;
};

/**
 * com.publicdomainrelay.temp.market.accepts.x402 — a buyer's acceptance of a
 * bid's payment terms. `bid` refs the market.bid; `payload` (optional) refs the
 * bid's payload that was paid against.
 */
export type AcceptsX402 = {
  $type?: string;
  bid: StrongRef;
  payload?: StrongRef;
};

/**
 * com.publicdomainrelay.temp.market.receipts.x402 — the bidder's proof of
 * payment, minted after payment clears. `accept` refs the accepts.x402 that was
 * paid against. The strongRef to this record becomes the market.accept payload.
 */
export type ReceiptsX402 = {
  $type?: string;
  accept: StrongRef;
};
