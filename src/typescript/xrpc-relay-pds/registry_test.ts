/**
 * registry_test.ts — integration test for the market-registry + ephemeral-bidder.
 *
 * Starts a market-registry and an ephemeral bidder on random ports, both
 * registering with the real plc.directory and xrpc.fedproxy.com relay.
 * Verifies: bidder registration → liveness via discovery record → stale
 * removal after bidder stops.
 *
 * Run:
 *   deno run -A registry_test.ts
 *
 * Requires:
 *   - Network access to plc.directory and xrpc.fedproxy.com
 */

import { createMarketRegistry } from "../market-registry/main.ts";
import { createEphemeralBidder } from "../ephemeral-bidder/main.ts";
import { COMPUTE_VM_NSID } from "@publicdomainrelay/lexicons";

// ── helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

function assertEq<T>(got: T, want: T, msg: string): void {
  if (got === want) {
    console.log(`  ✓ ${msg} (${JSON.stringify(want)})`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    failed++;
  }
}

async function poll<T>(
  name: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${name}: timed out after ${timeoutMs}ms`);
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("=== registry_test ===\n");

  // ── 1. Start market-registry ────────────────────────────────────
  console.log("[1] Starting market-registry…");
  const registry = await createMarketRegistry({
    port: 0,                       // OS-allocated random port
    label: "test-registry",
    healthCheckIntervalMs: 5000,   // fast health checks for stale detection
  });
  const regInfo = await registry.ready;
  console.log(`    Registry DID: ${registry.did}`);
  console.log(`    Relay subdomain: ${regInfo.subdomain}`);
  assert(typeof registry.did === "string" && registry.did.startsWith("did:plc:"), "registry has did:plc");
  assert(typeof regInfo.proxyRef === "string" && regInfo.proxyRef.length > 0, "registry relay registered");

  // Verify registry starts with empty index.
  const emptyResult = await registry.store.listBidders({ payloadNsid: COMPUTE_VM_NSID });
  assertEq(emptyResult.bidders.length, 0, "registry starts with zero bidders");

  // ── 2. Start ephemeral bidder ────────────────────────────────────
  console.log("\n[2] Starting ephemeral bidder…");
  const bidder = await createEphemeralBidder({
    port: 0,
    label: "test-ephemeral-bidder",
    registryEndpoint: `${registry.did}#pdr_temp_market`,
    heartbeatIntervalMs: 3000,     // fast updates for liveness test
  });
  const bidInfo = await bidder.ready;
  console.log(`    Bidder DID: ${bidder.did}`);
  console.log(`    Relay subdomain: ${bidInfo.subdomain}`);
  assert(typeof bidder.did === "string" && bidder.did.startsWith("did:plc:"), "bidder has did:plc");
  assert(typeof bidInfo.proxyRef === "string" && bidInfo.proxyRef.length > 0, "bidder relay registered");

  // ── 3. Verify bidder registered with registry ────────────────────
  console.log("\n[3] Waiting for bidder registration…");
  const registered = await poll("registration", async () => {
    const result = await registry.store.listBidders({ payloadNsid: COMPUTE_VM_NSID });
    const found = result.bidders.find((b) => b.bidderDid === bidder.did);
    return found ? result : null;
  }, 15_000);
  assert(registered.bidders.some((b) => b.bidderDid === bidder.did), "bidder appears in registry listBidders");
  assertEq(registered.bidders.length, 1, "exactly one bidder registered");

  // ── 4. Verify bidder discovery record is fresh ──────────────────
  console.log("\n[4] Verifying bidder discovery record…");
  const discovery = await registry.store.fetchDiscovery(bidder.did);
  assert(discovery !== null, "bidder discovery record found");
  if (discovery) {
    const ageMs = Date.now() - new Date(discovery.updatedAt).getTime();
    assert(ageMs < 30_000, `discovery record updatedAt is recent (${Math.round(ageMs / 1000)}s ago)`);
    assert(discovery.appliesTo.includes(COMPUTE_VM_NSID), "discovery record appliesTo includes compute.vm");
    assert(typeof discovery.endpointUrl === "string" && discovery.endpointUrl.length > 0, "discovery record has endpointUrl");
  }

  // ── 5. Verify liveness — bidder survives health check ────────────
  console.log("\n[5] Waiting for health check cycle…");
  await new Promise((r) => setTimeout(r, 6000)); // one full health cycle (5s interval)
  const afterHealth = await registry.store.listBidders({ payloadNsid: COMPUTE_VM_NSID });
  assert(
    afterHealth.bidders.some((b) => b.bidderDid === bidder.did),
    "bidder still in index after health check (discovery record is fresh)",
  );

  // ── 6. Stop bidder ───────────────────────────────────────────────
  console.log("\n[6] Stopping ephemeral bidder…");
  bidder.stop();
  console.log("    Bidder stopped.");

  // ── 7. Wait for stale removal ────────────────────────────────────
  console.log("\n[7] Waiting for registry to remove stale bidder…");
  await poll("stale removal", async () => {
    const result = await registry.store.listBidders({ payloadNsid: COMPUTE_VM_NSID });
    return result.bidders.length === 0 ? result : null;
  }, 25_000);
  const finalResult = await registry.store.listBidders({ payloadNsid: COMPUTE_VM_NSID });
  assertEq(finalResult.bidders.length, 0, "stale bidder removed from index");

  // ── 8. Stop registry ─────────────────────────────────────────────
  console.log("\n[8] Stopping market-registry…");
  registry.stop();
  console.log("    Registry stopped.");

  // ── summary ────────────────────────────────────────────────────
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) Deno.exit(1);
}

await main();
