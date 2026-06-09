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
import { stringify as yamlStringify, parse as yamlParse } from "npm:yaml@^2.7.0";
import { HTTPError, registerErrorMiddleware } from "../lib/deno-hono-helpers/mod.ts";
import {
  createSubmitAcceptHandler,
  createSubmitEventHandler,
  createSubmitRfpHandler,
  type MarketServerDeps,
} from "../lib/market/mod.ts";
import { createComputeEventDeleteHandler } from "../lib/compute/mod.ts";
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

import { createComputeProviderDigitalOcean } from "./compute_provider_digitalocean.ts";
import { setupX402, x402UrlTemplate } from "./bids_x402.ts";

// ---------------------------------------------------------------------------
// NSID constants (mirrors models/publicdomainrelay.py)
// ---------------------------------------------------------------------------

const VM_NSID = "com.publicdomainrelay.temp.compute.vm";
const WIF_SIMPLE_NSID = "com.publicdomainrelay.temp.compute.config.wif.simple";
const RFP_NSID = "com.publicdomainrelay.temp.market.rfp";
const BID_NSID = "com.publicdomainrelay.temp.market.bid";
const BIDS_X402_NSID = "com.publicdomainrelay.temp.market.bids.x402";
const ACCEPTS_X402_NSID = "com.publicdomainrelay.temp.market.accepts.x402";
const RECEIPTS_X402_NSID = "com.publicdomainrelay.temp.market.receipts.x402";
const ACCEPT_NSID = "com.publicdomainrelay.temp.market.accept";
const RECEIPT_NSID = "com.publicdomainrelay.temp.market.receipt";
const OFFERING_NSID = "com.publicdomainrelay.temp.market.offering";
const SUBMIT_EVENT_NSID = "com.publicdomainrelay.temp.market.submitEvent";
const SUBMIT_ACCEPT_NSID = "com.publicdomainrelay.temp.market.submitAccept";
const SUBMIT_RFP_NSID = "com.publicdomainrelay.temp.market.submitRfp";
const VM_DELETE_EVENT_NSID = "com.publicdomainrelay.temp.compute.events.vm.delete";
const RBAC_NSID = "com.fedproxy.rbac";

// atproto-proxy market service: the bidder exposes a `pdr_temp_market` service entry
// in its did:web document; service DID refs take the form `did:web:HOST#pdr_temp_market`.
const MARKET_SERVICE_ID = "pdr_temp_market";
// Compute-contract event service: the bidder exposes a separate `pdr_temp_compute_event`
// service entry; submitEvent refs take the form `did:web:HOST#pdr_temp_compute_event`.
const COMPUTE_EVENT_SERVICE_ID = "pdr_temp_compute_event";

// Maps `${receiptUri}#${receiptCid}` -> DigitalOcean droplet id, so that when
// the requester reports a com.publicdomainrelay.temp.compute.events.vm.delete
// event (workflow finished, or the policy engine never came up — things only
// the requester can observe, since the bidder treats VMs as a black box) we
// know which droplet to tear down.
const receiptDroplets = new Map<string, number | string>();
// Tracks the com.fedproxy.rbac record minted for each droplet's receipt, so we
// can remove it when the droplet is torn down (mirrors receiptDroplets).
const receiptRbacRecords = new Map<string, StrongRef>();
// Maps `${receiptUri}#${receiptCid}` -> the DID that issued the market.accept
// settling this contract (the authority of the accept AT-URI). Only this DID is
// permitted to drive a vm.delete that tears down the receipt's droplet.
const receiptAcceptAuthors = new Map<string, string>();

const ACCEPT_PATH_RECORD = "$HOME/secrets/publicdomainrelay.com/market/accept.json";
const ACCEPT_PATH_VM = "/root/secrets/publicdomainrelay.com/market/accept.json";

const CID_RE = /^(bafy|z)[A-Za-z0-9]+$/;

// ---------------------------------------------------------------------------
// Structured logger — JSON to stderr
// ---------------------------------------------------------------------------

type LogLevel = "info" | "warn" | "error" | "debug";

const enc = new TextEncoder();

function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  Deno.stderr.writeSync(enc.encode(entry + "\n"));
}

// JSON.stringify with object keys sorted, so structurally-equal records compare
// equal regardless of the key order the PDS returns them in.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// types (loose — these are wire-shape, not strict pydantic validators)
// ---------------------------------------------------------------------------

type StrongRef = { $type: "com.atproto.repo.strongRef"; uri: string; cid: string };

type VM = {
  cpus: number;
  mem: string;
  disk: string;
  network: string;
  role: string;
  user_data: string;
  location?: { country?: string; region?: string };
  _uri?: string;
  _cid?: string;
};

type RFP = { payload: StrongRef; submitBid?: string; _uri?: string; _cid?: string };
type Bid = { rfp: StrongRef; payload: StrongRef; config?: StrongRef; _uri?: string; _cid?: string };
type Accept = { rfp: StrongRef; bid: StrongRef; payload?: StrongRef; submitEvent?: string; _uri?: string; _cid?: string };
type Event = { receipt: StrongRef; payload: StrongRef; _uri?: string; _cid?: string };
type VMDeleteEvent = { reason: string; _uri?: string; _cid?: string };
type BidsX402 = { cost: unknown; currency: string; frequency: string; prepay: boolean; url: string; _uri?: string; _cid?: string };
type AcceptsX402 = { bid: StrongRef; payload?: StrongRef; _uri?: string; _cid?: string };
type WIFSimple = Record<string, unknown> & { _uri?: string; _cid?: string };

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

function reqEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) { console.error(`${name} is not set`); Deno.exit(1); }
  return v;
}

const PAY_TO = reqEnv("RECV_ADDR");
const CDP_API_KEY_ID = reqEnv("CDP_RECV_API_KEY_ID");
const CDP_API_KEY_SECRET = reqEnv("CDP_RECV_API_KEY_SECRET");
const DO_TOKEN = reqEnv("DIGITALOCEAN_TOKEN");
const RBAC_REPO_ROOT = (() => {
  const p = reqEnv("RBAC_REPO_ROOT");
  try { return Deno.realPathSync(p); } catch { return p; }
})();
const BASE_URL = (Deno.env.get("BASE_URL") ?? "").replace(/\/+$/, "");
const ATPROTO_HANDLE = reqEnv("ATPROTO_HANDLE");
const ATPROTO_PASSWORD = reqEnv("ATPROTO_PASSWORD");
const X402_MAKE_FREE = Deno.env.has("X402_MAKE_FREE");
const DIGITALOCEAN_BASE_URL = (Deno.env.get("DIGITALOCEAN_BASE_URL") ?? "https://droplet-oidc.its1337.com").replace(/\/+$/, "");

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
  if (existing) {
    log("info", "offering record exists", { uri: existing.uri });
    return;
  }
  if (!BASE_URL) {
    log("warn", "BASE_URL not set, skipping offering record creation");
    return;
  }
  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: OFFERING_NSID,
    record: {
      $type: OFFERING_NSID,
      endpointUrl: `${ownServiceDidWeb(BASE_URL)}#${MARKET_SERVICE_ID}`,
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
  hostname: BASE_URL ? new URL(BASE_URL).host : "",
  idResolver,
  resolve: { resolve: <T>(ref: { uri: string; cid: string }) => resolveAs<T>(ref.uri, ref.cid) },
  log,
};

// DigitalOcean provisioning + RBAC backend. Wrapped behind getters since
// `agent`/`agentDid` are only assigned once loginAgent() resolves.
const {
  makeDoctx,
  createDroplet,
  deleteDroplet,
  deleteRbacRecord,
  configureAccountAuthRbac,
  injectAcceptBundle,
} = createComputeProviderDigitalOcean({
  getAgent: () => agent,
  getAgentDid: () => agentDid,
  log,
  rbacNsid: RBAC_NSID,
  acceptPathVm: ACCEPT_PATH_VM,
  digitaloceanBaseUrl: DIGITALOCEAN_BASE_URL,
  doToken: DO_TOKEN,
  rbacRepoRoot: RBAC_REPO_ROOT,
  parseAtUri,
  canonicalJson,
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
    bidConfig = await resolveAs<WIFSimple>(bid.config.uri, bid.config.cid);
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
  const submitEventUrl = `${ownServiceDidWeb(BASE_URL)}#${COMPUTE_EVENT_SERVICE_ID}`;

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
    receiptDroplets.set(receiptKey, dropletId);
    receiptRbacRecords.set(receiptKey, rbacRef);
    // requesterDid is the authority of the accept AT-URI, i.e. the DID that
    // issued the market.accept settling this contract. Record it so that only
    // that DID can later drive a vm.delete tearing down this droplet.
    receiptAcceptAuthors.set(receiptKey, requesterDid);
    log("info", "tracking droplet for receipt", {
      receiptKey,
      receiptUri: res.data.uri,
      receiptCid: res.data.cid,
      dropletId,
      rbacUri: rbacRef.uri,
      rbacCid: rbacRef.cid,
      acceptAuthor: requesterDid,
      receiptDropletsSize: receiptDroplets.size,
      receiptRbacRecordsSize: receiptRbacRecords.size,
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
  const doctx = await makeDoctx();

  const configRecord = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: WIF_SIMPLE_NSID,
    record: {
      $type: WIF_SIMPLE_NSID,
      accept_path: ACCEPT_PATH_RECORD,
      issuer_uri: `${DIGITALOCEAN_BASE_URL}`,
      to_issue: "exchange-custom-droplet-oidc-poc",
      actx: doctx.teamUuid,
      actx_path: "/root/secrets/digitalocean.com/serviceaccount/team_uuid",
      token_path: "/root/secrets/digitalocean.com/serviceaccount/token",
      url_path: "/root/secrets/digitalocean.com/serviceaccount/base_url",
      url_route: "/v1/oidc/issue",
      subject: "actx:{actx}:plc:{did-plc-key}:role:{role}",
      createdAt: nowIso,
    },
  });

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
    config: { $type: "com.atproto.repo.strongRef", uri: configRecord.data.uri, cid: configRecord.data.cid },
    payload: { $type: "com.atproto.repo.strongRef", uri: payloadRecord.data.uri, cid: payloadRecord.data.cid },
    // Service DID ref for the settlement leg (submitAccept via atproto-proxy),
    // distinct from the payload's x402 payment url (the payment leg).
    submitAccept: `${ownServiceDidWeb(BASE_URL)}#${MARKET_SERVICE_ID}`,
    createdAt: nowIso,
  };

  const bidRecord = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: BID_NSID,
    record: bid,
  });

  log("info", "bidRecord", { bidRecord: bidRecord });

  if (rfpRecord.submitBid) {
    // rfpRecord.submitBid is now a service DID ref (did:web:HOST#pdr_temp_market).
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
    configUri: configRecord.data.uri,
    configCid: configRecord.data.cid,
    payloadUri: payloadRecord.data.uri,
    payloadCid: payloadRecord.data.cid,
    bidUri: bidRecord.data.uri,
    bidCid: bidRecord.data.cid,
  };
}

const marketSubmitRfp = createSubmitRfpHandler({
  deps: marketDeps,
  serviceIds: [MARKET_SERVICE_ID],
  onRfp: async ({ rfpUri, rfpCid, rfp, payloadNsid, req }) => {
    // Check that our offering covers the RFP payload type — best-effort.
    const listRes = await agent.com.atproto.repo.listRecords({ repo: agentDid, collection: OFFERING_NSID, limit: 100 });
    const applicable = listRes.data.records.some((r) => {
      const v = r.value as Record<string, unknown>;
      const appliesTo = v.appliesTo as string[] | undefined;
      return Array.isArray(appliesTo) && (appliesTo.includes(payloadNsid) || appliesTo.includes(VM_NSID));
    });
    if (!applicable) {
      log("info", "submitRfp not applicable", { rfpUri, payloadNsid });
      return { status: 400, body: { error: "NotApplicable", message: `no offering for ${payloadNsid}` } };
    }

    const { repo: rfpOwnerDid } = parseAtUri(rfpUri);

    const { bidUri, bidCid } =
      await createAndSubmitBid(rfpUri, rfpCid, rfp, x402UrlTemplate(BASE_URL, req.url));

    log("info", "bid created via submitRfp", { bidUri, rfpUri, rfpOwnerDid });

    return { body: { ok: true, bidUri, bidCid } };
  },
});


const marketSubmitEvent = createSubmitEventHandler({
  deps: marketDeps,
  // Reached via the requester's accept/receipt submitEvent ref
  // (did:web:HOST#pdr_temp_compute_event).
  serviceIds: [COMPUTE_EVENT_SERVICE_ID],
  // Synchronous (not background) so the "unknown receipt"/authorization errors
  // below surface in the HTTP response, matching the previous behavior.
  callbacks: {
    [COMPUTE_EVENT_SERVICE_ID]: {
      [VM_DELETE_EVENT_NSID]: createComputeEventDeleteHandler({
        assertRunningCompute: ({ event, log }) => {
          const receiptKey = `${event.receipt.uri}#${event.receipt.cid}`;
          log("info", "submitEvent: resolved receiptKey", {
            receiptKey,
            knownDropletReceiptKeys: [...receiptDroplets.keys()],
            knownRbacReceiptKeys: [...receiptRbacRecords.keys()],
          });
          const dropletId = receiptDroplets.get(receiptKey);
          if (dropletId === undefined) {
            log("warn", "submitEvent: no droplet tracked for receipt", { receiptKey, receipt: event.receipt });
            return { status: 400, body: { error: "InvalidRequest", message: "unknown receipt" } };
          }
        },
        deleteRunningCompute: async ({ event, log, deleteEvent }) => {
          const receiptKey = `${event.receipt.uri}#${event.receipt.cid}`;
          const reason = deleteEvent.reason ?? "vm.delete event received";
          const dropletId = receiptDroplets.get(receiptKey)!;
          await deleteDroplet(dropletId, reason);
          receiptDroplets.delete(receiptKey);
          receiptAcceptAuthors.delete(receiptKey);

          const rbacRef = receiptRbacRecords.get(receiptKey);
          if (rbacRef) {
            log("info", "submitEvent: rbac record found for receipt, deleting", { receiptKey, rbacUri: rbacRef.uri, rbacCid: rbacRef.cid });
            await deleteRbacRecord(rbacRef, reason);
            receiptRbacRecords.delete(receiptKey);
          } else {
            log("warn", "submitEvent: no rbac record tracked for receipt, skipping cleanup", {
              receiptKey,
              receiptRbacRecordsSize: receiptRbacRecords.size,
              knownRbacReceiptKeys: [...receiptRbacRecords.keys()],
            });
          }
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
    if (!BASE_URL) return c.json({ error: "NotFound", message: "BASE_URL not configured" }, 404);
    const host = new URL(BASE_URL).host;
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
  setupX402(X402_MAKE_FREE, {
    app,
    getAgent: () => agent,
    log,
    baseUrl: BASE_URL,
    payTo: PAY_TO,
    cdpApiKeyId: CDP_API_KEY_ID,
    cdpApiKeySecret: CDP_API_KEY_SECRET,
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
  void VM_NSID; // referenced for parity / future use
  await loginAgent(ATPROTO_HANDLE, ATPROTO_PASSWORD);
  await configureAccountAuthRbac();
  await ensureOfferingRecord();
  const app = makeApp();
  const port = Number(Deno.env.get("PORT") ?? 4021);
  Deno.serve({ port, hostname: "0.0.0.0", onListen: ({ port, hostname }) => {
    console.error(`[server] listening on http://${hostname}:${port}`);
  } }, app.fetch);
};

await main();
