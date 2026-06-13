/**
 * bidder-pds — lightweight atproto PDS that acts as a market bidder.
 *
 * Mounts submitRfp, submitAccept, and submitEvent handlers using repo-factory
 * primitives (no @atproto/api Agent, no PDS login). When DIGITALOCEAN_TOKEN +
 * RBAC_REPO_ROOT are set (via options or env), provisions real droplets on accept
 * and tears them down on vm.delete via the DigitalOcean compute provider — same
 * as ../bidder does.
 *
 * Without compute provider config, acts as a test-only bidder (no provisioning).
 *
 * Exports:
 *   createBidderPDS() — returns a running bidder with relay registration
 *
 * Usage (test):
 *   const bidder = await createBidderPDS({ port: 0 });
 *   const { proxyRef, did } = await bidder.ready;
 *   // … run contract flow, bidder.did goes in requester's extraBidderDids …
 *
 * Usage (with compute provider):
 *   const bidder = await createBidderPDS({
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
} from "@publicdomainrelay/lexicons";
import { TID } from "@atproto/common";
import { createComputeProviderDigitalOcean } from "@publicdomainrelay/compute-provider-digitalocean";
import type { StrongRef as ComputeProviderStrongRef } from "@publicdomainrelay/compute-provider-digitalocean";

// ── options ──────────────────────────────────────────────────────────

export interface ComputeProviderConfig {
  digitaloceanToken: string;
  digitaloceanBaseUrl?: string;
  rbacRepoRoot: string;
  acceptPathRecord?: string;
  acceptPathVm?: string;
}

export interface BidderPDSOptions {
  port?: number;
  privateKeyHex?: string;
  plcDirectoryUrl?: string;
  dispatcherHost?: string;
  label?: string;
  /** Compute provider config — when set, provisions real droplets on accept. */
  computeProvider?: ComputeProviderConfig;
}

/** receiptKey → active contract state */
export interface ActiveContract {
  dropletId?: number | string;
  rbacRef?: { uri: string; cid: string };
  acceptAuthor: string;
}

export interface BidderPDS {
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
 * Start a local container-mode OIDC issuer (../qemu/main.ts) and wait for
 * its relay-registered issuer URL.  Returns the did:web URL to use as the
 * DigitalOcean base URL (DO_BASE_URL).
 */
async function startContainerHost(): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "bidder-container-" });
  const issuerPath = `${tmpDir}/bidder-container-xrpc.txt`;

  const qemuMainPath = new URL("../qemu/main.ts", import.meta.url).pathname;

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

// ── createBidderPDS ──────────────────────────────────────────────────

export async function createBidderPDS(opts: BidderPDSOptions = {}): Promise<BidderPDS> {
  const PORT = opts.port ?? parseInt(Deno.env.get("PORT") ?? "0");
  const PRIVATE_KEY_HEX = opts.privateKeyHex ?? Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
  const PLC_DIRECTORY_URL = opts.plcDirectoryUrl ?? Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
  const DISPATCHER_HOST = opts.dispatcherHost ?? Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
  const BASE_ORIGIN = Deno.env.get("BASE_ORIGIN") ?? `http://localhost:${PORT}`;
  const LABEL = opts.label ?? "test-bidder-pds";

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
    // Create the offering record once relay is registered. We use api.applyWrites
    // directly (no Agent needed); the offering lives in the bidder's own repo.
    await ensureOffering(api, did);
    return info;
  });

  // ── contract tracking ───────────────────────────────────────────

  const activeContracts = new Map<string, ActiveContract>();

  // ── repo factory ────────────────────────────────────────────────

  const { app, subscribe, api } = createRepoFactory({
    storage: new MemoryStorage(),
    signer,
    baseOrigin: BASE_ORIGIN,
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
    let rbacRef: ComputeProviderStrongRef | undefined;
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
              rbacRef: ComputeProviderStrongRef;
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
            { $type: "com.atproto.repo.strongRef", uri: contract.rbacRef.uri, cid: contract.rbacRef.cid },
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
    stop: () => { relayController.stop(); serverController.abort(); },
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

// ── CLI main (when run directly) ──────────────────────────────────────

if (import.meta.main) {
  const writeDidPlcToIdx = Deno.args.indexOf("--write-did-plc-to");
  const writeDidPlcTo = writeDidPlcToIdx >= 0 && Deno.args[writeDidPlcToIdx + 1]
    ? Deno.args[writeDidPlcToIdx + 1]
    : "";

  const bidder = await createBidderPDS({
    port: 0,
    label: "test-bidder",
  });

  // Write DID to file before waiting for relay (DID is known after PLC registration).
  if (writeDidPlcTo) {
    await Deno.writeTextFile(writeDidPlcTo, bidder.did + "\n");
    console.log(JSON.stringify({ event: "bidder_did_written", path: writeDidPlcTo, did: bidder.did }));
  }

  const bidInfo = await bidder.ready; // waits for relay + offering creation
  bidder.proxyRef = bidInfo.proxyRef;
  bidder.relaySubdomain = bidInfo.subdomain;
  console.log(`    Bidder DID: ${bidder.did}`);
  console.log(`    Relay subdomain: ${bidInfo.subdomain}`);
  console.log(`    Bidder proxyRef: ${bidder.proxyRef}`);
}
