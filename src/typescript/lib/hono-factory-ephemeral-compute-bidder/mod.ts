/**
 * ephemeral-compute-bidder — lightweight atproto PDS that acts as a market
 * bidder with compute provider, registry registration, and discovery/heartbeat
 * support.
 *
 * Mounts submitRfp, submitAccept, and submitEvent handlers using repo-factory
 * primitives (no @atproto/api Agent, no PDS login). When a compute provider
 * is configured (via options, env, or --provider CLI flag), provisions compute
 * on accept and tears it down on vm.delete.
 *
 * Without compute provider config, acts as a test-only bidder (no provisioning).
 *
 * Provider mode is selected by COMPUTE_PROVIDER env var or --provider CLI flag:
 *   "digitalocean" — uses @publicdomainrelay/compute-provider-digitalocean
 *   "local"        — uses @publicdomainrelay/compute-provider-local
 *
 * Exports:
 *   createEphemeralBidder() — returns a running bidder with relay registration,
 *     offering, discovery record, and optional registry registration
 *
 * Usage (test):
 *   const bidder = await createEphemeralBidder({ port: 0 });
 *   const { proxyRef, did } = await bidder.ready;
 *   // … run contract flow …
 *
 * Usage (with compute provider via env):
 *   COMPUTE_PROVIDER=digitalocean COMPUTE_PROVIDER_TOKEN=... deno run ...
 *
 * Usage (with compute provider via CLI flag):
 *   deno run ... --provider local
 */

import { Agent } from "@atproto/api";
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
  attestationFor,
  toStorableEntry,
  createSubmitRfpHandler,
  createSubmitAcceptHandler,
  createSubmitEventHandler,
  createRecordResolver,
  strongRef,
  type AttestationKeypair,
  type InlineAttestation,
  type SubmitRfpCallback,
  type SubmitAcceptCallback,
  type EventDispatchContext,
} from "@publicdomainrelay/market";
import {
  RFP_NSID,
  BID_NSID,
  RECEIPT_NSID,
  OFFERING_NSID,
  COMPUTE_VM_NSID,
  SUBMIT_RFP_NSID,
  SUBMIT_ACCEPT_NSID,
  SUBMIT_EVENT_NSID,
  SUBMIT_BID_NSID,
  SUBMIT_BID_LXM,
  EVENT_NSID,
  COMPUTE_EVENTS_VM_DELETE_NSID,
  REGISTER_BIDDER_NSID,
  BIDDER_DISCOVERY_NSID,
} from "@publicdomainrelay/lexicons";
import { TID } from "@atproto/common";
import type { ComputeProvider, ComputeProviderMode, DropletSpec, ProvisionResult, StrongRef, VM } from "@publicdomainrelay/compute-provider";
import { computeProviderModeFromEnv } from "@publicdomainrelay/compute-provider";
import { createLocalComputeProvider } from "@publicdomainrelay/compute-provider-local";
import { createDigitalOceanComputeProvider } from "@publicdomainrelay/compute-provider-digitalocean";
import { createAttestationCid, type RecordMap } from "@atiproto/atproto-attestation";
import { createLogger } from "@publicdomainrelay/utils-log";
import { DEFAULT_REGISTRY_ENDPOINTS } from "@publicdomainrelay/market/discovery";

// ── options ──────────────────────────────────────────────────────────

export interface ComputeProviderConfig {
  mode?: ComputeProviderMode;  // "local" | "digitalocean"
  /** DO API token (required for digitalocean mode). */
  token?: string;
  /** DO API base URL (digitalocean mode). */
  baseUrl?: string;
  spec?: DropletSpec;
  // ── local mode ─────────────────────────────────────────────────
  containerMode?: "vm" | "container";
  vmImage?: string;
  containerImage?: string;
  cacheDir?: string;
  // ── digitalocean RBAC mode ─────────────────────────────────────
  /** ATProto Agent getter (digitalocean mode, for service auth + record creation). */
  getAgent?: () => Agent;
  /** Bidder DID getter (digitalocean mode). */
  getAgentDid?: () => string;
  /** RBAC git repo root for policy files (digitalocean mode). */
  rbacRepoRoot?: string;
  /** Path inside VM for accept bundle (digitalocean mode cloud-init). */
  acceptPathVm?: string;
}

export interface EphemeralBidderOptions {
  port?: number;
  privateKeyHex?: string;
  plcDirectoryUrl?: string;
  dispatcherHost?: string;
  label?: string;
  /** Compute provider config — when set, provisions real droplets on accept. */
  computeProvider?: ComputeProviderConfig;
  /** Registry endpoint for registering this bidder (registerBidder XRPC). */
  registryEndpoint?: string;
  /** Interval (ms) for discovery/heartbeat updates. Default 60000. */
  heartbeatIntervalMs?: number;
}

/** receiptKey → active contract state */
export interface ActiveContract {
  /** Resolves to the provider id once background provisioning completes
   *  (or undefined if provisioning was skipped/failed). */
  providerIdPromise?: Promise<string | number | undefined>;
  acceptAuthor: string;
}

export interface EphemeralBidder {
  did: string;
  signer: Signer;
  keypair: Secp256k1Keypair;
  api: ReturnType<typeof createRepoFactory>["api"];
  app: ReturnType<typeof createRepoFactory>["app"];
  proxyRef: string;
  relaySubdomain: string;
  /** Resolves when the relay registration completes + offering is created. */
  ready: Promise<{ subdomain: string; proxyRef: string }>;
  stop: () => void;
  attestationKp: AttestationKeypair;

  // ── contract tracking ───────────────────────────────────────────
  activeContracts: Map<string, ActiveContract>;
}

// ── internal helpers ─────────────────────────────────────────────────

function refKey(ref: { uri: string; cid: string }): string {
  return `${ref.uri}#${ref.cid}`;
}

function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const withoutProtocol = uri.replace("at://", "");
  const parts = withoutProtocol.split("/");
  return { repo: parts[0], collection: parts[1], rkey: parts.slice(2).join("/") };
}

/* startContainerHost removed — the local compute provider (createLocalComputeProvider)
   now owns its issuer + XRPC relay in setup(); the bidder uses it directly. */
/* createAgentAdapter removed — compute providers now accept createRecord directly */

// ── createEphemeralBidder ─────────────────────────────────────────────

export async function createEphemeralBidder(opts: EphemeralBidderOptions = {}): Promise<EphemeralBidder> {
  const PRIVATE_KEY_HEX = opts.privateKeyHex ?? Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
  const PLC_DIRECTORY_URL = opts.plcDirectoryUrl ?? Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
  const DISPATCHER_HOST = opts.dispatcherHost ?? Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
  const LABEL = opts.label ?? "ephemeral-bidder";
  const REGISTRY_ENDPOINTS: string[] = (() => {
    if (opts.registryEndpoint) return [opts.registryEndpoint];
    const env = Deno.env.get("REGISTRY_ENDPOINT");
    if (env) return [env];
    return DEFAULT_REGISTRY_ENDPOINTS;
  })();
  const HEARTBEAT_INTERVAL_MS = opts.heartbeatIntervalMs ?? parseInt(Deno.env.get("HEARTBEAT_INTERVAL_MS") ?? "60000");

  // ── compute provider config ─────────────────────────────────────
  const cpCfg = opts.computeProvider;
  const mode: ComputeProviderMode = cpCfg?.mode ?? computeProviderModeFromEnv();
  const token = cpCfg?.token ?? Deno.env.get("COMPUTE_PROVIDER_TOKEN") ?? "";
  const baseUrl = cpCfg?.baseUrl ?? Deno.env.get("COMPUTE_PROVIDER_BASE_URL") ?? "";

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

  const privateKeyHex = PRIVATE_KEY_HEX ||
    Array.from(await keypair.export()).map((b) => b.toString(16).padStart(2, "0")).join("");

  // ── attestation keypair ─────────────────────────────────────────

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

  logInfo({ event: "bidder_did_plc_registering", did });
  await plc.submitOp(did, op);
  logInfo({ event: "bidder_did_plc_registered", did });

  // Tell the in-process compute provider our DID so its RBAC middleware
  // can resolve the operator for service-auth allowlist checks.
  Deno.env.set("OPERATOR_HANDLE", did);

  // ── signer ─────────────────────────────────────────────────────

  const signer: Signer = {
    did: () => did,
    sign: (bytes) => keypair.sign(bytes),
  };

  // ── relay ready promise ─────────────────────────────────────────

  let relayRegistered: ((info: { subdomain: string; proxyRef: string }) => void) | null = null;
  const relayReady = new Promise<{ subdomain: string; proxyRef: string }>((resolve) => {
    relayRegistered = resolve;
  });
  let relaySubdomain = "";
  let relayProxyRef = "";

  // ── contract tracking ───────────────────────────────────────────

  const activeContracts = new Map<string, ActiveContract>();

  // ── repo factory ────────────────────────────────────────────────

  const { app, subscribe, api } = createRepoFactory({
    storage: new MemoryStorage(),
    signer,
    baseOrigin: `https://${keypair.did().replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
    // Mirror the PLC market services into the did:web doc, so a bid's
    // submitAccept did:web ref resolves back to this endpoint.
    didWebServices: [
      { id: "pdr_temp_market", type: "PDRTempMarket" },
      { id: "pdr_temp_compute_event", type: "PDRTempComputeEvent" },
    ],
  });

  const bidder = {
    did,
    signer,
    keypair,
    api,
    app,
    proxyRef: relayProxyRef,
    relaySubdomain,
    ready: null as unknown as Promise<{ subdomain: string; proxyRef: string }>,
    stop: () => {
      stopDiscoveryUpdater();
      relayController.stop();
    },
    attestationKp,
    activeContracts,
  };

  const ready: Promise<{ subdomain: string; proxyRef: string }> = relayReady.then(async (info) => {
    await _cpSetupDone;
    // ensureOperatorAllowlist is only needed for the legacy HTTP provider;
    // local and digitalocean modes don't use service-auth allowlists.
    if (mode !== "local" && mode !== "digitalocean") {
      await ensureOperatorAllowlist(api, did, baseUrl);
    }
    // Create the offering record once relay is registered.
    await ensureOffering(api, did);
    // Create initial discovery record in own repo.
    await ensureDiscoveryRecord();
    // Register with the registry after offering is in place.
    await registerWithRegistry();
    // Update the returned object's properties now that relay registration is complete.
    bidder.proxyRef = info.proxyRef;
    bidder.relaySubdomain = info.subdomain;
    return info;
  });
  bidder.ready = ready;

  // ── compute provider ──────────────────────────────────────────────
  const createRecord = async (
    collection: string,
    record: Record<string, unknown>,
  ): Promise<StrongRef> => {
    const rkey = TID.next().toString();
    await api.applyWrites(did, [{ action: "create", collection, rkey, record }]);
    const rec = await api.getRecord(did, collection, rkey);
    return { $type: "com.atproto.repo.strongRef", uri: `at://${did}/${collection}/${rkey}`, cid: rec?.cid ?? "" };
  };

  const deleteRecord = async (collection: string, rkey: string): Promise<void> => {
    await api.applyWrites(did, [{ action: "delete", collection, rkey }]);
  };

  const computeProvider: ComputeProvider | null = (() => {
    if (mode === "digitalocean") {
      if (!token || !cpCfg?.getAgent || !cpCfg?.getAgentDid || !cpCfg?.rbacRepoRoot) {
        logInfo({ event: "bidder_do_incomplete", hint: "digitalocean mode requires token, getAgent, getAgentDid, rbacRepoRoot", mode });
        return null;
      }
      return createDigitalOceanComputeProvider({
        getAgent: cpCfg.getAgent,
        getAgentDid: cpCfg.getAgentDid,
        log: (level, msg, fields) => logInfo({ label: LABEL, severity: level, message: msg, ...(fields ?? {}) }),
        parseAtUri,
        digitaloceanBaseUrl: baseUrl || "https://droplet-oidc.its1337.com",
        doToken: token,
        rbacRepoRoot: cpCfg.rbacRepoRoot,
        acceptPathVm: cpCfg.acceptPathVm || "/root/secrets/publicdomainrelay.com/market/accept.json",
      });
    }
    if (mode === "local") {
      const localLog = (level: string, msg: string, fields?: Record<string, unknown>) =>
        logInfo({ label: LABEL, severity: level, message: msg, ...(fields ?? {}) });

      // The local provider owns the whole lifecycle: setup() stands up the
      // workload-identity OIDC issuer + XRPC relay, createBidConfig advertises
      // that relay's issuer URL, provision() injects the OIDC provisioning
      // exchange + registers the container with the issuer, destroy() removes it.
      // No method overrides — the provider is self-sufficient (getIssuerUrl is
      // wired internally by createLocalComputeProvider after relay registration).
      return createLocalComputeProvider({
        log: localLog,
        parseAtUri,
        getAgentDid: () => did,
        getIssuerUrl: () => "", // replaced internally by the provider
        acceptPathVm: cpCfg?.acceptPathVm,
        containerMode: cpCfg?.containerMode ?? "container",
        vmImage: cpCfg?.vmImage,
        containerImage: cpCfg?.containerImage,
        cacheDir: cpCfg?.cacheDir,
        createRecord,
        deleteRecord,
      });
    }
    return null;
  })();

  const _cpSetupDone = computeProvider?.setup
    ? computeProvider.setup().then(() => logInfo({ event: "bidder_compute_provider_setup_done", did, mode }))
    : Promise.resolve();

  // ── record helpers (same pattern as requester) ──────────────────

  async function createRepoRecord(
    collection: string,
    record: Record<string, unknown>,
  ): Promise<{ uri: string; cid: string }> {
    const rkey = TID.next().toString();
    await api.applyWrites(did, [{ action: "create", collection, rkey, record }]);
    const rec = await api.getRecord(did, collection, rkey);
    return { uri: `at://${did}/${collection}/${rkey}`, cid: rec?.cid ?? "" };
  }

  async function createSignedRepoRecord(
    collection: string,
    record: Record<string, unknown>,
    issuer?: string,
  ): Promise<{ uri: string; cid: string }> {
    const rkey = TID.next().toString();
    const att = attestationFor(attestationKp, issuer);
    const entry = await att.sign({ record, repository: did }) as InlineAttestation;
    const signed = { ...record, signatures: [toStorableEntry(entry)] };
    await api.applyWrites(did, [{ action: "create", collection, rkey, record: signed }]);
    const rec = await api.getRecord(did, collection, rkey);
    return { uri: `at://${did}/${collection}/${rkey}`, cid: rec?.cid ?? "" };
  }

  // ── outbound XRPC helper ───────────────────────────────────────
  // (bidder calls requester's submitBid endpoint)

  const idResolver = new IdResolver();

  async function callService(
    endpointUrl: string,   // "did:plc:xxx#pdr_temp_market" or "http://..."
    nsid: string,
    lxm: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; ok: boolean; body: unknown }> {
    let targetBase: string;
    let audDid: string;

    if (endpointUrl.startsWith("http://") || endpointUrl.startsWith("https://")) {
      targetBase = `${endpointUrl.replace(/\/+$/, "")}/xrpc`;
      audDid = `did:web:${new URL(endpointUrl).host}`;
    } else if (endpointUrl.startsWith("did:")) {
      const didPart = endpointUrl.split("#")[0];
      const svcDoc = await idResolver.did.resolve(didPart);
      const svcId = endpointUrl.includes("#") ? endpointUrl.split("#")[1] : "pdr_temp_market";
      const svc = (svcDoc?.service ?? []).find((s: { id: string }) => s.id === `#${svcId}`);
      if (!svc) throw new Error(`service ${svcId} not found in DID doc for ${didPart}`);
      const ep = (svc as { serviceEndpoint: string }).serviceEndpoint.replace(/\/+$/, "");
      targetBase = `${ep}/xrpc`;
      audDid = `did:web:${new URL(ep).host}`;
    } else {
      throw new Error(`unresolvable endpoint: ${endpointUrl}`);
    }

    const token = await signServiceAuth(signer, { aud: audDid, lxm });
    const res = await fetch(`${targetBase}/${nsid}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let resBody: unknown;
    try { resBody = await res.json(); } catch { resBody = await res.text(); }
    return { status: res.status, ok: res.ok, body: resBody };
  }

  // ── discovery record maintenance ─────────────────────────────────

  let discoveryTimer: ReturnType<typeof setInterval> | null = null;
  let discoveryRecordRkey: string | null = null;

  async function ensureDiscoveryRecord(): Promise<void> {
    const nowIso = new Date().toISOString();

    // Check if discovery record already exists
    if (!discoveryRecordRkey) {
      const existing = await api.listRecords(did, BIDDER_DISCOVERY_NSID, { limit: 1 });
      if (existing?.records?.length) {
        discoveryRecordRkey = existing.records[0].uri.split("/").pop()!;
      }
    }

    if (discoveryRecordRkey) {
      // Update: fetch current record, bump updatedAt, write full record back
      const current = await api.getRecord(did, BIDDER_DISCOVERY_NSID, discoveryRecordRkey);
      const prev = (current?.value ?? {}) as Record<string, unknown>;
      const updated = {
        ...prev,
        updatedAt: nowIso,
      };
      await api.applyWrites(did, [
        { action: "update", collection: BIDDER_DISCOVERY_NSID, rkey: discoveryRecordRkey, record: updated },
      ]);
    } else {
      // Create new
      const rkey = TID.next().toString();
      const record = {
        $type: BIDDER_DISCOVERY_NSID,
        endpointUrl: relayProxyRef || `${did}#pdr_temp_market`,
        appliesTo: [COMPUTE_VM_NSID],
        updatedAt: nowIso,
        createdAt: nowIso,
      };
      await api.applyWrites(did, [
        { action: "create", collection: BIDDER_DISCOVERY_NSID, rkey, record },
      ]);
      discoveryRecordRkey = rkey;
    }
  }

  function startDiscoveryUpdater(): void {
    if (discoveryTimer) return;
    const intervalMs = HEARTBEAT_INTERVAL_MS;
    logInfo({ event: "discovery_updater_start", intervalMs });
    discoveryTimer = setInterval(async () => {
      try {
        await ensureDiscoveryRecord();
      } catch (err) {
        logInfo({ event: "discovery_update_error", err: String(err) });
      }
    }, intervalMs);
  }

  function stopDiscoveryUpdater(): void {
    if (discoveryTimer) {
      clearInterval(discoveryTimer);
      discoveryTimer = null;
    }
  }

  // ── registry integration ────────────────────────────────────────

  async function registerWithRegistry(): Promise<void> {
    if (REGISTRY_ENDPOINTS.length === 0) {
      logInfo({ event: "registry_disabled", reason: "no REGISTRY_ENDPOINT configured" });
      return;
    }

    const body = {
      bidderDid: did,
      appliesTo: [COMPUTE_VM_NSID],
    };

    for (const endpoint of REGISTRY_ENDPOINTS) {
      try {
        const res = await callService(endpoint, REGISTER_BIDDER_NSID, REGISTER_BIDDER_NSID, body);
        if (res.ok) {
          logInfo({ event: "registered_with_registry", endpoint });
          startDiscoveryUpdater();
        } else {
          logInfo({ event: "register_with_registry_error", endpoint, status: res.status, body: res.body });
        }
      } catch (err) {
        logInfo({ event: "register_with_registry_exception", endpoint, err: String(err) });
      }
    }
  }

  // ── submitRfp handler ───────────────────────────────────────────
  //
  // Called when a requester submits an RFP to this bidder. Creates a
  // signed bid record in the bidder's repo and submits it to the RFP's
  // submitBid endpoint (the requester).

  const onRfp: SubmitRfpCallback = async ({ rfpUri, rfpCid, rfp, issuerDid, log: cbLog }) => {
    cbLog("info", "bidder received RFP", { rfpUri, rfpCid, issuerDid });

    const nowIso = new Date().toISOString();

    // 1. Create bid config if compute provider is wired.
    let bidConfigRef: { uri: string; cid: string } | undefined;
    if (computeProvider) {
      const configRef = await computeProvider.createBidConfig(nowIso);
      bidConfigRef = { uri: configRef.uri, cid: configRef.cid };
      cbLog("info", "bidder created bid config", { configUri: configRef.uri });
    }

    // 2. Create bid payload (minimal test payload — "free" settlement).
    const { uri: payloadUri, cid: payloadCid } = await createRepoRecord(
      "com.publicdomainrelay.temp.market.bids.free",
      { $type: "com.publicdomainrelay.temp.market.bids.free", cost: 0, createdAt: nowIso },
    );

    // 3. Create signed bid record.
    const bidRecord: Record<string, unknown> = {
      $type: BID_NSID,
      rfp: strongRef(rfpUri, rfpCid),
      payload: strongRef(payloadUri, payloadCid),
      // Where the requester should send the accept.
      submitAccept: `${did}#pdr_temp_market`,
      createdAt: nowIso,
    };
    if (bidConfigRef) {
      bidRecord.bidConfig = strongRef(bidConfigRef.uri, bidConfigRef.cid);
    }
    const { uri: bidUri, cid: bidCid } = await createSignedRepoRecord(BID_NSID, bidRecord, relayProxyRef);

    cbLog("info", "bidder created bid", { bidUri, bidCid, payloadUri });

    // 4. Submit signed bid to the requester's submitBid endpoint.
    // The handler verifies the inline signature, so we must send the
    // signed version (with the signatures array), not bidRecord.
    const bidRkey = bidUri.split("/").pop()!;
    const signedBid = await api.getRecord(did, BID_NSID, bidRkey);
    const submitBidUrl = rfp.submitBid as string | undefined;
    if (submitBidUrl) {
      try {
        const res = await callService(submitBidUrl, SUBMIT_BID_NSID, SUBMIT_BID_LXM, {
          uri: bidUri,
          cid: bidCid,
          record: signedBid?.value ?? bidRecord,
        });
        cbLog("info", "bidder submitted bid to requester", { status: res.status, ok: res.ok });
      } catch (err) {
        cbLog("error", "bidder failed to submit bid", { error: String(err) });
      }
    }

    return { body: { ok: true, bidUri, bidCid } };
  };

  // ── submitAccept handler ────────────────────────────────────────
  //
  // Called when the requester accepts a bid. Creates a receipt record
  // (signed) and returns receipt coords + submitEvent endpoint so the
  // requester can report vm.delete later.

  const onAccept: SubmitAcceptCallback = async ({ acceptUri, acceptCid, accept, issuerDid, log: cbLog }) => {
    cbLog("info", "bidder received accept", { acceptUri, acceptCid, issuerDid });

    const nowIso = new Date().toISOString();

    // Resolve accept to find bid/rfp refs for the receipt.
    const rfpRef = accept.rfp as { uri: string; cid: string } | undefined;
    const bidRef = accept.bid as { uri: string; cid: string } | undefined;

    // Provision compute if compute provider is wired — IN THE BACKGROUND.
    // Resolve chain: accept.rfp → RFP record → .payload → compute.vm record.
    //
    // Container/VM boot + SSH polling can take well over the relay/fedproxy
    // request-idle timeout (~18s). Awaiting it here makes the submitAccept
    // response arrive too late → fedproxy returns 502 and the requester never
    // gets the receipt. The receipt is the durable commitment; the requester
    // polls SSH on its own (vmReadyTimeoutSec) until the VM answers, so we ack
    // immediately and let provisioning finish asynchronously.
    let providerIdPromise: Promise<string | number | undefined> = Promise.resolve(undefined);
    if (computeProvider && rfpRef) {
      providerIdPromise = (async (): Promise<string | number | undefined> => {
        const resolve = createRecordResolver(idResolver);
        const rfpResolved = await resolve.resolve({ uri: rfpRef.uri, cid: rfpRef.cid });
        const rfpRecord = rfpResolved as Record<string, unknown> | null;
        const vmRef = rfpRecord?.payload as { uri: string; cid: string } | undefined;
        if (!vmRef) return undefined;
        const vmResolved = await resolve.resolve({ uri: vmRef.uri, cid: vmRef.cid });
        const vm = vmResolved as Record<string, unknown> | null;
        if (!vm) return undefined;

        let bidConfigResolved: { uri: string; cid: string; value: unknown } | null = null;
        if (bidRef) {
          try {
            const bidResolved = await resolve.resolve({ uri: bidRef.uri, cid: bidRef.cid }) as Record<string, unknown> | null;
            const cfgRef = bidResolved?.bidConfig as { uri: string; cid: string } | undefined;
            if (cfgRef) {
              const cfgValue = await resolve.resolve({ uri: cfgRef.uri, cid: cfgRef.cid });
              bidConfigResolved = { uri: cfgRef.uri, cid: cfgRef.cid, value: cfgValue };
            }
          } catch (err) {
            cbLog("warn", "bidder failed to resolve bidConfig", { error: String(err) });
          }
        }

        const bundle = {
          $type: "com.publicdomainrelay.temp.market.accept",
          accept: { uri: acceptUri, cid: acceptCid },
          rfp: { uri: rfpRef.uri, cid: rfpRef.cid },
          bid: bidRef ? { uri: bidRef.uri, cid: bidRef.cid } : null,
          bid_config: bidConfigResolved,
        };
        const vmWithBundle = {
          ...vm,
          user_data: computeProvider.injectAcceptBundle((vm.user_data as string) ?? "", bundle),
          _uri: vmRef.uri,
          _cid: vmRef.cid,
        };
        const result = await computeProvider.provision(vmWithBundle as any, issuerDid);
        cbLog("info", "bidder provisioned compute", { providerId: result.providerId });
        return result.providerId;
      })().catch((err) => {
        cbLog("error", "bidder failed to provision", { error: String(err) });
        return undefined;
      });
    }

    // Create a signed receipt in the bidder's repo.
    // Build a remote attestation proof: the receipt's top-level `cid` binds
    // the accept record (in the requester's repo) to this receipt, so the
    // requester's verifyRemoteProof can confirm the provider committed.
    const acceptBare: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(accept)) {
      if (k !== "_uri" && k !== "_cid") acceptBare[k] = v;
    }
    const receiptMetadata: Record<string, unknown> = {
      $type: RECEIPT_NSID,
      rfp: rfpRef ? strongRef(rfpRef.uri, rfpRef.cid) : null,
      bid: bidRef ? strongRef(bidRef.uri, bidRef.cid) : null,
      accept: strongRef(acceptUri, acceptCid),
      payload: null,  // no settlement payload for test
      submitEvent: `${did}#pdr_temp_compute_event`,
      createdAt: nowIso,
    };
    const bindCid = createAttestationCid(
      acceptBare as RecordMap,
      receiptMetadata as RecordMap,
      issuerDid,
    );
    const receiptRecord = { ...receiptMetadata, cid: bindCid.toString() };
    const { uri: receiptUri, cid: receiptCid } = await createSignedRepoRecord(
      RECEIPT_NSID, receiptRecord, relayProxyRef,
    );

    // Track the contract so submitEvent can look it up later.
    const rkey = receiptUri.split("/").pop()!;
    activeContracts.set(refKey({ uri: receiptUri, cid: receiptCid }), {
      providerIdPromise,
      acceptAuthor: issuerDid,
    });

    cbLog("info", "bidder created receipt", {
      receiptUri, receiptCid,
      acceptAuthor: issuerDid,
      activeCount: activeContracts.size,
    });

    return {
      body: {
        id: rkey,
        uri: receiptUri,
        cid: receiptCid,
        submitEvent: `${did}#pdr_temp_compute_event`,
      },
    };
  };

  // ── submitEvent handler ─────────────────────────────────────────
  //
  // Handles compute.events.vm.delete events. Looks up the receipt,
  // verifies the caller matches the accept author, and cleans up.

  const onVmDelete = async (ctx: EventDispatchContext): Promise<{ status?: number; body?: unknown } | void> => {
    const receiptRef = ctx.event.receipt as { uri: string; cid: string } | undefined;
    if (!receiptRef) {
      ctx.log("warn", "submitEvent: no receipt in event", { uri: ctx.uri });
      return { status: 400, body: { error: "InvalidRequest", message: "missing receipt in event" } };
    }
    const rk = refKey(receiptRef);
    ctx.log("info", "submitEvent vm.delete", { receiptKey: rk, issuerDid: ctx.issuerDid });

    if (!activeContracts.has(rk)) {
      ctx.log("warn", "submitEvent: unknown receipt", { receiptKey: rk });
      return { status: 400, body: { error: "InvalidRequest", message: "unknown receipt" } };
    }

    const contract = activeContracts.get(rk)!;
    if (contract.acceptAuthor !== ctx.issuerDid) {
      ctx.log("warn", "submitEvent: issuerDid mismatch", {
        expected: contract.acceptAuthor,
        got: ctx.issuerDid,
      });
      return { status: 403, body: { error: "Forbidden", message: "not the accept author" } };
    }

    // Tear down provisioned resources if compute provider is wired.
    const reason = "vm.delete event received";
    if (computeProvider) {
      // Provisioning runs in the background; wait for it to settle so we know
      // the provider id before tearing down (avoids leaking a container that
      // finished booting after the accept ack).
      const providerId = await contract.providerIdPromise;
      if (providerId !== undefined) {
        try {
          await computeProvider.destroy(providerId);
          ctx.log("info", "submitEvent: compute destroyed", { providerId, reason });
        } catch (err) {
          ctx.log("error", "submitEvent: failed to destroy compute", { providerId, error: String(err) });
        }
      }
      if (computeProvider?.teardown) {
        const _cpTornDown = computeProvider?.teardown
          ? computeProvider.teardown().then(() => logInfo({ event: "bidder_compute_provider_teardown_done", did, mode }))
          : Promise.resolve();
      }
    }

    activeContracts.delete(rk);
    ctx.log("info", "submitEvent: vm deleted", { receiptKey: rk, remaining: activeContracts.size });
    return { body: { ok: true } };
  };

  // ── mount XRPC handlers ─────────────────────────────────────────

  // submitRfp — receives RFPs, creates and submits bids.
  const rfpHandler = createSubmitRfpHandler({
    deps: {
      hostname: () => relaySubdomain
        ? `${relaySubdomain}.${DISPATCHER_HOST}`
        : DISPATCHER_HOST,
      idResolver,
      resolve: createRecordResolver(idResolver),
      log,
    },
    // Dispatch by serviceId -> payloadNsid.  The RFP's payload is a
    // compute.vm record, so the callback key is COMPUTE_VM_NSID.
    callbacks: {
      pdr_temp_market: {
        [COMPUTE_VM_NSID]: onRfp,
      },
    },
  });
  app.post(`/xrpc/${SUBMIT_RFP_NSID}`, (c) => rfpHandler(c.req.raw));

  // submitAccept — receives accepted bids, creates receipts.
  const acceptHandler = createSubmitAcceptHandler({
    deps: {
      hostname: () => relaySubdomain
        ? `${relaySubdomain}.${DISPATCHER_HOST}`
        : DISPATCHER_HOST,
      idResolver,
      resolve: createRecordResolver(idResolver),
      log,
    },
    serviceIds: ["pdr_temp_market"],
    onAccept,
  });
  app.post(`/xrpc/${SUBMIT_ACCEPT_NSID}`, (c) => acceptHandler(c.req.raw));

  // submitEvent — receives lifecycle events (vm.delete).
  const eventHandler = createSubmitEventHandler({
    deps: {
      hostname: () => relaySubdomain
        ? `${relaySubdomain}.${DISPATCHER_HOST}`
        : DISPATCHER_HOST,
      idResolver,
      resolve: createRecordResolver(idResolver),
      log,
    },
    callbacks: {
      pdr_temp_compute_event: {
        [COMPUTE_EVENTS_VM_DELETE_NSID]: onVmDelete,
      },
    },
  });
  app.post(`/xrpc/${SUBMIT_EVENT_NSID}`, (c) => eventHandler(c.req.raw));

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
    // No subscribe handler needed for this test — the bidder only receives
    // #request frames, not #subscribe frames.
    subscribe: undefined,
    onLog: (e) => logInfo({
      event: "bidder_relay",
      severity: e.severity,
      message: e.message,
    }),
    onRegistered: (info) => {
      relaySubdomain = info.subdomain;
      relayProxyRef = info.proxyRef;
      logInfo({
        event: "bidder_relay_registered",
        subdomain: info.subdomain,
        proxyRef: info.proxyRef,
      });
      relayRegistered?.(info);
    },
    onSubscriptionOpen: (sub) => logInfo({
      event: "bidder_relay_subscription_open",
      subscriptionId: sub.subscriptionId,
    }),
    onStatus: (status) => logInfo({ event: "bidder_relay_status", status }),
  });

  logInfo({ event: "bidder_relay_connecting", dispatcherHost: DISPATCHER_HOST });

  return bidder;
}

// ── operator allowlist helper ──────────────────────────────────────────
// Creates a com.publicdomainrelay.temp.auth.allowlist.rbacDid record in
// the operator's (our own) repo so raiseIfUnauthorizedServiceAuth can
// verify that we're allowed to call the compute provider's /v2/account
// and /v2/droplets endpoints (step 2b in rbac_helper.ts).  Mirrors the
// allow-access.ts CLI but uses the repo-factory API directly.
const ALLOWLIST_NSID = "com.publicdomainrelay.temp.auth.allowlist.rbacDid";

async function ensureOperatorAllowlist(
  api: ReturnType<typeof createRepoFactory>["api"],
  operatorDid: string,
  service: string,
): Promise<void> {
  const existing = await api.listRecords(operatorDid, ALLOWLIST_NSID, { limit: 100 });
  // Check if an allowlist record already protects this service+scope.
  for (const rec of existing?.records ?? []) {
    const v = rec.value as Record<string, unknown>;
    const protects = v.protects as Record<string, { service: string; scope?: string }> | undefined;
    for (const p of Object.values(protects ?? {})) {
      if (
        (p.service === service || p.service === "*") &&
        (p.scope === "account.auth" || p.scope === "*" || !p.scope)
      ) {
        console.log(JSON.stringify({ event: "bidder_allowlist_exists", uri: rec.uri }));
        return;
      }
    }
  }
  const rkey = TID.next().toString();
  await api.applyWrites(operatorDid, [{
    action: "create",
    collection: ALLOWLIST_NSID,
    rkey,
    record: {
      $type: ALLOWLIST_NSID,
      protects: {
        allowSelf: { service, scope: "account.auth" },
      },
      allowed: {
        allowSelf: [operatorDid],
      },
      createdAt: new Date().toISOString(),
    },
  }]);
  console.log(JSON.stringify({
    event: "bidder_allowlist_created",
    uri: `at://${operatorDid}/${ALLOWLIST_NSID}/${rkey}`,
    service,
    operatorDid,
  }));
}

// ── offering helper ──────────────────────────────────────────────────
// Creates a com.publicdomainrelay.temp.market.offering record in the
// bidder's own repo so requesters can discover it.

async function ensureOffering(
  api: ReturnType<typeof createRepoFactory>["api"],
  did: string,
): Promise<void> {
  // Check if offering already exists.
  const existing = await api.listRecords(did, OFFERING_NSID, { limit: 1 });
  if (existing?.records?.length) {
    console.log(JSON.stringify({ event: "bidder_offering_exists", uri: existing.records[0].uri }));
    return;
  }
  const rkey = TID.next().toString();
  await api.applyWrites(did, [{
    action: "create",
    collection: OFFERING_NSID,
    rkey,
    record: {
      $type: OFFERING_NSID,
      endpointUrl: `${did}#pdr_temp_market`,
      appliesTo: ["com.publicdomainrelay.temp.compute.vm"],
      createdAt: new Date().toISOString(),
    },
  }]);
  console.log(JSON.stringify({ event: "bidder_offering_created", uri: `at://${did}/${OFFERING_NSID}/${rkey}` }));
}

// ── CLI main (when run directly) ──────────────────────────────────────

if (import.meta.main) {
  const args = Deno.args;
  const providerIdx = args.indexOf("--provider");
  if (providerIdx >= 0 && args[providerIdx + 1]) {
    Deno.env.set("COMPUTE_PROVIDER_CLI", args[providerIdx + 1]);
  }
  // also support -p
  const pIdx = args.indexOf("-p");
  if (pIdx >= 0 && args[pIdx + 1]) {
    Deno.env.set("COMPUTE_PROVIDER_CLI", args[pIdx + 1]);
  }

  const writeDidPlcToIdx = args.indexOf("--write-did-plc-to");
  const writeDidPlcTo = writeDidPlcToIdx >= 0 && args[writeDidPlcToIdx + 1]
    ? args[writeDidPlcToIdx + 1]
    : "";

  const bidder = await createEphemeralBidder({
    port: 0,
    label: "test-bidder",
  });

  // Wait for relay registration + offering creation so the requester
  // doesn't discover us and submit RFPs before we're ready to receive.
  await bidder.ready; // waits for relay + offering creation
  console.log(`    Bidder DID: ${bidder.did}`);
  console.log(`    Relay subdomain: ${bidder.relaySubdomain}`);
  console.log(`    Bidder proxyRef: ${bidder.proxyRef}`);

  // Write DID to file AFTER full readiness so the requester's
  // startBidderAndSetEnv poll doesn't return until we can receive RFPs.
  if (writeDidPlcTo) {
    await Deno.writeTextFile(writeDidPlcTo, bidder.did + "\n");
    console.log(JSON.stringify({ event: "bidder_did_written", path: writeDidPlcTo, did: bidder.did }));
  }
}
