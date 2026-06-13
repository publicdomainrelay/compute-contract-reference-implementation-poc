/**
 * ephemeral-compute-bidder — lightweight atproto PDS that acts as a market
 * bidder with compute provider (DigitalOcean + RBAC), registry registration,
 * and discovery/heartbeat support.
 *
 * Mounts submitRfp, submitAccept, and submitEvent handlers using repo-factory
 * primitives (no @atproto/api Agent, no PDS login). When DIGITALOCEAN_TOKEN +
 * RBAC_REPO_ROOT are set (via options or env), provisions real droplets on
 * accept and tears them down on vm.delete via the DigitalOcean compute
 * provider.
 *
 * Without compute provider config, acts as a test-only bidder (no provisioning).
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
 * Usage (with compute provider):
 *   const bidder = await createEphemeralBidder({
 *     port: 0,
 *     computeProvider: {
 *       digitaloceanToken: "...",
 *       digitaloceanBaseUrl: "https://mini-cloud-0001.fedfork.com",
 *       rbacRepoRoot: "/path/to/rbac/repo",
 *     },
 *   });
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
import { createComputeProviderDigitalOcean } from "@publicdomainrelay/compute-provider-digitalocean";
import type { StrongRef } from "@publicdomainrelay/compute-provider-digitalocean";
import { createAttestationCid, type RecordMap } from "@atiproto/atproto-attestation";

// ── options ──────────────────────────────────────────────────────────

export interface ComputeProviderConfig {
  digitaloceanToken: string;
  digitaloceanBaseUrl?: string;
  rbacRepoRoot: string;
  acceptPathRecord?: string;
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
  dropletId?: number | string;
  rbacRef?: { uri: string; cid: string };
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

/**
 * Start a local container-mode OIDC issuer (../../qemu/main.ts) and wait for
 * its relay-registered issuer URL.  Returns the did:web URL to use as the
 * DigitalOcean base URL (DO_BASE_URL).
 */
async function startContainerHost(): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "bidder-container-" });
  const issuerPath = `${tmpDir}/bidder-container-xrpc.txt`;

  const qemuMainPath = new URL("../../qemu/main.ts", import.meta.url).pathname;

  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", qemuMainPath, "--write-xrpc-relay-generated-issuer-to", issuerPath],
    env: { ...Deno.env.toObject(), CONTAINER_MODE: "true" },
    stdout: "inherit",
    stderr: "inherit",
  });
  cmd.spawn(); // fire-and-forget: the qemu server keeps running

  // Poll the file until the relay registration writes the issuer URL.
  const deadline = Date.now() + 60_000;
  let url = "";
  while (!url && Date.now() < deadline) {
    try {
      const content = await Deno.readTextFile(issuerPath);
      url = content.trim();
    } catch {
      // File not written yet
    }
    if (!url) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (!url) {
    throw new Error("Container host did not write issuer URL within 60s");
  }

  console.log(JSON.stringify({ event: "container_host_ready", url, issuerPath }));
  return url;
}

/**
 * Build a minimal Agent-shaped adapter so the compute provider can issue
 * service-auth tokens via signServiceAuth and manage repo records via the
 * repo-factory API — no @atproto/api Agent or PDS login needed.
 */
function createAgentAdapter(
  api: ReturnType<typeof createRepoFactory>["api"],
  signer: Signer,
  did: string,
) {
  return {
    assertDid: did,
    com: {
      atproto: {
        server: {
          getServiceAuth: async ({ aud, exp }: { aud: string; exp: number }) => {
            const expiresInSec = Math.max(1, exp - Math.floor(Date.now() / 1000));
            const token = await signServiceAuth(signer, { aud, expiresInSec });
            return { data: { token } };
          },
        },
        repo: {
          createRecord: async (
            { repo, collection, record }: { repo: string; collection: string; record: Record<string, unknown> },
          ) => {
            const rkey = TID.next().toString();
            await api.applyWrites(repo, [{ action: "create", collection, rkey, record }]);
            const rec = await api.getRecord(repo, collection, rkey);
            return { data: { uri: `at://${repo}/${collection}/${rkey}`, cid: rec?.cid ?? "" } };
          },
          deleteRecord: async (
            { repo, collection, rkey }: { repo: string; collection: string; rkey: string },
          ) => {
            await api.applyWrites(repo, [{ action: "delete", collection, rkey }]);
            return { success: true };
          },
          listRecords: async (
            { repo, collection, limit }: { repo: string; collection: string; limit?: number },
          ) => {
            const res = await api.listRecords(repo, collection, { limit: limit ?? 100 });
            return { data: res };
          },
        },
      },
    },
  };
}

// ── createEphemeralBidder ─────────────────────────────────────────────

export async function createEphemeralBidder(opts: EphemeralBidderOptions = {}): Promise<EphemeralBidder> {
  const PRIVATE_KEY_HEX = opts.privateKeyHex ?? Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
  const PLC_DIRECTORY_URL = opts.plcDirectoryUrl ?? Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
  const DISPATCHER_HOST = opts.dispatcherHost ?? Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
  const LABEL = opts.label ?? "ephemeral-bidder";
  const REGISTRY_ENDPOINT = opts.registryEndpoint ?? Deno.env.get("REGISTRY_ENDPOINT") ?? "";
  const HEARTBEAT_INTERVAL_MS = opts.heartbeatIntervalMs ?? parseInt(Deno.env.get("HEARTBEAT_INTERVAL_MS") ?? "60000");

  // ── compute provider config ─────────────────────────────────────
  const cpCfg = opts.computeProvider;
  const DO_TOKEN = cpCfg?.digitaloceanToken ?? Deno.env.get("DIGITALOCEAN_TOKEN") ?? "";
  const START_CONTAINER_HOST = Deno.env.get("START_CONTAINER_HOST") === "true";
  const DO_BASE_URL = START_CONTAINER_HOST
    ? await startContainerHost()
    : (cpCfg?.digitaloceanBaseUrl ?? Deno.env.get("DIGITALOCEAN_BASE_URL") ?? "https://droplet-oidc.its1337.com");
  const RBAC_REPO_ROOT = cpCfg?.rbacRepoRoot ?? (() => {
    const p = Deno.env.get("RBAC_REPO_ROOT") ?? "";
    try { return Deno.realPathSync(p); } catch { return p; }
  })();
  const ACCEPT_PATH_RECORD = cpCfg?.acceptPathRecord ?? Deno.env.get("ACCEPT_PATH_RECORD") ?? "$HOME/secrets/publicdomainrelay.com/market/accept.json";
  const ACCEPT_PATH_VM = cpCfg?.acceptPathVm ?? Deno.env.get("ACCEPT_PATH_VM") ?? "/root/secrets/publicdomainrelay.com/market/accept.json";
  const HAS_COMPUTE_PROVIDER = !!(DO_TOKEN && RBAC_REPO_ROOT);

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
    // Ensure account-auth RBAC record exists before handling contracts.
    await _cpReady;
    // Create the offering record once relay is registered.
    await ensureOffering(api, did);
    // Create initial discovery record in own repo.
    await ensureDiscoveryRecord();
    // Register with the registry after offering is in place.
    await registerWithRegistry();
    return info;
  });

  // ── contract tracking ───────────────────────────────────────────

  const activeContracts = new Map<string, ActiveContract>();

  // ── repo factory ────────────────────────────────────────────────

  const { app, subscribe, api } = createRepoFactory({
    storage: new MemoryStorage(),
    signer,
    baseOrigin: `https://${keypair.did().replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
  });

  // ── compute provider (DigitalOcean + RBAC) ──────────────────────
  // When DIGITALOCEAN_TOKEN + RBAC_REPO_ROOT are set, provision real
  // droplets on accept and tear them down on vm.delete.
  const computeProvider = HAS_COMPUTE_PROVIDER
    ? createComputeProviderDigitalOcean({
        getAgent: () => agentAdapter as any,
        getAgentDid: () => did,
        log: (level, msg, fields) => logInfo({ label: LABEL, severity: level, message: msg, ...(fields ?? {}) }),
        acceptPathRecord: ACCEPT_PATH_RECORD,
        acceptPathVm: ACCEPT_PATH_VM,
        digitaloceanBaseUrl: DO_BASE_URL,
        doToken: DO_TOKEN,
        rbacRepoRoot: RBAC_REPO_ROOT,
        parseAtUri,
      })
    : null;
  const agentAdapter = createAgentAdapter(api, signer, did);
  // configureAccountAuthRbac must run before the first createDroplet call.
  // In test mode (no provider) this is a no-op.
  const _cpReady = computeProvider
    ? computeProvider.configureAccountAuthRbac().then(() => logInfo({ event: "bidder_compute_provider_ready", did }))
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

    // 1. Create bid config (DigitalOcean OIDC exchange params) if compute provider is wired.
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

    // Provision a real droplet if compute provider is wired.
    // Resolve chain: accept.rfp → RFP record → .payload → compute.vm record.
    let dropletId: number | string | undefined;
    let rbacRef: StrongRef | undefined;
    if (computeProvider && rfpRef) {
      try {
        const resolve = createRecordResolver(idResolver);
        // Step 1: resolve the RFP record to get its payload ref (the compute.vm record).
        const rfpResolved = await resolve.resolve({ uri: rfpRef.uri, cid: rfpRef.cid });
        const rfpRecord = rfpResolved as Record<string, unknown> | null;
        const vmRef = rfpRecord?.payload as { uri: string; cid: string } | undefined;
        if (vmRef) {
          // Step 2: resolve the compute.vm record.
          const vmResolved = await resolve.resolve({ uri: vmRef.uri, cid: vmRef.cid });
          const vm = vmResolved as Record<string, unknown> | null;
          if (vm) {
            // injectAcceptBundle adds contract provenance to the VM's user_data.
            const bundle = {
              $type: "com.publicdomainrelay.temp.market.accept",
              accept: { uri: acceptUri, cid: acceptCid },
              rfp: { uri: rfpRef.uri, cid: rfpRef.cid },
              bid: bidRef ? { uri: bidRef.uri, cid: bidRef.cid } : null,
            };
            const vmWithBundle = {
              ...vm,
              user_data: computeProvider.injectAcceptBundle((vm.user_data as string) ?? "", bundle),
              _uri: vmRef.uri,
              _cid: vmRef.cid,
            };
            const result = await computeProvider.createDroplet(vmWithBundle as any, issuerDid) as {
              json: { droplet?: { id?: number | string } };
              rbacRef: StrongRef;
            };
            dropletId = result.json.droplet?.id;
            rbacRef = result.rbacRef;
            cbLog("info", "bidder provisioned droplet", { dropletId, rbacUri: rbacRef.uri });
          }
        }
      } catch (err) {
        cbLog("error", "bidder failed to provision droplet", { error: String(err) });
        return { status: 500, body: { error: "ProvisioningFailed", message: String(err) } };
      }
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
      dropletId,
      rbacRef: rbacRef ? { uri: rbacRef.uri, cid: rbacRef.cid } : undefined,
      acceptAuthor: issuerDid,
    });

    cbLog("info", "bidder created receipt", {
      receiptUri, receiptCid,
      acceptAuthor: issuerDid,
      dropletId,
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
      if (contract.dropletId !== undefined) {
        try {
          await computeProvider.deleteDroplet(contract.dropletId, reason);
          ctx.log("info", "submitEvent: droplet deleted", { dropletId: contract.dropletId, reason });
        } catch (err) {
          ctx.log("error", "submitEvent: failed to delete droplet", { dropletId: contract.dropletId, error: String(err) });
        }
      }
      if (contract.rbacRef) {
        try {
          await computeProvider.deleteRbacRecord(
            { $type: "com.atproto.repo.strongRef", uri: contract.rbacRef.uri, cid: contract.rbacRef.cid } as StrongRef,
            reason,
          );
          ctx.log("info", "submitEvent: rbac record deleted", { rbacUri: contract.rbacRef.uri, reason });
        } catch (err) {
          ctx.log("error", "submitEvent: failed to delete rbac record", { rbacUri: contract.rbacRef.uri, error: String(err) });
        }
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
    },
    attestationKp,
    activeContracts,
  };
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
