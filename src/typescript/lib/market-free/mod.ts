// @publicdomainrelay/market-free — the free (no-cost) settlement layer for the
// com.publicdomainrelay.temp.market.* protocol.
//
// The no-money twin of @publicdomainrelay/market-x402. The core library knows
// nothing about settlement (a market.accept just carries an opaque `payload`
// strongRef); this library defines what that payload is when a bidder offers
// compute for free, and the plumbing on both sides. Importing it is optional —
// a deployment that only ever charges never pulls it in.
//
//   buyer:  settleFreeGrant   -> a receipts.free strongRef for market.accept
//   seller: mintGrantForAccepts, verifyFreeGrant, parseGrantPath
//
// Runs on Deno (see deno.json import map) and Node (see package.json).

export * from "./nsids.ts";
export * from "./types.ts";
export * from "./client.ts";
export * from "./server.ts";
