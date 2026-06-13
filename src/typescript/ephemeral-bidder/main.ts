/**
 * ephemeral-bidder — thin wrapper for
 * @publicdomainrelay/hono-factory-ephemeral-compute-bidder
 *
 * Usage:
 *   import { createEphemeralBidder } from "@publicdomainrelay/ephemeral-bidder";
 *   const bidder = await createEphemeralBidder({
 *     port: 0,
 *     computeProvider: { mode: "local" },
 *   });
 *
 * CLI:
 *   deno run -A main.ts --provider local|digitalocean
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
  // Parse --provider flag before importing (sets COMPUTE_PROVIDER_CLI)
  const args = Deno.args;
  const providerIdx = args.indexOf("--provider");
  if (providerIdx >= 0 && args[providerIdx + 1]) {
    Deno.env.set("COMPUTE_PROVIDER_CLI", args[providerIdx + 1]);
  }
  const pIdx = args.indexOf("-p");
  if (pIdx >= 0 && args[pIdx + 1]) {
    Deno.env.set("COMPUTE_PROVIDER_CLI", args[pIdx + 1]);
  }

  const { createEphemeralBidder } = await import("@publicdomainrelay/hono-factory-ephemeral-compute-bidder");
  const bidder = await createEphemeralBidder();
  const info = await bidder.ready;
  console.log(JSON.stringify({ event: "bidder_ready", did: bidder.did, proxyRef: info.proxyRef }));
}
