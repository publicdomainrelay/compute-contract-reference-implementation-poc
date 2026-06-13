/**
 * ephemeral-bidder — thin wrapper for
 * @publicdomainrelay/hono-factory-ephemeral-compute-bidder
 *
 * Usage:
 *   import { createEphemeralBidder } from "@publicdomainrelay/ephemeral-bidder";
 *   const bidder = await createEphemeralBidder({ port: 0 });
 */

export { createEphemeralBidder } from "@publicdomainrelay/hono-factory-ephemeral-compute-bidder";
export type {
  EphemeralBidderOptions,
  EphemeralBidder,
  ActiveContract,
  ComputeProviderConfig,
} from "@publicdomainrelay/hono-factory-ephemeral-compute-bidder";

// ── standalone entry ──────────────────────────────────────────────────

if (import.meta.main) {
  const { createEphemeralBidder } = await import("@publicdomainrelay/hono-factory-ephemeral-compute-bidder");
  const bidder = await createEphemeralBidder();
  await bidder.ready;
  console.log(JSON.stringify({ event: "bidder_ready", did: bidder.did, proxyRef: bidder.proxyRef }));
}
