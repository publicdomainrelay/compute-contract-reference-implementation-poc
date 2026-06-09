// @publicdomainrelay/market-x402 — the x402 payment layer for the
// com.publicdomainrelay.temp.market.* protocol.
//
// A thin companion to @publicdomainrelay/market: the core library knows nothing
// about payment (a market.accept just carries an opaque `payload` strongRef);
// this library defines what that payload is for x402 and the plumbing on both
// sides. Importing it is optional — a deployment that settles contracts some
// other way never pulls it in, and it intentionally does NOT depend on any
// @x402/* / facilitator packages (those stay the consumer's concern).
//
//   buyer:  settleX402Payment  -> a receipts.x402 strongRef for market.accept
//   seller: mintReceiptForAccepts, verifyX402Payment, parseReceiptPath
//
// Runs on Deno (see deno.json import map) and Node (see package.json).

export * from "./nsids.ts";
export * from "./types.ts";
export * from "./egress.ts";
export * from "./client.ts";
export * from "./server.ts";
