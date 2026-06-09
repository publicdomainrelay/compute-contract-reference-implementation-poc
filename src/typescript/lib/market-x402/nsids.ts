// NSIDs for the x402 payment layer that rides on top of the core market.*
// protocol. These are the three records that carry a payment from terms to
// proof:
//   bids.x402     payment terms a bidder advertises as its market.bid payload
//   accepts.x402  a buyer's acceptance of those terms (refs the bid)
//   receipts.x402 the bidder's proof-of-payment, minted once payment clears
//                 (refs the accepts.x402); becomes the market.accept payload.

export const BIDS_X402_NSID = "com.publicdomainrelay.temp.market.bids.x402";
export const ACCEPTS_X402_NSID = "com.publicdomainrelay.temp.market.accepts.x402";
export const RECEIPTS_X402_NSID = "com.publicdomainrelay.temp.market.receipts.x402";
