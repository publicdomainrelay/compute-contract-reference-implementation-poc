// CLI: submit an RFP to a target service via PDS service-proxying.
//
// Usage:
//   deno run --allow-net --allow-env --allow-read --allow-write main.ts \
//     --submitRfp did:web:example.com#serviceId
//
//  deno run -A   main.ts   --submitRfp did:web:bob-bid-0001--johnandersen777-bsky-social.fedproxy.com#pdr_temp_market --submitBid "$(cat ../../xrpc-relay/client.ndjson | grep proxyRef | tail -n 1 | jq -r .proxyRef)#pdr_temp_market" 2>&1 | jq --unbuffered -rR '(fromjson? // .)'
//
// Env vars:
//   ATPROTO_PDS_URL     PDS base URL (default: https://bsky.social)
//   ATPROTO_HANDLE      ATProto handle  (required)
//   ATPROTO_PASSWORD    ATProto password (required)
//   ATTESTATION_KEY_HEX Private key hex for badge.blue signing (auto-generated if absent)
//   KEYPAIR_STATE_FILE  Path to persist keypair + did:plc (default: ./keypair-state.json)
//   VM_CPUS             (default: 2)
//   VM_MEM              (default: 4G)
//   VM_DISK             (default: 40G)
//   VM_NETWORK          (default: 500G)
//   VM_LOCATION_COUNTRY (default: USA)
//   VM_LOCATION_REGION  (default: west)
//   VM_ROLE             (default: compute)

import { Agent, CredentialSession } from "@atproto/api";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  createMarketClient,
  createRecord,
  createSignedRecord,
  loadOrGenerateKeypair,
  COMPUTE_VM_NSID,
  RFP_NSID,
} from "@publicdomainrelay/market";
import {
  createGenesisOp,
  loadKeypairState,
  saveKeypairState,
  PlcClient,
} from "@publicdomainrelay/did-plc";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): { submitRfp: string, submitBid: string } {
  let submitRfp = "";
  let submitBid = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--submitRfp" && args[i + 1]) {
      submitRfp = args[++i];
    }
    if (args[i] === "--submitBid" && args[i + 1]) {
      submitBid = args[++i];
    }
  }
  if (!submitRfp || !submitBid) {
    console.error("Usage: main.ts --submitRfp did:web:<host>#<serviceId> --submitBid did:web:<host>#<serviceId>");
    Deno.exit(1);
  }
  return { submitRfp, submitBid };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Keypair + did:plc identity
// ---------------------------------------------------------------------------

const { submitRfp, submitBid } = parseArgs(Deno.args);

const pdsUrl = Deno.env.get("ATPROTO_PDS_URL") ?? "https://bsky.social";
const stateFile = Deno.env.get("KEYPAIR_STATE_FILE") ?? "./keypair-state.json";

let didPlc: string;
let keypair: Awaited<ReturnType<typeof loadOrGenerateKeypair>>;

const state = await loadKeypairState(stateFile);

if (state) {
  keypair = await loadOrGenerateKeypair(state.privateKeyHex);
  didPlc = state.didPlc;
  console.error(JSON.stringify({ level: "info", msg: "loaded keypair state", didPlc, stateFile }));
} else {
  // Load from env or generate fresh.
  const envKeyHex = Deno.env.get("ATTESTATION_KEY_HEX");
  keypair = await loadOrGenerateKeypair(envKeyHex);

  const plcPdsUrl = "https://pds-0001.nahdig.com";

  // Reconstruct Secp256k1Keypair so we can sign the genesis op.
  const kp = await Secp256k1Keypair.import(keypair.privateKey.bytes);

  const { did, op } = await createGenesisOp({
    rotationKeys: [keypair.did()],
    verificationMethods: { atproto: keypair.did() },
    services: {
      atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: plcPdsUrl },
    },
    sign: (bytes) => kp.sign(bytes),
  });

  const plcClient = new PlcClient();
  await plcClient.submitOp(did, op);

  didPlc = did;
  const privateKeyHex = bytesToHex(keypair.privateKey.bytes);
  await saveKeypairState(stateFile, {
    privateKeyHex,
    didPlc,
    createdAt: new Date().toISOString(),
  });
  console.error(JSON.stringify({ level: "info", msg: "created did:plc", didPlc, stateFile }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const handle = Deno.env.get("ATPROTO_HANDLE");
const password = Deno.env.get("ATPROTO_PASSWORD");

if (!handle || !password) {
  console.error("ATPROTO_HANDLE and ATPROTO_PASSWORD must be set");
  Deno.exit(1);
}

const session = new CredentialSession(new URL(pdsUrl));
await session.login({ identifier: handle, password });
const agent = new Agent(session);

const signer = { keypair, issuer: didPlc };

const marketClient = createMarketClient(session, { agent, signer });

// Build compute.vm record
const vmRecord = {
  $type: COMPUTE_VM_NSID,
  cpus: Number(Deno.env.get("VM_CPUS") ?? 2),
  mem: Deno.env.get("VM_MEM") ?? "4G",
  disk: Deno.env.get("VM_DISK") ?? "40G",
  network: Deno.env.get("VM_NETWORK") ?? "500G",
  role: Deno.env.get("VM_ROLE") ?? "compute",
  location: {
    country: Deno.env.get("VM_LOCATION_COUNTRY") ?? "USA",
    region: Deno.env.get("VM_LOCATION_REGION") ?? "west",
  },
  createdAt: new Date().toISOString(),
};

const vmRef = await createRecord(agent, COMPUTE_VM_NSID, vmRecord);
console.error(JSON.stringify({ level: "info", msg: "compute.vm created", uri: vmRef.uri }));

// Build market.rfp record wrapping the VM
const rfpRecord: Record<string, unknown> = {
  $type: RFP_NSID,
  domain: "compute",
  payload: vmRef,
  submitBid: submitBid,
  createdAt: new Date().toISOString(),
};

const rfpRef = await createSignedRecord(agent, RFP_NSID, rfpRecord, signer);
console.error(JSON.stringify({ level: "info", msg: "market.rfp created", uri: rfpRef.uri }));

// Call submitRfp on the target via PDS service-proxying
const result = await marketClient.submitRfp(submitRfp, {
  rfpUri: rfpRef.uri,
  rfpCid: rfpRef.cid,
});

console.log(JSON.stringify(result));
