#!/usr/bin/env -S deno run -A
/**
 * miniCloud.ts — merged MiniCloud server (Hono + Deno)
 *
 * Thin CLI wrapper around hono-factory-compute-provider-local.
 * Parses env/CLI config, creates the factory, sets up XRPC relay
 * (optional), and starts Deno.serve.
 *
 * Routes (mounted by factory):
 *   GET  /.well-known/openid-configuration
 *   GET  /.well-known/jwks
 *   POST /v1/oidc/issue       (RBAC middleware — requires valid OIDC token)
 *   POST /v1/oidc/prove
 *   GET  /v2/account
 *   POST /v2/droplets
 *   GET  /v2/droplets
 *   GET  /v2/droplets/:id
 *   DELETE /v2/droplets/:id
 *
 * Env:
 *   PORT              — listen port (default 8080)
 *   VM_IMAGE          — Docker image for QEMU VMs
 *   CONTAINER_MODE    — set "true" to use container.ts (cloud-init+sshd) instead of QEMU
 *   CONTAINER_IMAGE   — Docker image for container runner (default container-runner-ubuntu:latest)
 *   ISSUER_URL / THIS_ENDPOINT — OIDC issuer URL (default http://localhost:PORT)
 *   DATABASE_URI      — sqlite:///path or postgresql://... (default ./app.db)
 */

import { createComputeProviderLocalFactory } from "@publicdomainrelay/hono-factory-compute-provider-local";
import { getSigningKey, getPublicJwk } from "./oidc_helper.ts";
import { createLogger } from "../utils/log.ts";
import { Secp256k1Keypair } from "@atproto/crypto";
import { signServiceAuth } from "@publicdomainrelay/hono-factory-atproto-repo";
import type { Signer } from "@publicdomainrelay/hono-factory-atproto-repo";
import { runSubscriber } from "@publicdomainrelay/xrpc-relay";
import { createSubscriberFactory } from "@publicdomainrelay/hono-factory-xrpc-subscriber";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(Deno.env.get("PORT") ?? 8080);
const OPERATOR_HANDLE = Deno.env.get("OPERATOR_HANDLE") ?? "";
// This host's own identity, used as actorDid on lines not tied to a caller
// (startup, shutdown). Per-request lines override it with the caller DID.
const SELF_DID = Deno.env.get("QEMU_DID") ?? OPERATOR_HANDLE;
const VM_IMAGE = Deno.env.get("VM_IMAGE") ?? "atcr.io/johnandersen777.bsky.social/ccripoc-qemu-runner";
const CONTAINER_MODE = Deno.env.get("CONTAINER_MODE") === "true";
const CONTAINER_IMAGE = Deno.env.get("CONTAINER_IMAGE") ?? "container-runner-ubuntu:latest";
const CACHE_DIR = `${Deno.env.get("HOME")}/.cache/simple-qemu`;

// ── CLI flags ─────────────────────────────────────────────────────
function cliFlag(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : undefined;
}
const XRPC_RELAY_ISSUER_PATH = cliFlag("--write-xrpc-relay-generated-issuer-to");
const XRPC_RELAY_ENABLED = XRPC_RELAY_ISSUER_PATH !== undefined;
const DISPATCHER_HOST = Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

// actorDid = the caller DID doing the operation (bound per request from the
// validated auth token); onBehalfOfDid = the originating principal forwarded by
// the bidder over ON_BEHALF_OF_HEADER (the market.accept author).
const log = createLogger({ service: "qemu", selfDid: () => SELF_DID });

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;

const factory = createComputeProviderLocalFactory({
  operatorHandle: OPERATOR_HANDLE,
  selfDid: SELF_DID,
  issuerUrl,
  vmImage: VM_IMAGE,
  containerMode: CONTAINER_MODE,
  containerImage: CONTAINER_IMAGE,
  cacheDir: CACHE_DIR,
  log,
});

const app = factory.createApp();

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

function stopRelay(): void {
  try { relayController?.stop(); } catch { /* ignore */ }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, async () => {
    log("info", `received ${sig}, shutting down`);
    stopRelay();
    await factory.killAllDroplets();
    if (sig === "SIGINT") {
      Deno.exit(0);
    }
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Warm up signing key (loads from DB or generates + persists)
await getSigningKey();
const jwk = await getPublicJwk();
log("info", "miniCloud listening", { port: PORT, issuer: issuerUrl, kid: jwk.kid });

// ── XRPC relay (optional) ─────────────────────────────────────────
// Enabled when --write-xrpc-relay-generated-issuer-to <path> is passed.
// Connects to the fedproxy relay, registers a did:web identity, and writes
// it to the given path once live. Requests proxied through the relay are
// dispatched into the existing Hono app via createSubscriberFactory.
let relayController: ReturnType<typeof runSubscriber> | undefined;
if (XRPC_RELAY_ENABLED) {
  const PRIVATE_KEY_HEX = Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
  const relayKeypair = PRIVATE_KEY_HEX
    ? await Secp256k1Keypair.import(PRIVATE_KEY_HEX)
    : await Secp256k1Keypair.create({ exportable: true });

  const relaySigner: Signer = {
    did: () => relayKeypair.did(),
    sign: (bytes) => relayKeypair.sign(bytes),
  };

  // Use the existing Hono app for relay request dispatch. The relay
  // registration mints a did:web identity; requests proxied through the
  // relay arrive as #request frames and are dispatched via app.fetch().

  const { handleRequest } = createSubscriberFactory({ app });

  const dispatcherDid = `did:web:${DISPATCHER_HOST}`;
  async function getServiceAuthToken(lxm: string): Promise<string> {
    return await signServiceAuth(relaySigner, { aud: dispatcherDid, lxm });
  }

  relayController = runSubscriber({
    label: "qemu",
    keypair: relayKeypair,
    getServiceAuthToken,
    dispatcherHost: DISPATCHER_HOST,
    handleRequest,
    subscribe: undefined,
    onLog: (e) => log("info", `xrpc-relay: ${e.message}`, { severity: e.severity }),
    onRegistered: async (info) => {
      log("info", "xrpc-relay registered", { subdomain: info.subdomain, proxyRef: info.proxyRef });
      // Derive this qemu's external identity from the relay proxyRef so
      // service-auth JWT validation (aud == service did) passes when
      // callers reach us through the relay at https://<subdomain>.<host>.
      const proxyHost = info.proxyRef.replace(/^did:web:/, "");
      const baseUrl = `https://${proxyHost}`;
      Deno.env.set("ISSUER_URL", baseUrl);
      Deno.env.set("THIS_ENDPOINT", baseUrl);
      log("info", "xrpc-relay issuer url updated", { baseUrl });
      // Write did:web to the requested path so external tooling can discover it.
      try {
        await Deno.writeTextFile(XRPC_RELAY_ISSUER_PATH!, `${info.proxyRef}\n`);
        log("info", "xrpc-relay issuer written", { path: XRPC_RELAY_ISSUER_PATH, proxyRef: info.proxyRef });
      } catch (err) {
        log("error", "xrpc-relay failed to write issuer", { path: XRPC_RELAY_ISSUER_PATH, error: String(err) });
      }
    },
    onSubscriptionOpen: (sub) => log("info", "xrpc-relay subscription open", { subscriptionId: sub.subscriptionId, nsid: sub.nsid }),
    onStatus: (status) => log("info", "xrpc-relay status", { status }),
  });

  log("info", "xrpc-relay connecting", { dispatcherHost: DISPATCHER_HOST });
}

Deno.serve({ port: PORT }, app.fetch);
