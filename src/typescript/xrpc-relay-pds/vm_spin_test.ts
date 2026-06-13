/**
 * vm_spin_test.ts — integration test for the compute-contract market flow.
 *
 * Starts a requester PDS and a bidder PDS on random ports, both registering
 * with the real plc.directory and xrpc.fedproxy.com relay. Runs the full
 * contract flow: RFP → bid → accept → receipt → vm.delete.
 *
 * Run:
 *   deno run -A vm_spin_test.ts
 *
 * Requires:
 *   - Network access to plc.directory and xrpc.fedproxy.com
 *   - websocat not needed (skipSsh = true)
 */

import { createRequesterPDS, runComputeContract } from "./server.ts";
import { createEphemeralBidder } from "@publicdomainrelay/hono-factory-ephemeral-compute-bidder";

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

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("=== vm_spin_test ===\n");

  // ── 1. Start requester PDS ─────────────────────────────────────
  console.log("[1] Starting requester PDS…");
  const requester = await createRequesterPDS({
    port: 0,        // OS-allocated random port
    label: "test-requester",
  });
  const reqInfo = await requester.relayReady;
  requester.proxyRef = reqInfo.proxyRef;
  requester.relaySubdomain = reqInfo.subdomain;
  console.log(`    Requester DID: ${requester.did}`);
  console.log(`    Relay subdomain: ${reqInfo.subdomain}`);
  assert(typeof requester.did === "string" && requester.did.startsWith("did:plc:"), "requester has did:plc");
  assert(typeof reqInfo.proxyRef === "string" && reqInfo.proxyRef.length > 0, "requester relay registered");

  // ── 2. Start bidder PDS ────────────────────────────────────────
  console.log("[2] Starting bidder PDS…");
  const bidder = await createEphemeralBidder({
    port: 0,
    label: "test-bidder",
  });
  const bidInfo = await bidder.ready; // waits for relay + offering creation
  bidder.proxyRef = bidInfo.proxyRef;
  bidder.relaySubdomain = bidInfo.subdomain;
  console.log(`    Bidder DID: ${bidder.did}`);
  console.log(`    Relay subdomain: ${bidInfo.subdomain}`);
  assert(typeof bidder.did === "string" && bidder.did.startsWith("did:plc:"), "bidder has did:plc");
  assert(typeof bidInfo.proxyRef === "string" && bidInfo.proxyRef.length > 0, "bidder relay registered");

  // ── 3. Run compute contract flow ───────────────────────────────
  console.log("[3] Running compute contract flow…");
  const result = await runComputeContract(requester, {
    vmName: "test-vm",
    bidWindowSec: 10,          // 10s should be enough for bidder to respond
    skipSsh: true,             // no VM, no SSH
    noDelete: false,           // should send vm.delete event
    extraBidderDids: [bidder.did],
  });

  console.log("\n    Contract result:");
  console.log(`    ${JSON.stringify(result, null, 2)}`);

  // Assertions on the contract flow.
  assert(result.event === "compute_request_complete", "contract completed");
  assert(typeof result.vmUri === "string", "vmUri present");
  assert(typeof result.rfpUri === "string", "rfpUri present");
  assert(typeof result.bidUri === "string", "bidUri present (bidder responded)");
  assert(typeof result.acceptUri === "string", "acceptUri present");
  assert(typeof result.receiptUri === "string", "receiptUri present");
  assert(typeof result.submitEventRef === "string", "submitEventRef present (bidder's submitEvent endpoint)");

  const bidCount = result.bids as number;
  assert(bidCount > 0, `at least one bid received (got ${bidCount})`);

  // ── 4. Verify bidder tracking was cleaned up ───────────────────
  console.log("\n[4] Checking bidder contract tracking…");
  assertEq(bidder.activeContracts.size, 0, "bidder has no active contracts after vm.delete");

  // ── 5. Stop both servers ───────────────────────────────────────
  console.log("\n[5] Stopping servers…");
  requester.stop();
  bidder.stop();
  console.log("    Servers stopped.");

  // ── summary ────────────────────────────────────────────────────
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) Deno.exit(1);
}

await main();
