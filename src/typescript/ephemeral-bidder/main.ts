/**
 * ephemeral-bidder — lightweight atproto PDS that acts as a market bidder
 * with registry registration and heartbeat support.
 *
 * Follows the EXACT pattern of xrpc-relay-pds/bidder-pds.ts but adds:
 *   - Registry registration (registerBidder XRPC call)
 *   - Periodic heartbeat (bidderHeartbeat XRPC call)
 *
 * Exports:
 *   createEphemeralBidder() — returns a running bidder with relay + registry
 *
 * Usage:
 *   const bidder = await createEphemeralBidder({ port: 0 });
 *   const { proxyRef, did } = await bidder.ready;
 *   // … run contract flow …
 *   bidder.stop();
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

// ── options ──────────────────────────────────────────────────────────

export interface EphemeralBidderOptions {
  port?: number;
  privateKeyHex?: string;
  plcDirectoryUrl?: string;
  dispatcherHost?: string;
  label?: string;
  registryEndpoint?: string;
  heartbeatIntervalMs?: number;
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
  /** receiptKey → { acceptAuthor }. */
  activeContracts: Map<string, { acceptAuthor: string }>;
}

// ── internal helpers ─────────────────────────────────────────────────

function refKey(ref: { uri: string; cid: string }): string {
  return `${ref.uri}#${ref.cid}`;
}

// ── createEphemeralBidder ────────────────────────────────────────────

export async function createEphemeralBidder(opts: EphemeralBidderOptions = {}): Promise<EphemeralBidder> {
  const PORT = opts.port ?? parseInt(Deno.env.get("PORT") ?? "0");
  const PRIVATE_KEY_HEX = opts.privateKeyHex ?? Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
  const PLC_DIRECTORY_URL = opts.plcDirectoryUrl ?? Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
  const DISPATCHER_HOST = opts.dispatcherHost ?? Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
  const BASE_ORIGIN = Deno.env.get("BASE_ORIGIN") ?? `http://localhost:${PORT}`;
  const LABEL = opts.label ?? "ephemeral-bidder";
  const REGISTRY_ENDPOINT = opts.registryEndpoint ?? Deno.env.get("REGISTRY_ENDPOINT") ?? "";
  const HEARTBEAT_INTERVAL_MS = opts.heartbeatIntervalMs ?? parseInt(Deno.env.get("HEARTBEAT_INTERVAL_MS") ?? "60000");

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

  const ready = relayReady.then(async (info) => {
    // Create the offering record once relay is registered.
    await ensureOffering(api, did);
    // Create initial discovery record in own repo.
    await ensureDiscoveryRecord();
    // Register with the registry after offering is in place.
    await registerWithRegistry();
    return info;
  });

  // ── contract tracking ───────────────────────────────────────────

  const activeContracts = new Map<string, { acceptAuthor: string }>();

  // ── repo factory ────────────────────────────────────────────────

  const { app, subscribe, api } = createRepoFactory({
    storage: new MemoryStorage(),
    signer,
    baseOrigin: BASE_ORIGIN,
  });

  // ── record helpers (same pattern as bidder-pds) ─────────────────

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
    const intervalMs = HEARTBEAT_INTERVAL_MS; // reuse same env var
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
    if (!REGISTRY_ENDPOINT) {
      logInfo({ event: "registry_disabled", reason: "no REGISTRY_ENDPOINT configured" });
      return;
    }

    const body = {
      bidderDid: did,
      appliesTo: [COMPUTE_VM_NSID],
    };

    try {
      const res = await callService(REGISTRY_ENDPOINT, REGISTER_BIDDER_NSID, REGISTER_BIDDER_NSID, body);
      if (res.ok) {
        logInfo({ event: "registered_with_registry" });
        startDiscoveryUpdater();
      } else {
        logInfo({ event: "register_with_registry_error", status: res.status, body: res.body });
      }
    } catch (err) {
      logInfo({ event: "register_with_registry_exception", err: String(err) });
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

    // 1. Create bid payload (minimal test payload — "free" settlement).
    const { uri: payloadUri, cid: payloadCid } = await createRepoRecord(
      "com.publicdomainrelay.temp.market.bids.free",
      { $type: "com.publicdomainrelay.temp.market.bids.free", cost: 0, createdAt: nowIso },
    );

    // 2. Create signed bid record.
    const bidRecord = {
      $type: BID_NSID,
      rfp: strongRef(rfpUri, rfpCid),
      payload: strongRef(payloadUri, payloadCid),
      // Where the requester should send the accept.
      submitAccept: `${did}#pdr_temp_market`,
      createdAt: nowIso,
    };
    const { uri: bidUri, cid: bidCid } = await createSignedRepoRecord(BID_NSID, bidRecord, relayProxyRef);

    cbLog("info", "bidder created bid", { bidUri, bidCid, payloadUri });

    // 3. Submit signed bid to the requester's submitBid endpoint.
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

    // Create a signed receipt in the bidder's repo.
    const receiptRecord = {
      $type: RECEIPT_NSID,
      rfp: rfpRef ? strongRef(rfpRef.uri, rfpRef.cid) : null,
      bid: bidRef ? strongRef(bidRef.uri, bidRef.cid) : null,
      accept: strongRef(acceptUri, acceptCid),
      payload: null as unknown,  // no settlement payload for test
      submitEvent: `${did}#pdr_temp_compute_event`,
      createdAt: nowIso,
    };
    const { uri: receiptUri, cid: receiptCid } = await createSignedRepoRecord(
      RECEIPT_NSID, receiptRecord, relayProxyRef,
    );

    // Track the contract so submitEvent can look it up later.
    const rkey = receiptUri.split("/").pop()!;
    activeContracts.set(refKey({ uri: receiptUri, cid: receiptCid }), {
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

  // ── HTTP server ─────────────────────────────────────────────────

  const serverController = new AbortController();
  Deno.serve({ port: PORT, signal: serverController.signal }, app.fetch);

  logInfo({ event: "bidder_listening", port: PORT, did });

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

  return {
    did,
    signer,
    keypair,
    api,
    app,
    proxyRef: relayProxyRef,
    relaySubdomain,
    ready,
    stop: () => {
      stopDiscoveryUpdater();
      relayController.stop();
      serverController.abort();
    },
    attestationKp,
    activeContracts,
  };
}

// ── standalone entry ──────────────────────────────────────────────────

if (import.meta.main) {
  const bidder = await createEphemeralBidder();
  await bidder.ready;
  console.log(JSON.stringify({ event: "bidder_ready", did: bidder.did, proxyRef: bidder.proxyRef }));
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
