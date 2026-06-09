// Deno + Hono port of server.py.
// Endpoints: GET / (README html),
// GET /x402/receipt/<accepts.x402-at-uri>/<cid> (x402 payment-gated; mints a
//   com.publicdomainrelay.temp.market.receipts.x402 proof-of-payment record),
// POST /xrpc/com.publicdomainrelay.temp.market.submitAccept (atproto-proxy
// settlement; resolves accept->bid->rfp->vm, provisions droplet, writes receipt),
// POST /hook/rfp (firehose webhook -> creates bid+config+payload records).
//
// Run: deno run --allow-net --allow-env --allow-run --allow-read --allow-write main.ts
//
// $ RBAC_REPO_ROOT="${HOME}/src/rbac/homelab/wid-atp" X402_MAKE_FREE=1 DIGITALOCEAN_BASE_URL=https://homelab.johnandersen777.bsky.social.fedproxy.com deno run --allow-all --watch main.ts


import { Hono } from "npm:hono@^4.12.23";
import { HTTPError, registerErrorMiddleware } from "../lib/deno-hono-helpers/mod.ts";
import {
  createSubmitAcceptHandler,
  createSubmitEventHandler,
  createSubmitRfpHandler,
  type MarketServerDeps,
  type Accept,
  type Bid,
  type RFP,
  type StrongRef,
  ACCEPT_NSID,
  BID_NSID,
  DEFAULT_COMPUTE_EVENT_SERVICE_ID,
  DEFAULT_MARKET_SERVICE_ID,
  OFFERING_NSID,
  RECEIPT_NSID,
  SUBMIT_ACCEPT_NSID,
  SUBMIT_EVENT_NSID,
  SUBMIT_RFP_NSID,
} from "../lib/market/mod.ts";
import { createComputeEventDeleteHandler } from "../lib/compute/mod.ts";
import {
  type ComputeConfigWifSimple,
  type ComputeVM,
  COMPUTE_EVENTS_VM_DELETE_NSID,
  COMPUTE_VM_NSID,
} from "../lib/lexicons-compute/mod.ts";
import {
  type BidsX402,
  ACCEPTS_X402_NSID,
  BIDS_X402_NSID,
  RECEIPTS_X402_NSID,
} from "../lib/lexicons-market-x402/mod.ts";
import {
  agent,
  agentDid,
  atUriAuthority,
  idResolver,
  loginAgent,
  marketClient,
  ownServiceDidWeb,
  parseAtUri,
  resolveAs,
} from "../lib/atproto-helpers/misc.ts";

import { createComputeProviderDigitalOcean } from "../lib/compute-provider-digitalocean/mod.ts";
import { setupX402, x402UrlTemplate } from "./bids_x402.ts";

// ---------------------------------------------------------------------------
// NSID aliases — local names for ergonomics; canonical values come from
// the lexicons-* packages imported above.
// ---------------------------------------------------------------------------

const VM_NSID = COMPUTE_VM_NSID;
const VM_DELETE_EVENT_NSID = COMPUTE_EVENTS_VM_DELETE_NSID;
const MARKET_SERVICE_ID = DEFAULT_MARKET_SERVICE_ID;
const COMPUTE_EVENT_SERVICE_ID = DEFAULT_COMPUTE_EVENT_SERVICE_ID;

// Tracks active contracts: `${receiptUri}#${receiptCid}` -> provisioned
// resources. Set on submitAccept, cleared on vm.delete event.
type ActiveContract = { dropletId: number | string; rbacRef: StrongRef; acceptAuthor: string };
const activeContracts = new Map<string, ActiveContract>();

const CID_RE = /^(bafy|z)[A-Za-z0-9]+$/;

// ---------------------------------------------------------------------------
// Structured logger — JSON to stderr
// ---------------------------------------------------------------------------

import type { LogLevel } from "../lib/lexicons-market/mod.ts";

const enc = new TextEncoder();

function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  Deno.stderr.writeSync(enc.encode(entry + "\n"));
}

// ---------------------------------------------------------------------------
// local type aliases (resolved forms add _uri/_cid via resolveAs<T>)
// ---------------------------------------------------------------------------

type VM = ComputeVM;
type WIFSimple = ComputeConfigWifSimple;

// ---------------------------------------------------------------------------
// env / config
// ---------------------------------------------------------------------------

function reqEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) { console.error(`${name} is not set`); Deno.exit(1); }
  return v;
}

const cfg = {
  atproto: {
    handle:   reqEnv("ATPROTO_HANDLE"),
    password: reqEnv("ATPROTO_PASSWORD"),
  },
  server: {
    baseUrl: (Deno.env.get("BASE_URL") ?? "").replace(/\/+$/, ""),
    port:    Number(Deno.env.get("PORT") ?? 4021),
  },
  market: {
    [ACCEPTS_X402_NSID]: {
      payTo:           reqEnv("RECV_ADDR"),
      cdpApiKeyId:     reqEnv("CDP_RECV_API_KEY_ID"),
      cdpApiKeySecret: reqEnv("CDP_RECV_API_KEY_SECRET"),
      makeFree:        Deno.env.has("X402_MAKE_FREE"),
    },
  },
  compute: {
    providers: {
      [VM_NSID]: {
        digitalocean: {
          token:            reqEnv("DIGITALOCEAN_TOKEN"),
          baseUrl:          (Deno.env.get("DIGITALOCEAN_BASE_URL") ?? "https://droplet-oidc.its1337.com").replace(/\/+$/, ""),
          rbacRepoRoot:     (() => { const p = reqEnv("RBAC_REPO_ROOT"); try { return Deno.realPathSync(p); } catch { return p; } })(),
          acceptPathRecord: "$HOME/secrets/publicdomainrelay.com/market/accept.json",
          acceptPathVm:     "/root/secrets/publicdomainrelay.com/market/accept.json",
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// ATProto
// ---------------------------------------------------------------------------

// Ensure the bidder's own offering record exists for com.publicdomainrelay.temp.compute.vm.
// If none found, create one pointing to BASE_URL.
async function ensureOfferingRecord(): Promise<void> {
  const listRes = await agent.com.atproto.repo.listRecords({
    repo: agentDid,
    collection: OFFERING_NSID,
    limit: 100,
  });
  const existing = listRes.data.records.find((r) => {
    const value = r.value as Record<string, unknown>;
    const appliesTo = value.appliesTo as string[] | undefined;
    return Array.isArray(appliesTo) && appliesTo.includes(VM_NSID);
  });
  if (!cfg.server.baseUrl) {
    log("warn", "BASE_URL not set, skipping offering record creation");
    return;
  }
  const expectedEndpoint = `${ownServiceDidWeb(cfg.server.baseUrl)}#${MARKET_SERVICE_ID}`;
  if (existing) {
    const existingEndpoint = (existing.value as Record<string, unknown>).endpointUrl as string | undefined;
    if (existingEndpoint === expectedEndpoint) {
      log("info", "offering record exists", { uri: existing.uri });
      return;
    }
    // endpointUrl is stale (e.g. old service ID); update in place.
    const rkey = existing.uri.split("/").pop()!;
    await agent.com.atproto.repo.putRecord({
      repo: agent.assertDid,
      collection: OFFERING_NSID,
      rkey,
      record: {
        ...(existing.value as Record<string, unknown>),
        $type: OFFERING_NSID,
        endpointUrl: expectedEndpoint,
      },
    });
    log("info", "offering record updated", { uri: existing.uri, endpointUrl: expectedEndpoint });
    return;
  }
  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: OFFERING_NSID,
    record: {
      $type: OFFERING_NSID,
      endpointUrl: expectedEndpoint,
      appliesTo: [VM_NSID],
      createdAt: new Date().toISOString(),
    },
  });
  const ref = {
    $type: "com.atproto.repo.strongRef",
    uri: res.data.uri,
    cid: res.data.cid,
  };
  log("info", "offering record created", { ref });
}

// ---------------------------------------------------------------------------
// hono app
// ---------------------------------------------------------------------------

// Shared deps for the ../lib/market server handlers. We inject our existing
// resolveAs (so the version guard + HTTPError behavior is preserved) rather
// than the library's default resolver, and reuse the module-level idResolver
// for service-auth JWT verification. hostname is the host of our did:web.
const marketDeps: MarketServerDeps = {
  hostname: cfg.server.baseUrl ? new URL(cfg.server.baseUrl).host : "",
  idResolver,
  resolve: { resolve: <T>(ref: { uri: string; cid: string }) => resolveAs<T>(ref.uri, ref.cid) },
  log,
};

// DigitalOcean provisioning + RBAC backend. Wrapped behind getters since
// `agent`/`agentDid` are only assigned once loginAgent() resolves.
const {
  createBidConfig,
  createDroplet,
  deleteDroplet,
  deleteRbacRecord,
  configureAccountAuthRbac,
  injectAcceptBundle,
} = createComputeProviderDigitalOcean({
  getAgent: () => agent,
  getAgentDid: () => agentDid,
  log,
  acceptPathRecord: cfg.compute.providers[VM_NSID].digitalocean.acceptPathRecord,
  acceptPathVm:     cfg.compute.providers[VM_NSID].digitalocean.acceptPathVm,
  digitaloceanBaseUrl: cfg.compute.providers[VM_NSID].digitalocean.baseUrl,
  doToken:          cfg.compute.providers[VM_NSID].digitalocean.token,
  rbacRepoRoot:     cfg.compute.providers[VM_NSID].digitalocean.rbacRepoRoot,
  parseAtUri,
});

// ---------------------------------------------------------------------------
// POST /xrpc/com.publicdomainrelay.temp.market.submitAccept  { acceptUri, acceptCid }
//
// Settles the contract: resolves accept->bid->rfp->vm, provisions the
// resource, mints a market.receipt record, and returns a strongRef to it plus
// the bidder's submitEvent service DID reference. Must be called via PDS
// service-proxying (atproto-proxy); the receiver verifies the inter-service
// auth JWT and requires its issuer to be the DID that authored the referenced
// accept record.
// ---------------------------------------------------------------------------

// Auth (service-auth verification + "token issuer must author the accept
// record") and accept resolution are handled by ../lib/market; the onAccept
// callback below is the settlement logic that is specific to this bidder.
const marketSubmitAccept = createSubmitAcceptHandler({
  deps: marketDeps,
  serviceIds: [MARKET_SERVICE_ID],
  onAccept: async ({ acceptUri, acceptCid, accept }) => {
  console.error("[receipt] accept:", accept._uri);
  const bid = await resolveAs<Bid>(accept.bid.uri, accept.bid.cid);
  console.error("[receipt] bid:", bid._uri);

  if (bid.rfp.uri !== accept.rfp.uri || bid.rfp.cid !== accept.rfp.cid) {
    throw new HTTPError(400, "Accept.rfp does not match Bid.rfp");
  }

  // Verify payment: accept.payload must be a receipts.x402 proof-of-payment
  // record minted by us (this bidder) via the x402 receipt endpoint. Without it
  // we have no evidence the requester paid, so we refuse to provision.
  if (!accept.payload) throw new HTTPError(402, "Accept.payload (receipts.x402 proof-of-payment) is required");
  const paymentReceipt = await resolveAs<{ $type?: string }>(accept.payload.uri, accept.payload.cid);
  const paymentNsid = paymentReceipt.$type ?? accept.payload.uri.split("/")[3];
  if (paymentNsid !== RECEIPTS_X402_NSID) {
    throw new HTTPError(402, `Accept.payload must be a ${RECEIPTS_X402_NSID}, got ${paymentNsid}`);
  }
  if (atUriAuthority(accept.payload.uri) !== agent.assertDid) {
    throw new HTTPError(402, "Accept.payload proof-of-payment must be authored by this bidder");
  }
  log("info", "payment verified", { receiptsX402: accept.payload.uri });

  const rfp = await resolveAs<RFP>(accept.rfp.uri, accept.rfp.cid);
  const vm = await resolveAs<VM>(rfp.payload.uri, rfp.payload.cid);
  const bidPayload = await resolveAs<BidsX402>(bid.payload.uri, bid.payload.cid);
  let bidConfig: (WIFSimple & { _uri: string; _cid: string }) | null = null;
  if (bid.config) {
    bidConfig = await resolveAs<ComputeConfigWifSimple>(bid.config.uri, bid.config.cid);
  }

  const stripPriv = (o: Record<string, unknown>) => {
    const { _uri: _u, _cid: _c, ...rest } = o as Record<string, unknown> & { _uri?: string; _cid?: string };
    return rest;
  };

  const bundle = {
    $type: ACCEPT_NSID,
    accept: { uri: accept._uri, cid: accept._cid, value: stripPriv(accept as unknown as Record<string, unknown>) },
    rfp: { uri: rfp._uri, cid: rfp._cid, value: stripPriv(rfp as unknown as Record<string, unknown>) },
    bid: { uri: bid._uri, cid: bid._cid, value: stripPriv(bid as unknown as Record<string, unknown>) },
    bid_payload: { uri: bidPayload._uri, cid: bidPayload._cid, value: stripPriv(bidPayload as unknown as Record<string, unknown>) },
    bid_config: bidConfig
      ? { uri: bidConfig._uri, cid: bidConfig._cid, value: stripPriv(bidConfig as unknown as Record<string, unknown>) }
      : null,
    vm: { uri: vm._uri, cid: vm._cid, value: stripPriv(vm as unknown as Record<string, unknown>) },
  };

  vm.user_data = injectAcceptBundle(vm.user_data, bundle);

  const { repo: requesterDid } = parseAtUri(accept._uri);
  // TODO retry droplet creation on failure
  const { json: dropletJson, rbacRef } = await createDroplet(vm, requesterDid) as { json: { droplet?: { id?: number | string } }; rbacRef: StrongRef };
  const dropletId = dropletJson.droplet?.id;

  // The bidder treats the VM as a black box — it has no visibility into the
  // policy engine running inside it. The requester is the one watching the VM
  // come up and the workflow run to completion, so it reports back via
  // submitEvent (compute.events.vm.delete) when the droplet should be torn
  // down — either because the workflow finished or the policy engine never
  // came up. submitEventUrl is handed back below so the caller knows where to
  // send those events, keyed by a strongRef to this receipt.
  const submitEventUrl = `${ownServiceDidWeb(cfg.server.baseUrl)}#${COMPUTE_EVENT_SERVICE_ID}`;

  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: RECEIPT_NSID,
    record: {
      $type: RECEIPT_NSID,
      rfp: { $type: "com.atproto.repo.strongRef", uri: accept.rfp.uri, cid: accept.rfp.cid },
      bid: { $type: "com.atproto.repo.strongRef", uri: bid._uri, cid: bid._cid },
      accept: { $type: "com.atproto.repo.strongRef", uri: acceptUri, cid: acceptCid },
      payload: { $type: "com.atproto.repo.strongRef", uri: accept.payload.uri, cid: accept.payload.cid },
      submitEvent: submitEventUrl,
      createdAt: new Date().toISOString(),
    },
  });

  const id = res.data.uri.split("/").slice(-1)[0];

  if (dropletId !== undefined) {
    const receiptKey = `${res.data.uri}#${res.data.cid}`;
    // requesterDid is the authority of the accept AT-URI — only this DID may
    // later drive a vm.delete that tears down this droplet.
    activeContracts.set(receiptKey, { dropletId, rbacRef, acceptAuthor: requesterDid });
    log("info", "tracking droplet for receipt", {
      receiptKey,
      receiptUri: res.data.uri,
      receiptCid: res.data.cid,
      dropletId,
      rbacUri: rbacRef.uri,
      rbacCid: rbacRef.cid,
      acceptAuthor: requesterDid,
      activeContractsSize: activeContracts.size,
    });
  } else {
    log("warn", "no droplet id returned, cannot map receipt to droplet for cleanup", { dropletJson });
  }

    return { body: { id, uri: res.data.uri, cid: res.data.cid, submitEvent: submitEventUrl } };
  },
});

// ---------------------------------------------------------------------------
// Shared bid-creation logic used by /hook/rfp and /xrpc/…submitRfp.
// ---------------------------------------------------------------------------

async function createAndSubmitBid(
  rfpUri: string,
  rfpCid: string,
  rfpRecord: RFP,
  receiptUrl: string,
): Promise<{ configUri: string; configCid: string; payloadUri: string; payloadCid: string; bidUri: string; bidCid: string }> {
  const nowIso = new Date().toISOString();
  const configRef = await createBidConfig(nowIso);

  const payloadRecord = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: BIDS_X402_NSID,
    record: {
      $type: BIDS_X402_NSID,
      cost: 1,
      currency: "USDC",
      frequency: "monthly",
      prepay: true,
      url: receiptUrl,
      createdAt: nowIso,
    },
  });

  const bid = {
    $type: BID_NSID,
    rfp: { $type: "com.atproto.repo.strongRef", uri: rfpUri, cid: rfpCid },
    config: { $type: "com.atproto.repo.strongRef", uri: configRef.uri, cid: configRef.cid },
    payload: { $type: "com.atproto.repo.strongRef", uri: payloadRecord.data.uri, cid: payloadRecord.data.cid },
    // Service DID ref for the settlement leg (submitAccept via atproto-proxy),
    // distinct from the payload's x402 payment url (the payment leg).
    submitAccept: `${ownServiceDidWeb(cfg.server.baseUrl)}#${MARKET_SERVICE_ID}`,
    createdAt: nowIso,
  };

  const bidRecord = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: BID_NSID,
    record: bid,
  });

  log("info", "bidRecord", { bidRecord: bidRecord });

  if (rfpRecord.submitBid) {
    // rfpRecord.submitBid is a service DID ref (did:web:HOST#pdr_temp_market).
    // Route the call through our PDS via atproto-proxy instead of raw fetch.
    try {
      await marketClient.submitBid(rfpRecord.submitBid, {
        uri: bidRecord.data.uri,
        cid: bidRecord.data.cid,
        record: bid,
      });
      log("info", "submitBid proxied call", { ref: rfpRecord.submitBid });
    } catch (err) {
      log("warn", "submitBid proxied call failed", { ref: rfpRecord.submitBid, err: String(err) });
    }
  }

  return {
    configUri: configRef.uri,
    configCid: configRef.cid,
    payloadUri: payloadRecord.data.uri,
    payloadCid: payloadRecord.data.cid,
    bidUri: bidRecord.data.uri,
    bidCid: bidRecord.data.cid,
  };
}

const marketSubmitRfp = createSubmitRfpHandler({
  deps: marketDeps,
  callbacks: {
    [MARKET_SERVICE_ID]: {
      [VM_NSID]: async ({ rfpUri, rfpCid, rfp, req }) => {
        const { repo: rfpOwnerDid } = parseAtUri(rfpUri);

        const { bidUri, bidCid } =
          await createAndSubmitBid(rfpUri, rfpCid, rfp, x402UrlTemplate(cfg.server.baseUrl, req.url));

        log("info", "bid created via submitRfp", { bidUri, rfpUri, rfpOwnerDid });

        return { body: { ok: true, bidUri, bidCid } };
      },
    },
  },
});


const marketSubmitEvent = createSubmitEventHandler({
  deps: marketDeps,
  // Reached via the requester's accept/receipt submitEvent ref
  // (did:web:HOST#pdr_temp_compute_event).
  // Synchronous (not background) so the "unknown receipt"/authorization errors
  // below surface in the HTTP response, matching the previous behavior.
  callbacks: {
    [COMPUTE_EVENT_SERVICE_ID]: {
      [VM_DELETE_EVENT_NSID]: createComputeEventDeleteHandler({
        assertRunningCompute: ({ event, log }) => {
          const receiptKey = `${event.receipt.uri}#${event.receipt.cid}`;
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
          const receiptKey = `${event.receipt.uri}#${event.receipt.cid}`;
          const reason = deleteEvent.reason ?? "vm.delete event received";
          const contract = activeContracts.get(receiptKey)!;
          await deleteDroplet(contract.dropletId, reason);
          log("info", "submitEvent: deleting rbac record for receipt", { receiptKey, rbacUri: contract.rbacRef.uri });
          await deleteRbacRecord(contract.rbacRef, reason);
          activeContracts.delete(receiptKey);
          return { body: { ok: true } };
        },
      }),
    },
  },
});


const makeApp = () => {
  const app = new Hono();

  registerErrorMiddleware(app);

  const readmeHtml = "<html><body><h1>compute-contract-provider-relay-digitalocean</h1></body></html>";
  app.get("/", (c) => c.html(readmeHtml));

  // did:web document exposing the `pdr_temp_market` and `pdr_temp_compute_event` service
  // entries. The bidder only RECEIVES service-auth tokens (no signing key needed).
  app.get("/.well-known/did.json", (c) => {
    if (!cfg.server.baseUrl) return c.json({ error: "NotFound", message: "BASE_URL not configured" }, 404);
    const host = new URL(cfg.server.baseUrl).host;
    return c.json({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: `did:web:${host}`,
      service: [
        { id: `#${MARKET_SERVICE_ID}`, type: "PDRTempMarket", serviceEndpoint: `https://${host}` },
        { id: `#${COMPUTE_EVENT_SERVICE_ID}`, type: "PDRTempComputeEvent", serviceEndpoint: `https://${host}` },
      ],
    });
  });

  // Configure market flow routes
  app.post(`/xrpc/${SUBMIT_RFP_NSID}`, (c) => marketSubmitRfp(c.req.raw));
  // accepts.x402 for payments (will not require payment if X402_MAKE_FREE=1)
  const x402Cfg = cfg.market[ACCEPTS_X402_NSID];
  setupX402(x402Cfg.makeFree, {
    app,
    getAgent: () => agent,
    log,
    baseUrl: cfg.server.baseUrl,
    payTo: x402Cfg.payTo,
    cdpApiKeyId: x402Cfg.cdpApiKeyId,
    cdpApiKeySecret: x402Cfg.cdpApiKeySecret,
    acceptsX402Nsid: ACCEPTS_X402_NSID,
    receiptsX402Nsid: RECEIPTS_X402_NSID,
    cidRe: CID_RE,
    resolveAs,
    httpError: HTTPError,
  });
  app.post(`/xrpc/${SUBMIT_ACCEPT_NSID}`, (c) => marketSubmitAccept(c.req.raw));
  app.post(`/xrpc/${SUBMIT_EVENT_NSID}`, (c) => marketSubmitEvent(c.req.raw));

  return app;
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async () => {
  await loginAgent(cfg.atproto.handle, cfg.atproto.password);
  await configureAccountAuthRbac();
  await ensureOfferingRecord();
  const app = makeApp();
  const { port } = cfg.server;
  Deno.serve({ port, hostname: "0.0.0.0", onListen: ({ port, hostname }) => {
    console.error(`[server] listening on http://${hostname}:${port}`);
  } }, app.fetch);
};

await main();
