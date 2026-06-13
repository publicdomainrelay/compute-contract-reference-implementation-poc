/**
 * market-registry — atproto service that tracks active bidder registrations.
 *
 * Mounts registerBidder, listBidders, and bidderHeartbeat XRPC handlers using
 * the repo-factory primitives. Bidders register their offering endpoint URLs
 * and NSIDs they serve; stale registrations are pruned by a periodic health
 * checker. Designed to run behind an xrpc relay for inbound routing.
 *
 * Exports:
 *   createMarketRegistry() — returns a running registry with relay registration
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
import { IdResolver } from "@atproto/identity";
import {
  loadOrGenerateKeypair,
  createRecordResolver,
  createRegisterBidderHandler,
  createListBiddersHandler,
} from "@publicdomainrelay/market";
import {
  REGISTER_BIDDER_NSID,
  LIST_BIDDERS_NSID,
} from "@publicdomainrelay/lexicons";
import { createRegistrationStore } from "./store.ts";
import type { RegistrationStore } from "./store.ts";
import { createHealthChecker } from "./health.ts";

// ── options ──────────────────────────────────────────────────────────

export interface MarketRegistryOptions {
  port?: number;
  privateKeyHex?: string;
  plcDirectoryUrl?: string;
  dispatcherHost?: string;
  label?: string;
  healthCheckIntervalMs?: number;
}

export interface MarketRegistry {
  did: string;
  signer: Signer;
  keypair: Secp256k1Keypair;
  api: ReturnType<typeof createRepoFactory>["api"];
  app: ReturnType<typeof createRepoFactory>["app"];
  store: RegistrationStore;
  relaySubdomain: string;
  /** Resolves when the relay registration completes. */
  ready: Promise<{ subdomain: string; proxyRef: string }>;
  stop: () => void;
}

// ── createMarketRegistry ─────────────────────────────────────────────

export async function createMarketRegistry(opts: MarketRegistryOptions = {}): Promise<MarketRegistry> {
  const PORT = opts.port ?? parseInt(Deno.env.get("PORT") ?? "0");
  const PRIVATE_KEY_HEX = opts.privateKeyHex ?? Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
  const PLC_DIRECTORY_URL = opts.plcDirectoryUrl ?? Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
  const DISPATCHER_HOST = opts.dispatcherHost ?? Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
  const BASE_ORIGIN = Deno.env.get("BASE_ORIGIN") ?? `http://localhost:${PORT}`;
  const LABEL = opts.label ?? "market-registry";
  const HEALTH_CHECK_INTERVAL_MS = opts.healthCheckIntervalMs ?? 60_000;

  const logInfo = (obj: Record<string, unknown>) => console.log(JSON.stringify(obj));
  const log = (
    severity: string,
    msg: string,
    extra?: Record<string, unknown>,
  ) => logInfo({ label: LABEL, severity, message: msg, ...(extra ?? {}) });

  // ── keypair ────────────────────────────────────────────────────

  const keypair = PRIVATE_KEY_HEX
    ? await Secp256k1Keypair.import(PRIVATE_KEY_HEX)
    : await Secp256k1Keypair.create({ exportable: true });

  // ── attestation keypair ─────────────────────────────────────────

  const privateKeyHex = PRIVATE_KEY_HEX ||
    Array.from(await keypair.export()).map((b) => b.toString(16).padStart(2, "0")).join("");

  const attestationKp = await loadOrGenerateKeypair(privateKeyHex);

  // ── did:plc registration ───────────────────────────────────────

  const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });
  const signingKeyDid = keypair.did();

  const { did, op } = await createGenesisOp({
    rotationKeys: [signingKeyDid],
    verificationMethods: {
      atproto: signingKeyDid,
      attestation: attestationKp.did(),
    },
    alsoKnownAs: [
      `at://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
    ],
    services: {
      atproto_pds: {
        type: "AtprotoPersonalDataServer",
        endpoint: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
      },
      pdr_temp_market: {
        type: "PDRTempMarket",
        endpoint: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
      },
      pdr_temp_compute_event: {
        type: "PDRTempComputeEvent",
        endpoint: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
      },
    },
    sign: (bytes) => keypair.sign(bytes),
  });

  logInfo({ event: "registry_did_plc_registering", did });
  await plc.submitOp(did, op);
  logInfo({ event: "registry_did_plc_registered", did });

  // ── signer ─────────────────────────────────────────────────────

  const signer: Signer = {
    did: () => did,
    sign: (bytes) => keypair.sign(bytes),
  };

  // ── repo factory ────────────────────────────────────────────────

  const { app, subscribe, api } = createRepoFactory({
    storage: new MemoryStorage(),
    signer,
    baseOrigin: BASE_ORIGIN,
  });

  // ── registration store ──────────────────────────────────────────

  const store = createRegistrationStore(api, did);

  // ── health checker ──────────────────────────────────────────────

  const healthChecker = createHealthChecker(store, log, {
    intervalMs: HEALTH_CHECK_INTERVAL_MS,
  });

  // ── mount XRPC handlers ─────────────────────────────────────────

  const idResolver = new IdResolver();

  // registerBidder — called by bidders to register their offering.
  const registerBidderHandler = createRegisterBidderHandler({
    deps: {
      hostname: () => relaySubdomain
        ? `${relaySubdomain}.${DISPATCHER_HOST}`
        : DISPATCHER_HOST,
      idResolver,
      resolve: createRecordResolver(idResolver),
      log,
    },
    onRegister: async ({ bidderDid, appliesTo }) => {
      const { uri, cid } = await store.register({ bidderDid, appliesTo });
      return { body: { registrationUri: uri, registrationCid: cid } };
    },
  });
  app.post(`/xrpc/${REGISTER_BIDDER_NSID}`, (c) => registerBidderHandler(c.req.raw));

  // listBidders — query endpoint for discovering bidders (any caller with valid service-auth).
  const listBiddersHandler = createListBiddersHandler({
    deps: {
      hostname: () => relaySubdomain
        ? `${relaySubdomain}.${DISPATCHER_HOST}`
        : DISPATCHER_HOST,
      idResolver,
      resolve: createRecordResolver(idResolver),
      log,
    },
    onList: async ({ payloadNsid, maxResults, cursor }) => {
      const result = await store.listBidders({ payloadNsid, maxResults, cursor });
      return { body: result };
    },
  });
  app.get(`/xrpc/${LIST_BIDDERS_NSID}`, (c) => listBiddersHandler(c.req.raw));

  // ── relay ready promise ─────────────────────────────────────────

  let relayRegistered: ((info: { subdomain: string; proxyRef: string }) => void) | null = null;
  const relayReady = new Promise<{ subdomain: string; proxyRef: string }>((resolve) => {
    relayRegistered = resolve;
  });
  let relaySubdomain = "";

  // Start health checker once relay registration completes.
  const ready = relayReady.then(async (info) => {
    healthChecker.start();
    logInfo({ event: "registry_health_checker_started", intervalMs: HEALTH_CHECK_INTERVAL_MS });
    return info;
  });

  // ── HTTP server ─────────────────────────────────────────────────

  const UNIX_SOCKET = Deno.env.get("UNIX_SOCKET") ?? "";
  const serverController = new AbortController();

  if (UNIX_SOCKET) {
    try { Deno.removeSync(UNIX_SOCKET); } catch { /* stale */ }
    Deno.serve({ path: UNIX_SOCKET, signal: serverController.signal } as Deno.ServeUnixOptions, app.fetch);
    logInfo({ event: "registry_listening", path: UNIX_SOCKET, did });
  } else {
    Deno.serve({ port: PORT, signal: serverController.signal }, app.fetch);
    logInfo({ event: "registry_listening", port: PORT, did });
  }

  // ── relay subscriber ────────────────────────────────────────────

  const dispatcherDid = `did:web:${DISPATCHER_HOST}`;
  const { handleRequest } = createSubscriberFactory({ app });

  async function getServiceAuthToken(lxm: string): Promise<string> {
    return await signServiceAuth(signer, { aud: dispatcherDid, lxm });
  }

  const relayController = runSubscriber({
    label: LABEL,
    keypair,
    getServiceAuthToken,
    dispatcherHost: DISPATCHER_HOST,
    handleRequest,
    subscribe: undefined,
    onLog: (e) => logInfo({
      event: "registry_relay",
      severity: e.severity,
      message: e.message,
    }),
    onRegistered: (info) => {
      relaySubdomain = info.subdomain;
      logInfo({
        event: "registry_relay_registered",
        subdomain: info.subdomain,
        proxyRef: info.proxyRef,
      });
      relayRegistered?.(info);
    },
    onSubscriptionOpen: (sub) => logInfo({
      event: "registry_relay_subscription_open",
      subscriptionId: sub.subscriptionId,
    }),
    onStatus: (status) => logInfo({ event: "registry_relay_status", status }),
  });

  logInfo({ event: "registry_relay_connecting", dispatcherHost: DISPATCHER_HOST });

  return {
    did,
    signer,
    keypair,
    api,
    app,
    store,
    relaySubdomain,
    ready,
    stop: () => {
      healthChecker.stop();
      relayController.stop();
      serverController.abort();
    },
  };
}

if (import.meta.main) {
  const registry = await createMarketRegistry();
  await registry.ready;
  console.log(JSON.stringify({ event: "registry_ready", did: registry.did }));
}
