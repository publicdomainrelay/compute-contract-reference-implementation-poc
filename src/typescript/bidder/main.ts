// Deno + Hono reference bidder for the com.publicdomainrelay.temp.market.*
// protocol. Endpoints:
//   GET  /                                          (README html)
//   GET  /.well-known/did.json                      (did:web service entries)
//   GET  /<settlement receipt endpoint>/*           (mints the accept payload;
//                                                     x402 = paid, free = open)
//   POST /xrpc/…market.submitRfp                     (bid on an incoming RFP)
//   POST /xrpc/…market.submitAccept                  (settle: provision + receipt)
//   POST /xrpc/…market.submitEvent                   (vm.delete teardown)
//
// How a contract settles (paying via x402, or granting for free) is chosen at
// startup behind the Settlement abstraction (@publicdomainrelay/market-settlement); the provisioning
// logic below never branches on it.
//
// Run: deno run --allow-net --allow-env --allow-run --allow-read --allow-write main.ts
//
// $ SETTLEMENT=free COMPUTE_PROVIDER=local deno run --allow-all --watch main.ts

import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerErrorMiddleware } from "@publicdomainrelay/deno-hono-helpers";
import {
  type MarketServerDeps,
  type LogLevel,
  type RecordResolver,
  type Resolved,
  type StrongRef,
  ACCEPT_NSID,
  DEFAULT_COMPUTE_EVENT_SERVICE_ID,
  DEFAULT_MARKET_SERVICE_ID,
  type RecordSigner,
  attestationVerificationMethod,
  createReceiptRecord,
  ensureOfferingRecord,
  createBidFactory,
  createMarketClient,
  type MarketClient,
  loadOrGenerateKeypair,
  refKey,
  resolveContractGraph,
  resolvedRef,
  stripResolved,
} from "@publicdomainrelay/market";
import { loadOrCreateAttestationKeyHex } from "@publicdomainrelay/utils-attestation-key";
import { createLogger, runWithLogContext } from "@publicdomainrelay/utils-log";
import { createMarketFactory } from "@publicdomainrelay/hono-factory-market";
import { createMarketBidsFactory } from "@publicdomainrelay/hono-factory-market-bids";
import { createComputeFactory } from "@publicdomainrelay/hono-factory-compute";
import {
  type ComputeVM,
  COMPUTE_VM_NSID,
} from "@publicdomainrelay/lexicons";
import {
  agent,
  agentDid,
  idResolver,
  loginAgent,
  session,
  ownServiceDidWeb,
  parseAtUri,
  resolveAs,
} from "@publicdomainrelay/atproto-helpers";
import type { ComputeProvider, ComputeProviderMode } from "@publicdomainrelay/compute-provider";
import { computeProviderModeFromEnv, dropletSpecFromEnv, reqEnv as cpReqEnv, optUrl as cpOptUrl } from "@publicdomainrelay/compute-provider";
import { createLocalComputeProvider } from "@publicdomainrelay/compute-provider-local";
import { createDigitalOceanComputeProvider } from "@publicdomainrelay/compute-provider-digitalocean";
import { reqEnv, optUrl } from "./env.ts";
import {
  type SettlementCtx,
  settlementModeFromEnv,
  createFreeSettlement,
  createX402Settlement,
} from "@publicdomainrelay/market-settlement";

// ---------------------------------------------------------------------------
// NSID aliases — local names for ergonomics; canonical values come from the
// lexicons-* packages imported above.
// ---------------------------------------------------------------------------

const VM_NSID = COMPUTE_VM_NSID;
const MARKET_SERVICE_ID = DEFAULT_MARKET_SERVICE_ID;
const COMPUTE_EVENT_SERVICE_ID = DEFAULT_COMPUTE_EVENT_SERVICE_ID;

// Tracks active contracts: `${receiptUri}#${receiptCid}` -> provisioned
// resources. Set on submitAccept, cleared on vm.delete event.
type ActiveContract = { providerId: string | number; acceptAuthor: string };
const activeContracts = new Map<string, ActiveContract>();

// ---------------------------------------------------------------------------
// Structured logger — JSON to stderr
// ---------------------------------------------------------------------------

// actorDid resolves to the bidder's own DID (agentDid), assigned once
// loginAgent() resolves — read lazily so early lines still pick it up. The
// onBehalfOfDid (the market.accept / RFP author) is bound per request via
// runWithLogContext in the handlers below.
const log = createLogger({ service: "bidder", selfDid: () => agentDid });

// local type alias (resolved forms add _uri/_cid via resolveAs<T>)
type VM = ComputeVM;

// ---------------------------------------------------------------------------
// env / config
// ---------------------------------------------------------------------------

const cfg = {
  atproto: {
    handle:   reqEnv("ATPROTO_HANDLE"),
    password: reqEnv("ATPROTO_PASSWORD"),
  },
  server: {
    baseUrl: optUrl("BASE_URL"),
    port:    Number(Deno.env.get("PORT") ?? 4021),
  },
  compute: {
    mode: computeProviderModeFromEnv(),
    token: Deno.env.get("COMPUTE_PROVIDER_TOKEN") ?? Deno.env.get("DIGITALOCEAN_TOKEN") ?? "",
    baseUrl: Deno.env.get("COMPUTE_PROVIDER_BASE_URL") ?? Deno.env.get("DIGITALOCEAN_BASE_URL") ?? "",
    spec: dropletSpecFromEnv(),
    /** RBAC repo root for DO provider (git-backed policy repo). */
    rbacRepoRoot: Deno.env.get("RBAC_REPO_ROOT") ?? "",
    /** Path inside VM for accept bundle (cloud-init write_files). */
    acceptPathVm: Deno.env.get("ACCEPT_PATH_VM") ?? "/root/secrets/publicdomainrelay.com/market/accept.json",
  },
} as const;

// ---------------------------------------------------------------------------
// ATProto
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// shared deps
// ---------------------------------------------------------------------------

// Strong-ref resolver shared by the market handlers and the settlement layer.
// We inject our own resolveAs (preserving its version guard + HTTPError
// behavior) rather than the library's default resolver.
const recordResolver: RecordResolver = {
  resolve: <T>(ref: { uri: string; cid: string }) => resolveAs<T>(ref.uri, ref.cid),
};

// Shared deps for the ../lib/market server handlers. hostname is the host of our
// did:web; idResolver is reused for service-auth JWT verification.
const marketDeps: MarketServerDeps = {
  hostname: cfg.server.baseUrl ? new URL(cfg.server.baseUrl).host : "",
  idResolver,
  resolve: recordResolver,
  // Require inbound rfp/accept/event signatures to bind to their author's DID
  // document (the bidder publishes its own attestation key in its did:web doc;
  // the requester publishes in theirs). The signing key is stable + file-backed
  // (see main()), so binding holds across restarts.
  bindKeys: true,
  log,
};

// Settlement layer (x402 = paid, free = no-cost). Chosen once at startup; the
// rest of the bidder is settlement-agnostic. getAgent is a getter because
// `agent` is only assigned once loginAgent() resolves.
// The bidder's badge.blue attestation identity. The keypair is loaded in main()
// from ATTESTATION_PRIVATE_KEY_HEX (or generated, which won't survive restarts);
// getSigner is a getter so the module-level factories can capture it before it
// is assigned, mirroring how `agent` is wired.
let attestationSigner: RecordSigner;
const getSigner = (): RecordSigner => attestationSigner;

// A signer-bound MarketClient for the bidder's outbound submitBid. Built in
// main() once the session + signer exist; the bid factory reads it via a getter
// (it is undefined until login completes, mirroring how `agent` is wired).
let bidderMarketClient: MarketClient;

const settlementCtx: SettlementCtx = {
  getAgent: () => agent,
  resolve: recordResolver,
  getSigner,
  log,
  baseUrl: cfg.server.baseUrl,
};
const settlement = settlementModeFromEnv() === "free"
  ? createFreeSettlement(settlementCtx)
  : createX402Settlement(settlementCtx);

// Compute provider — wraps local or digitalocean backend behind the
// ComputeProvider interface selected by COMPUTE_PROVIDER env var.
const computeProvider: ComputeProvider = (() => {
  const logCp = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => log(level, msg, fields);
  const createRecord = async (collection: string, record: Record<string, unknown>): Promise<StrongRef> => {
    const res = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection,
      record,
    });
    return { $type: "com.atproto.repo.strongRef", uri: res.data.uri, cid: res.data.cid };
  };

  if (cfg.compute.mode === "digitalocean") {
    const doToken = cfg.compute.token || reqEnv("DIGITALOCEAN_TOKEN");
    const doBaseUrl = cfg.compute.baseUrl || reqEnv("DIGITALOCEAN_BASE_URL");
    const rbacRoot = cfg.compute.rbacRepoRoot || reqEnv("RBAC_REPO_ROOT");
    return createDigitalOceanComputeProvider({
      getAgent: () => agent,
      getAgentDid: () => agentDid,
      log: logCp,
      parseAtUri,
      digitaloceanBaseUrl: doBaseUrl,
      doToken,
      rbacRepoRoot: rbacRoot,
      acceptPathVm: cfg.compute.acceptPathVm || "/root/secrets/publicdomainrelay.com/market/accept.json",
    });
  }
  // default: local — the provider owns its workload-identity OIDC issuer
  // (/v1/oidc/{issue,prove}). We serve it over plain HTTP on ISSUER_PORT
  // (fronted publicly by Caddy at ISSUER_URL = mini-cloud-0001.fedfork.com)
  // instead of the fedproxy XRPC relay, so provisioned VMs reach prove/issue
  // at a stable public hostname. setup() (called in main) starts that server.
  return createLocalComputeProvider({
    log: logCp,
    parseAtUri,
    createRecord,
    getAgentDid: () => agentDid,
    getIssuerUrl: () => Deno.env.get("ISSUER_URL") ?? "",
    serveHttp: true,
    xrpcRelay: false,
  });
})();

// ---------------------------------------------------------------------------
// Hono factories — market (submitRfp + submitAccept), market-bids (receipt
// endpoints), compute (submitEvent / vm.delete). Each produces a sub-app
// that makeApp mounts via app.route('/').
// ---------------------------------------------------------------------------

const createAndSubmitBid = createBidFactory({
  createBidConfig: computeProvider.createBidConfig,
  getMarketClient: () => bidderMarketClient,
  submitAcceptServiceDid: `${ownServiceDidWeb(cfg.server.baseUrl)}#${MARKET_SERVICE_ID}`,
  log,
});

const marketFactory = createMarketFactory(marketDeps, {
  rfp: {
    [MARKET_SERVICE_ID]: {
      [VM_NSID]: async ({ rfpUri, rfpCid, rfp, req }) => {
        const { repo: rfpOwnerDid } = parseAtUri(rfpUri);
        // This bid is created on behalf of the RFP author — bind it so every
        // nested log line names whose request we're serving.
        return await runWithLogContext({ onBehalfOfDid: rfpOwnerDid }, async () => {
          // TODO Vouch checking: the bidder currently bids on any RFP that reaches
          // it. Verify the RFP author (rfpOwnerDid) is vouched for before bidding —
          // resolve their PDS, list sh.tangled.graph.vouch records, require a vouch
          // (kind !== "denounce") from a trusted account. Gate behind
          // DO_NO_REQUIRE_VOUCH=1 (set => bypass, mirroring spindle/marketRFP.ts).
          const { bidUri, bidCid } = await createAndSubmitBid(rfpUri, rfpCid, rfp, settlement, req.url);
          log("info", "bid created via submitRfp", { bidUri, rfpUri, rfpOwnerDid });
          return { body: { ok: true, bidUri, bidCid } };
        });
      },
    },
  },
  accept: {
    serviceIds: [MARKET_SERVICE_ID],
    onAccept: async ({ acceptUri, acceptCid, accept, resolve }) => {
    // The accept's repo authority is the principal we provision on behalf of.
    // Bind it up front so every nested log line (including the provisioning
    // calls) names whose accept drove the work.
    const { repo: requesterDid } = parseAtUri(accept._uri);
    return await runWithLogContext({ onBehalfOfDid: requesterDid }, async () => {
    log("info", "settling accept", { accept: accept._uri });

    // Resolve the full contract record graph (bid, rfp, their payloads/config)
    // and verify the bid and accept name the same RFP. resolveContractGraph also
    // verifies the bid's and rfp's inline signatures (canonical CID recomputed in
    // each author's repo) — the bidder's verification of the requester's RFP
    // signature, and of the winning bid, before provisioning.
    const { bid, rfp, rfpPayload, bidPayload, bidConfig } = await resolveContractGraph(accept, resolve);
    const vm = rfpPayload as unknown as Resolved<VM>;

    // Verify settlement: accept.payload must be the receipt our settlement layer
    // issued (proof of payment for x402, proof of grant for free). Without it we
    // have no evidence the contract is settled, so we refuse to provision.
    await settlement.verifyAcceptPayload(accept.payload);
    const payloadRef = accept.payload;

    // Provenance bundle written into the VM so it can verify what it was
    // provisioned for. Reuses ACCEPT_NSID as the $type; each entry is the
    // referenced record's strongRef coordinates plus its value.
    const bundle = {
      $type: ACCEPT_NSID,
      accept: resolvedRef(accept),
      rfp: resolvedRef(rfp),
      bid: resolvedRef(bid),
      bid_payload: resolvedRef(bidPayload),
      bid_config: bidConfig ? resolvedRef(bidConfig) : null,
      vm: resolvedRef(vm),
    };

    vm.user_data = computeProvider.injectAcceptBundle(vm.user_data, bundle);

    const result = await computeProvider.provision(vm, requesterDid, cfg.compute.spec);
    const providerId = result.providerId;

    // The bidder treats the VM as a black box. The requester watches it come up
    // and reports back via submitEvent (compute.events.vm.delete) when the
    // droplet should be torn down. submitEventUrl is handed back below so the
    // caller knows where to send those events, keyed by a strongRef to this receipt.
    const submitEventUrl = `${ownServiceDidWeb(cfg.server.baseUrl)}#${COMPUTE_EVENT_SERVICE_ID}`;

    const receiptRef = await createReceiptRecord(
      agent,
      {
        rfp: accept.rfp,
        bid: { uri: bid._uri, cid: bid._cid },
        accept: { uri: acceptUri, cid: acceptCid },
        payload: payloadRef,
        submitEvent: submitEventUrl,
      },
      { acceptRecord: stripResolved(accept) as Record<string, unknown>, acceptRepositoryDid: requesterDid },
      getSigner(),
    );

    const id = receiptRef.uri.split("/").slice(-1)[0];

    if (providerId !== undefined && providerId !== 0) {
      const receiptKey = refKey(receiptRef);
      activeContracts.set(receiptKey, { providerId, acceptAuthor: requesterDid });
      log("info", "tracking compute for receipt", {
        receiptKey, receiptUri: receiptRef.uri, receiptCid: receiptRef.cid,
        providerId, acceptAuthor: requesterDid, activeContractsSize: activeContracts.size,
      });
    } else {
      log("warn", "no provider id returned, cannot map receipt to compute for cleanup", { providerId });
    }

    return { body: { id, uri: receiptRef.uri, cid: receiptRef.cid, submitEvent: submitEventUrl } };
    });
    },
  },
});

// Compute factory — submitEvent pre-wired for vm.delete dispatch.
// Synchronous (not background) so "unknown receipt"/auth errors surface in the response.
const computeFactory = createComputeFactory({
  deps: marketDeps,
  serviceId: COMPUTE_EVENT_SERVICE_ID,
  vmDelete: {
    assertRunningCompute: ({ event, log }) => {
      const receiptKey = refKey(event.receipt);
      log("info", "submitEvent: resolved receiptKey", {
        receiptKey,
        knownReceiptKeys: [...activeContracts.keys()],
      });
      if (!activeContracts.has(receiptKey)) {
        log("warn", "submitEvent: no active contract for receipt", { receiptKey, receipt: event.receipt });
        return { status: 400, body: { error: "InvalidRequest", message: "unknown receipt" } };
      }
    },
    deleteRunningCompute: async ({ event, log, deleteEvent }) => {
      const receiptKey = refKey(event.receipt);
      const contract = activeContracts.get(receiptKey)!;
      return await runWithLogContext({ onBehalfOfDid: contract.acceptAuthor }, async () => {
        await computeProvider.destroy(contract.providerId);
        activeContracts.delete(receiptKey);
        return { body: { ok: true } };
      });
    },
  },
});

// Market-bids factory — receipt endpoints (free grant or x402 payment).
// Mode is chosen once at startup by settlement; the rest of the app is agnostic.
const bidsFactory = createMarketBidsFactory(settlement.bidsFactoryOptions());

// ---------------------------------------------------------------------------
// hono app
// ---------------------------------------------------------------------------

const makeApp = () => {
  const app = new Hono();
  registerErrorMiddleware(app);
  app.use('*', cors());

  const readmeHtml = "<html><body><h1>compute-contract-provider-bidder</h1></body></html>";
  app.get("/", (c) => c.html(readmeHtml));

  // did:web document exposing the `pdr_temp_market` and `pdr_temp_compute_event`
  // service entries. The bidder only RECEIVES service-auth tokens (no signing key).
  app.get("/.well-known/did.json", (c) => {
    if (!cfg.server.baseUrl) return c.json({ error: "NotFound", message: "BASE_URL not configured" }, 404);
    const host = new URL(cfg.server.baseUrl).host;
    const did = `did:web:${host}`;
    return c.json({
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      // Publishes the bidder's badge.blue attestation key so verifiers can bind
      // the inline signatures on its bids/receipts to this did:web (the `issuer`).
      verificationMethod: [attestationVerificationMethod(did, attestationSigner.keypair.did())],
      service: [
        { id: `#${MARKET_SERVICE_ID}`, type: "PDRTempMarket", serviceEndpoint: `https://${host}` },
        { id: `#${COMPUTE_EVENT_SERVICE_ID}`, type: "PDRTempComputeEvent", serviceEndpoint: `https://${host}` },
      ],
    });
  });

  // Market XRPC procedures, bid receipt endpoints, and compute event dispatch.
  app.route("/", marketFactory.createApp());
  app.route("/", bidsFactory.createApp());
  app.route("/", computeFactory.createApp());

  return app;
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async () => {
  await loginAgent(cfg.atproto.handle, cfg.atproto.password);
  // Stable, file-backed attestation key (env override wins): persisted as
  // bidder/attestation.jwk so the same did:key is published in our did:web doc and
  // reused across restarts — required for the bindKeys cross-verification above.
  const keyHex = Deno.env.get("ATTESTATION_PRIVATE_KEY_HEX") ??
    await loadOrCreateAttestationKeyHex(new URL("./attestation.jwk", import.meta.url));
  const keypair = await loadOrGenerateKeypair(keyHex);
  attestationSigner = {
    keypair,
    issuer: cfg.server.baseUrl ? ownServiceDidWeb(cfg.server.baseUrl) : agentDid,
  };
  log("info", "attestation keypair loaded", { key: keypair.did(), issuer: attestationSigner.issuer });
  // Signer-bound client for outbound submitBid: signs + writes + forwards the bid.
  bidderMarketClient = createMarketClient(session, { agent, signer: attestationSigner, log });
  if (computeProvider.setup) await computeProvider.setup();
  if (cfg.server.baseUrl) {
    const expectedEndpoint = `${ownServiceDidWeb(cfg.server.baseUrl)}#${MARKET_SERVICE_ID}`;
    await ensureOfferingRecord(agent, [VM_NSID], expectedEndpoint, log);
  } else {
    log("warn", "BASE_URL not set, skipping offering record creation");
  }
  const app = makeApp();
  const { port } = cfg.server;
  Deno.serve({ port, hostname: "0.0.0.0", onListen: ({ port, hostname }) => {
    log("info", "server listening", { url: `http://${hostname}:${port}`, settlement: settlement.mode });
  } }, app.fetch);
};

await main();
