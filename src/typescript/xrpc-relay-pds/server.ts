/**
 * xrpc-relay-pds — atproto repo PDS server + relay subscriber
 *
 * On start:
 *   1. Generate/load a secp256k1 keypair
 *   2. Register a did:plc with a PLC directory
 *   3. Mount the repo PDS factory (Hono app)
 *   4. Start the HTTP server (direct access)
 *   5. Connect to the XRPC relay as a subscriber (proxied access via
 *      relay → WebSocket #request → app.fetch())
 *
 * Run:
 *   PORT=8080 deno run -A --watch server.ts
 *
 * Supply a stable signing key via REPO_PRIVATE_KEY_HEX; otherwise a fresh
 * secp256k1 keypair is generated each boot (the DID changes on restart).
 */

import { Secp256k1Keypair } from "@atproto/crypto";
import {
  createRepoFactory,
  MemoryStorage,
  signServiceAuth,
} from "@publicdomainrelay/hono-factory-atproto-repo";
import type { Signer } from "@publicdomainrelay/hono-factory-atproto-repo";
import { PlcClient, createGenesisOp } from "@publicdomainrelay/did-plc";
import { runSubscriber } from "@publicdomainrelay/xrpc-relay";
import { createSubscriberFactory } from "@publicdomainrelay/hono-factory-xrpc-subscriber";

// ── env ──────────────────────────────────────────────────────────────

const PORT = parseInt(Deno.env.get("PORT") ?? "8080");
const PRIVATE_KEY_HEX = Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
const BASE_ORIGIN = Deno.env.get("BASE_ORIGIN") ?? `http://localhost:${PORT}`;
const PLC_DIRECTORY_URL = Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
const DISPATCHER_HOST = Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";

// ── keypair ──────────────────────────────────────────────────────────

const keypair = PRIVATE_KEY_HEX
  ? await Secp256k1Keypair.import(PRIVATE_KEY_HEX)
  : await Secp256k1Keypair.create({ exportable: true });

if (!PRIVATE_KEY_HEX) {
  const exported = await keypair.export();
  const hex = Array.from(exported).map((b) => b.toString(16).padStart(2, "0")).join("");
  console.log(JSON.stringify({
    event: "keypair_generated",
    hint: "set REPO_PRIVATE_KEY_HEX to reuse this identity",
    private_key_hex: hex,
    did_key: keypair.did(),
  }));
}

// ── did:plc registration ─────────────────────────────────────────────

const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });
const signingKeyDid = keypair.did();

const { did, op } = await createGenesisOp({
  rotationKeys: [signingKeyDid],
  verificationMethods: { atproto: signingKeyDid },
  alsoKnownAs: [
    `at://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
  ],
  services: {
    atproto_pds: {
      type: "AtprotoPersonalDataServer",
      endpoint: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
    },
  },
  sign: (bytes) => keypair.sign(bytes),
});

console.log(JSON.stringify({ event: "did_plc_registering", did }));
await plc.submitOp(did, op);
console.log(JSON.stringify({ event: "did_plc_registered", did }));

// Verify the directory resolves it.
const doc = await plc.resolve(did);
console.log(JSON.stringify({ event: "did_plc_resolved", did, doc }));

// ── signer (did:plc identity, keypair signing) ───────────────────────

const signer: Signer = {
  did: () => did,
  sign: (bytes) => keypair.sign(bytes),
};

// ── repo factory ─────────────────────────────────────────────────────

const { app, subscribe } = createRepoFactory({
  storage: new MemoryStorage(),
  signer,
  baseOrigin: BASE_ORIGIN,
});

// ── HTTP server ──────────────────────────────────────────────────────

Deno.serve({ port: PORT }, app.fetch);
console.log(JSON.stringify({
  event: "listening",
  port: PORT,
  did,
  baseOrigin: BASE_ORIGIN,
}));

// ── relay subscriber ─────────────────────────────────────────────────

const dispatcherDid = `did:web:${DISPATCHER_HOST}`;
const { handleRequest } = createSubscriberFactory({ app });

async function getServiceAuthToken(lxm: string): Promise<string> {
  return await signServiceAuth(signer, {
    aud: dispatcherDid,
    lxm,
  });
}

runSubscriber({
  label: "xrpc-relay-pds",
  keypair,
  getServiceAuthToken,
  dispatcherHost: DISPATCHER_HOST,
  handleRequest,
  subscribe,
  onLog: (e) => console.log(JSON.stringify({
    event: "relay",
    severity: e.severity,
    message: e.message,
  })),
  onRegistered: (info) => console.log(JSON.stringify({
    event: "relay_registered",
    subdomain: info.subdomain,
    proxyRef: info.proxyRef,
  })),
  onSubscriptionOpen: (sub) => console.log(JSON.stringify({
    event: "relay_subscription_open",
    subscriptionId: sub.subscriptionId,
    nsid: sub.nsid,
    params: sub.params,
  })),
  onStatus: (status) => console.log(JSON.stringify({
    event: "relay_status",
    status,
  })),
});

console.log(JSON.stringify({ event: "relay_connecting", dispatcherHost: DISPATCHER_HOST }));
