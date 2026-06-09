// TypeScript types for the x402 payment lexicons.
// Shapes mirror the JSON files in ./lexicons/.

import type { StrongRef } from "../lexicons-market/types.ts";

/** com.publicdomainrelay.temp.market.bids.x402 */
export type BidsX402 = {
  $type?: string;
  cost: unknown;
  currency: string;
  frequency: string;
  prepay: boolean;
  url: string;
};

/** com.publicdomainrelay.temp.market.accepts.x402 */
export type AcceptsX402 = {
  $type?: string;
  bid: StrongRef;
  payload?: StrongRef;
};

/** com.publicdomainrelay.temp.market.receipts.x402 */
export type ReceiptsX402 = {
  $type?: string;
  accept: StrongRef;
};
