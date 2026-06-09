// TypeScript types for the free (no-cost) settlement lexicons.
// Shapes mirror the JSON files in ./lexicons/.

import type { StrongRef } from "../lexicons-market/types.ts";

/** com.publicdomainrelay.temp.market.bids.free */
export type BidsFree = {
  $type?: string;
  /** Grant endpoint the buyer GETs to obtain a receipts.free. */
  url: string;
  /** Optional human-readable reason the compute is offered for free. */
  reason?: string;
};

/** com.publicdomainrelay.temp.market.accepts.free */
export type AcceptsFree = {
  $type?: string;
  bid: StrongRef;
  payload?: StrongRef;
};

/** com.publicdomainrelay.temp.market.receipts.free */
export type ReceiptsFree = {
  $type?: string;
  accept: StrongRef;
};
