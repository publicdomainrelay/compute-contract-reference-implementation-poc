// @publicdomainrelay/market — helpers for the com.publicdomainrelay.temp.market.*
// lexicons and their submitRfp / submitBid / submitAccept / submitEvent XRPCs.
//
// Two halves:
//   - server: framework-agnostic `(Request) => Promise<Response>` handler
//     factories that verify inter-service auth, resolve strongRef'd records, and
//     dispatch to your callbacks (submitEvent routes by serviceId -> payload NSID).
//   - client: a MarketClient that calls those procedures on a counterparty via
//     PDS service-proxying (the atproto-proxy header), built on an Agent/session.
//
// Runs on Deno (see deno.json import map) and Node (see package.json).

export * from "./types.ts";
export * from "@publicdomainrelay/lexicons";
export * from "./attest.ts";
export * from "./resolve.ts";
export * from "./records.ts";
export * from "./signing.ts";
export * from "./contract.ts";
export * from "./auth.ts";
export * from "./egress.ts";
export * from "./server.ts";
export * from "./client.ts";
export * from "./registry.ts";
export * from "./discovery.ts";
export * from "./bid.ts";
