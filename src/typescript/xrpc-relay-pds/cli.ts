/**
 * cli.ts — CLI entry point for the xrpc-relay-pds requester.
 *
 * Starts a PDS, registers with plc.directory, connects to the relay, and runs
 * the compute-contract flow.  Drops into an SSH session when the VM comes up.
 *
 * Run:
 *   deno run -A cli.ts [--vm-name my-vm] [--bid-window-sec 30] [--no-delete] [--exec bash]
 */

import { createRequesterPDS, runComputeContract } from "./server.ts";

/** 8 random lowercase hex chars (4 bytes), for a unique default VM name suffix. */
function randomHex8(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Default VM name is `compute-<8 hex>` when --vm-name is not passed, so repeated
// runs get distinct names; an explicit --vm-name is used verbatim.
const vmName = (() => { const i = Deno.args.indexOf("--vm-name"); return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : `compute-${randomHex8()}`; })();
const bidWindowSec = (() => { const i = Deno.args.indexOf("--bid-window-sec"); return i >= 0 ? parseInt(Deno.args[i + 1] ?? "30", 10) : 30; })();
const noDelete = Deno.args.includes("--no-delete");
const execProgram = (() => { const i = Deno.args.indexOf("--exec"); return i >= 0 ? Deno.args[i + 1] ?? "bash" : "bash"; })();
const vmReadyTimeoutSec = (() => { const i = Deno.args.indexOf("--vm-ready-timeout-sec"); return i >= 0 ? parseInt(Deno.args[i + 1] ?? "300", 10) : 300; })();

const pds = await createRequesterPDS();

// Wait for relay registration so proxyRef is set before the flow runs.
const { proxyRef, subdomain } = await pds.relayReady;
pds.proxyRef = proxyRef;
pds.relaySubdomain = subdomain;

await runComputeContract(pds, {
  vmName,
  bidWindowSec,
  skipSsh: false,
  noDelete,
  execProgram,
  vmReadyTimeoutSec,
});
