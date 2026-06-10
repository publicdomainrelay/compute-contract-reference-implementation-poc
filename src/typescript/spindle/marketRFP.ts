// marketRFP.ts — ATProto market RFP compute provider for tangled-spindle-minimal
//
// When COMPUTE_PROVIDER=market.rfp, this module handles workflow submission by:
//   Generating a random service name: policy-engine-${hex}
//   Building cloud-init user_data that pulls + starts the policy-engine binary
//   Creating compute.vm + market.rfp ATProto records
//   Discovering vouched bidders via repo owner + knot collaborator vouches (sh.tangled.graph.vouch)
//   Calling submitRfp on each vouched bidder whose offering covers com.publicdomainrelay.temp.compute.vm
//   Listening for bids on the jetstream (bid window)
//   Accepting the winning bid
//   Creating com.fedproxy.rbac to authorize the VM's DID to register its SSH key
//   Submitting the accept bundle to the bidder (x402 receipt endpoint)
//   Watching jetstream for com.fedproxy.sshPublicKey with the generated service name
//   Polling the fedproxy URL until the policy engine is ready
//   Forwarding the workflow submission to the remote policy engine
//
// Env vars (all optional except ATPROTO_HANDLE + ATPROTO_PASSWORD):
//   ATPROTO_PDS_URL         PDS base URL (default: https://bsky.social)
//   ATPROTO_HANDLE          ATProto handle (e.g. alice.bsky.social)
//   ATPROTO_PASSWORD        ATProto password
//   FEDPROXY_HOST           Fedproxy host for PE URLs (default: fedproxy.com)
//   JETSTREAM_URL           Jetstream websocket base URL
//   VM_CPUS                 VM CPU count (default: 2)
//   VM_MEM                  VM memory (default: 4G)
//   VM_DISK                 VM disk (default: 40G)
//   VM_NETWORK              VM network (default: 500G)
//   VM_LOCATION_COUNTRY     VM location country (default: USA)
//   VM_LOCATION_REGION      VM location region (default: west)
//   VM_ROLE                 VM role label (default: policy-engine)
//   BID_WINDOW_MS           How long to wait for bids (default: 30000)
//   VM_READY_TIMEOUT_MS     How long to wait for VM to register (default: 600000)
//   PE_READY_TIMEOUT_MS     How long to wait for PE to respond (default: 120000)

import { Agent, CredentialSession } from "npm:@atproto/api";
import { IdResolver } from "npm:@atproto/identity";
import {
  createMarketClient,
  createRecord as atprotoCreateRecord,
  createSignedRecord,
  deleteRecord as atprotoDeleteRecord,
  listRecordsAll,
  loadOrGenerateKeypair,
  type MarketClient,
  type RecordSigner,
  resolvePds,
  type StrongRef,
  verifyRecordSignatures,
  ACCEPT_NSID,
  BID_NSID,
  DEFAULT_COMPUTE_EVENT_SERVICE_ID,
  DEFAULT_MARKET_SERVICE_ID,
  EVENT_NSID,
  OFFERING_NSID,
  RECEIPT_NSID,
  RFP_NSID,
  type Bid,
} from "@publicdomainrelay/market";
import { BIDS_X402_NSID, settleX402Payment } from "@publicdomainrelay/market-x402";
import { BIDS_FREE_NSID } from "@publicdomainrelay/market-free";
import {
  COMPUTE_EVENTS_VM_DELETE_NSID,
  COMPUTE_VM_NSID,
} from "@publicdomainrelay/lexicons";

// ---------------------------------------------------------------------------
// NSID aliases
// ---------------------------------------------------------------------------

const VM_NSID = COMPUTE_VM_NSID;
const VM_DELETE_EVENT_NSID = COMPUTE_EVENTS_VM_DELETE_NSID;
const MARKET_SERVICE_ID = DEFAULT_MARKET_SERVICE_ID;
const COMPUTE_EVENT_SERVICE_ID = DEFAULT_COMPUTE_EVENT_SERVICE_ID;
const RBAC_NSID   = "com.fedproxy.rbac";
const SSH_KEY_NSID = "com.fedproxy.sshPublicKey";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// BidRecord is the canonical Bid type with an explicit $type discriminant,
// re-exported for spindle consumers.
export type BidRecord = Bid & { $type: string };

type CollectedBid = {
  did: string;
  uri: string;
  cid: string;
  record: BidRecord;
  payload?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

// Per-RFP queue for bids submitted directly via HTTP (submitBid endpoint).
// Keyed by rfp AT-URI. Spindle's XRPC route pushes here; collectBidsForRfp drains it.
export const pendingBids: Map<string, CollectedBid[]> = new Map();

export interface MarketRFPConfig {
  pdsUrl: string;
  handle: string;
  password: string;
  atpRelayUrl: string;
  fedproxyHost: string;
  jetstreamUrl: string;
  vm: {
    cpus: number;
    mem: string;
    disk: string;
    network: string;
    role: string;
    location: { country: string; region: string };
  };
  bidWindowMs: number;
  vmReadyTimeoutMs: number;
  peReadyTimeoutMs: number;
}

export interface MarketRFPResult {
  taskId: string;
  peUrl: string;
  // Reports a compute.events.vm.delete event to the provider's submitEvent
  // endpoint (workflow finished, or — when called from the catch around
  // waitForPolicyEngine — the policy engine never came up). The provider
  // can't see either condition itself since it treats the VM as a black box.
  reportVmDelete: (reason: string) => Promise<void>;
}

export interface PolicyEngineRequest {
  workflow: unknown;
  context: Record<string, unknown>;
  inputs?: Record<string, string>;
}

export interface PolicyEngineStatus {
  status: "submitted" | "in_progress" | "complete" | "unknown" | "input_validation_error";
  detail: { id: string; exit_status?: string; [k: string]: unknown };
  console_output?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomHex(bytes = 8): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

type RFPLogger = (msg: string, fields?: Record<string, unknown>) => void;

function makeLogger(onLog?: (line: string) => void): RFPLogger {
  return (msg: string, fields: Record<string, unknown> = {}): void => {
    const entry = JSON.stringify({ ts: new Date().toISOString(), level: "info", component: "market-rfp", msg, ...fields });
    const enc = new TextEncoder();
    Deno.stderr.writeSync(enc.encode(entry + "\n"));
    onLog?.(entry);
  };
}

// Identity resolver shared by PDS lookups. createRecord / deleteRecord /
// listRecordsAll are imported from ../lib/market (aliased to the names this
// module has always used); resolvePDS just wraps the library's resolvePds.
const idResolver = new IdResolver();

function resolvePDS(did: string): Promise<string> {
  return resolvePds(idResolver, did);
}

// Validates a URL before egressing to it (the x402 payment endpoint comes from
// a winning bid's bids.x402 payload — untrusted). Blocks non-http(s) schemes
// and cloud-metadata hosts; with MARKET_BLOCK_PRIVATE_EGRESS set, also blocks
// private/loopback ranges.
export function assertSafeEgressUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`invalid URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked URL scheme: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new Error(`blocked cloud-metadata host: ${host}`);
  }
  if (Deno.env.get("MARKET_BLOCK_PRIVATE_EGRESS")) {
    const isPrivate =
      host === "localhost" || host === "::1" ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^(fc|fd)/.test(host);
    if (isPrivate) throw new Error(`blocked private/loopback host: ${host}`);
  }
  return u;
}

// ---------------------------------------------------------------------------
// user_data builder
// ---------------------------------------------------------------------------

function buildUserData(
  serviceName: string,
): string {
  // Credentials are injected via write_files so runcmd can use them.
  // The runcmd runs as sh (not bash). ORAS pulls the policy-engine binary.
  return `#cloud-config

users:
  - name: agent
    gecos: Policy Engine Agent
    primary_group: agent
    groups: [users]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    no_user_group: false

write_files:
  - path: /etc/systemd/system/fedproxy-client.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=FedProxy Client Service
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=root
      WorkingDirectory=/root
      Environment="SERVICE=${serviceName}"
      Environment="PORT=8080"
      Environment="ATPRP_URL=https://rp.fedproxy.com"
      Environment="AUTH_PLUGIN=oidc"
      Environment="MARKET_ACCEPT_JSON_PATH=/root/secrets/publicdomainrelay.com/market/accept.json"
      ExecStart=/usr/local/bin/fedproxy-client
      Restart=always
      RestartSec=5
      TimeoutStopSec=10
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/policy-engine.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=Policy Engine Service
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=agent
      Group=agent
      WorkingDirectory=/home/agent
      Environment="BUNDLED_ACTIONS_DIR=/home/agent/bundled-actions"
      ExecStart=/usr/local/bin/policy_engine api --bind 127.0.0.1:8080
      Restart=always
      RestartSec=5
      TimeoutStopSec=10
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

runcmd:
  - |
      set -x

      # Retry a command until it succeeds, backing off between attempts.
      # Used to ride out transient GitHub download/network failures during boot.
      retry() {
        n=0
        delay=5
        until "$@"; do
          n=$((n + 1))
          echo "command failed (attempt $n): $*; retrying in \${delay}s" >&2
          sleep "$delay"
          if [ "$delay" -lt 60 ]; then
            delay=$((delay * 2))
          fi
        done
      }

      retry sh -c "curl -sfL 'https://github.com/publicdomainrelay/sshai/releases/download/latest/policy_engine_0.0.1-next_linux_amd64.tar.gz' | tar -xvz -C /usr/local/bin"
      retry sh -c "curl -sfL 'https://github.com/publicdomainrelay/atproto-reverse-proxy/releases/download/latest/atproto-reverse-proxy_linux_amd64.tar.gz' | tar -xvz -C /usr/local/bin"

      mkdir -pv /home/agent/
      cd $(mktemp -d)
      retry sh -c "curl -fL https://github.com/publicdomainrelay/sshai/archive/main.tar.gz | tar xz --wildcards --no-anchored 'src/policy_engine/bundled-actions/*' --strip-components=1"
      mv -v $(find . -name bundled-actions -type d) /home/agent/bundled-actions
      chown -R agent:agent /home/agent/bundled-actions
      cd -

      systemctl start --no-block policy-engine.service
      systemctl enable policy-engine.service
      systemctl start --no-block fedproxy-client.service
      systemctl enable fedproxy-client.service
      systemctl daemon-reload
`;
}

// ---------------------------------------------------------------------------
// Offering / vouch discovery — find bidders via repo owner + collaborator vouches
// ---------------------------------------------------------------------------

const VOUCH_NSID    = "sh.tangled.graph.vouch";
const KNOT_MEMBER_NSID = "sh.tangled.knot.member";

// Get DIDs vouched for by a given account.
async function getVouchedDids(did: string, log: RFPLogger): Promise<string[]> {
  try {
    const pds = await resolvePDS(did);
    const records = await listRecordsAll(pds, did, VOUCH_NSID);
    // rkey encodes the vouched DID; filter to kind="vouch" only
    const vouched = records
      .filter((r) => (r.value.kind as string | undefined) !== "denounce")
      .map((r) => r.uri.split("/").pop() ?? "")
      .filter((rkey) => rkey.startsWith("did:"));
    return Array.from(new Set(vouched));
  } catch (err) {
    log("vouch lookup failed", { did, err: String(err) });
    return [];
  }
}

// Get collaborator DIDs for a knot (knot member records).
async function getKnotMemberDids(knot: string, log: RFPLogger): Promise<string[]> {
  try {
    const knotDid = `did:web:${knot}`;
    const pdsUrl = `https://${knot}`;
    const records = await listRecordsAll(pdsUrl, knotDid, KNOT_MEMBER_NSID);
    return records
      .map((r) => r.value.subject as string | undefined)
      .filter((s): s is string => typeof s === "string" && s.startsWith("did:"));
  } catch (err) {
    log("knot member lookup failed", { knot, err: String(err) });
    return [];
  }
}

// For a vouched DID, check their offering collection and call submitRfp if applicable.
async function notifyBidderViaOffering(
  bidderDid: string,
  rfpUri: string,
  rfpCid: string,
  payloadNsid: string,
  marketClient: MarketClient,
  log: RFPLogger,
): Promise<void> {
  let pds: string;
  try {
    pds = await resolvePDS(bidderDid);
  } catch (err) {
    log("offering discovery: PDS resolve failed", { bidderDid, err: String(err) });
    return;
  }

  let offerings: Array<{ uri: string; cid: string; value: Record<string, unknown> }>;
  try {
    offerings = await listRecordsAll(pds, bidderDid, OFFERING_NSID);
  } catch (err) {
    log("offering discovery: listRecords failed", { bidderDid, pds, err: String(err) });
    return;
  }

  for (const offering of offerings) {
    const appliesTo = offering.value.appliesTo as string[] | undefined;
    const endpointUrl = offering.value.endpointUrl as string | undefined;
    if (!endpointUrl || !Array.isArray(appliesTo)) continue;
    if (!appliesTo.includes(payloadNsid)) continue;

    // endpointUrl now holds a market service DID ref (did:web:HOST#pdr_temp_market).
    log("submitting RFP to vouched bidder", { bidderDid, endpointUrl, rfpUri });
    try {
      const res = await marketClient.submitRfp(endpointUrl, { rfpUri, rfpCid });
      log("submitRfp response", { bidderDid, success: res.ok });
    } catch (err) {
      log("submitRfp failed", { bidderDid, endpointUrl, err: String(err) });
    }
    break; // one offering per bidder is enough
  }
}

// Discover bidders via repo owner + collaborator vouches, notify them about the RFP.
async function discoverAndNotifyBidders(
  trigger: { actor: string; knot: string },
  rfpUri: string,
  rfpCid: string,
  payloadNsid: string,
  marketClient: MarketClient,
  log: RFPLogger,
): Promise<Set<string>> {
  log("discovering bidders via vouches", { owner: trigger.actor, knot: trigger.knot });

  // Seed with the repo *owner account* DID (trigger.actor — populated from the
  // knot's ownerDid, see Pipeline_TriggerRepo.Did in knotserver/internal.go).
  // trigger.repoDid is a separate repo-identity DID whose PDS is the knot
  // itself, which doesn't serve listRecords for arbitrary collections — vouch
  // lookups against it always come back empty.
  const accountsToCheck = new Set<string>([trigger.actor]);

  const collaborators = await getKnotMemberDids(trigger.knot, log);
  for (const c of collaborators) accountsToCheck.add(c);

  log("accounts to check for vouches", { count: accountsToCheck.size });

  const vouchedDids = new Set<string>();
  await Promise.all(
    Array.from(accountsToCheck).map(async (did) => {
      const vouched = await getVouchedDids(did, log);
      for (const v of vouched) vouchedDids.add(v);
    }),
  );

  log("vouched bidder candidates", { count: vouchedDids.size });

  await Promise.all(
    Array.from(vouchedDids).map((did) =>
      notifyBidderViaOffering(did, rfpUri, rfpCid, payloadNsid, marketClient, log)
    ),
  );

  return vouchedDids;
}

// ---------------------------------------------------------------------------
// Jetstream bid collector
// ---------------------------------------------------------------------------

async function collectBidsForRfp(
  rfpUri: string,
  jetstreamUrl: string,
  windowMs: number,
  log: RFPLogger,
  allowedDids: Set<string>,
): Promise<CollectedBid[]> {
  const bids: CollectedBid[] = [];
  const seen = new Set<string>();

  // Pre-seed from any bids already submitted via submitBid HTTP route.
  const pre = pendingBids.get(rfpUri) ?? [];
  for (const b of pre) {
    if (!allowedDids.has(b.did)) {
      log("bid rejected: DID not in allowed set", { did: b.did, uri: b.uri });
      continue;
    }
    if (!seen.has(b.uri)) { seen.add(b.uri); bids.push(b); }
  }
  pendingBids.delete(rfpUri);

  log("collecting bids", { rfpUri, windowMs, preSeedCount: bids.length });

  return new Promise((resolve) => {
    const url = new URL(jetstreamUrl);
    url.searchParams.set("wantedCollections", BID_NSID);

    let ws: WebSocket;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      // Drain any bids that arrived via submitBid during the window.
      const direct = pendingBids.get(rfpUri) ?? [];
      for (const b of direct) {
        if (!allowedDids.has(b.did)) {
          log("bid rejected: DID not in allowed set", { did: b.did, uri: b.uri });
          continue;
        }
        if (!seen.has(b.uri)) { seen.add(b.uri); bids.push(b); }
      }
      pendingBids.delete(rfpUri);
      log("bid window closed", { rfpUri, bids: bids.length });
      resolve(bids);
    }, windowMs);

    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      clearTimeout(timer);
      log("jetstream connect failed", { err: String(err) });
      resolve(bids);
      return;
    }

    ws.onmessage = (evt) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer));
      } catch { return; }

      const did = msg.did as string | undefined;
      const commit = msg.commit as Record<string, unknown> | undefined;
      if (!commit || commit.collection !== BID_NSID || commit.operation !== "create") return;

      const record = commit.record as BidRecord | undefined;
      if (!record?.rfp?.uri) return;
      if (record.rfp.uri !== rfpUri) return;

      const bidUri = `at://${did}/${BID_NSID}/${commit.rkey}`;
      if (seen.has(bidUri)) return;
      seen.add(bidUri);

      if (!did || !allowedDids.has(did)) {
        log("bid rejected: DID not in allowed set", { did, bidUri });
        return;
      }

      log("bid received", { bidUri, did });
      bids.push({
        did: did ?? "",
        uri: bidUri,
        cid: commit.cid as string ?? "",
        record,
      });
    };

    ws.onerror = () => {};
    ws.onclose = () => {};
  });
}

// ---------------------------------------------------------------------------
// Resolve bid payloads from PDS
// ---------------------------------------------------------------------------

async function resolveAtRef(uri: string): Promise<Record<string, unknown> | undefined> {
  const parts = uri.replace("at://", "").split("/");
  const did = parts[0];
  const collection = parts[1];
  const rkey = parts[2];
  const pds = await resolvePDS(did);
  const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", collection);
  url.searchParams.set("rkey", rkey);
  const res = await fetch(url.toString());
  if (!res.ok) return undefined;
  const data = await res.json();
  return data.value as Record<string, unknown>;
}

async function resolveBidPayloads(bids: CollectedBid[], log: RFPLogger): Promise<void> {
  log("resolveBidPayloads", { bids: bids })
  await Promise.all(bids.map(async (bid) => {
    if (bid.record.payload?.uri) {
      try {
        bid.payload = await resolveAtRef(bid.record.payload.uri);
      } catch (err) {
        log("resolve bid payload failed", { uri: bid.record.payload.uri, err: String(err) });
      }
    }
    if (bid.record.config?.uri) {
      try {
        bid.config = await resolveAtRef(bid.record.config.uri);
      } catch (err) {
        log("resolve bid config failed", { uri: bid.record.config.uri, err: String(err) });
      }
    }
  }));
}

// ---------------------------------------------------------------------------
// Bid scoring — pick lowest cost
// ---------------------------------------------------------------------------

function scoreLowestCost(bids: CollectedBid[]): CollectedBid | undefined {
  return bids.reduce((best, b) => {
    const bCost = b.payload?.$type === BIDS_FREE_NSID ? 0 : Number(b.payload?.cost ?? Infinity);
    const bestCost = best.payload?.$type === BIDS_FREE_NSID ? 0 : Number(best.payload?.cost ?? Infinity);
    return bCost < bestCost ? b : best;
  }, bids[0]);
}

// ---------------------------------------------------------------------------
// Watch jetstream for sshPublicKey registration
// ---------------------------------------------------------------------------

function watchForSshKey(
  serviceName: string,
  jetstreamUrl: string,
  timeoutMs: number,
  log: RFPLogger,
): Promise<{ did: string; key: string; handle: string }> {
  log("watching for sshPublicKey", { serviceName, timeoutMs });

  return new Promise((resolve, reject) => {
    const url = new URL(jetstreamUrl);
    url.searchParams.set("wantedCollections", SSH_KEY_NSID);

    let ws: WebSocket;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`Timeout waiting for sshPublicKey service=${serviceName}`));
    }, timeoutMs);

    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }

    ws.onmessage = (evt) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer));
      } catch { return; }

      const did = msg.did as string | undefined;
      const commit = msg.commit as Record<string, unknown> | undefined;
      if (!commit || commit.collection !== SSH_KEY_NSID || commit.operation !== "create") return;

      const record = commit.record as Record<string, unknown> | undefined;
      if (!record) return;
      if (record.service !== serviceName) return;

      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }

      log("sshPublicKey registered", { serviceName, did, key: record.key });
      resolve({
        did: did ?? "",
        key: String(record.key ?? ""),
        handle: String(record.name ?? "").split(".").slice(1).join("."),
      });
    };

    ws.onerror = () => {};
    ws.onclose = () => {};
  });
}

// ---------------------------------------------------------------------------
// Poll policy engine until ready
// ---------------------------------------------------------------------------

async function waitForPolicyEngine(peUrl: string, timeoutMs: number, log: RFPLogger): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const notReadyLogIntervalMs = 10_000;
  let lastNotReadyLog = 0;
  log("waiting for policy engine", { peUrl, timeoutMs });

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${peUrl}/health`, { signal: AbortSignal.timeout(200) });
      if (res.ok) {
        log("policy engine ready", { peUrl });
        return;
      }
      if (Date.now() - lastNotReadyLog >= notReadyLogIntervalMs) {
        log("policy engine not yet ready", { res: res });
        lastNotReadyLog = Date.now();
      }
    } catch (err) {
      if (Date.now() - lastNotReadyLog >= notReadyLogIntervalMs) {
        log("policy engine not yet ready", { err: String(err) });
        lastNotReadyLog = Date.now();
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Policy engine at ${peUrl} did not become ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function marketRFPSubmitWorkflow(
  workflowObj: unknown,
  trigger: {
    knot: string;
    pipelineRkey: string;
    actor: string;
    repoDid: string;
    repoName: string;
    ref: string;
    inputs?: Record<string, string>;
  },
  config: MarketRFPConfig,
  spindleHostname: string,
  onLog?: (line: string) => void,
): Promise<MarketRFPResult> {
  const log = makeLogger(onLog);
  // Generate service name before user_data so it knows its name
  const serviceName = `${config.vm.role}-${randomHex(8)}`;
  log("service name generated", { serviceName });

  // Login to ATProto
  const session = new CredentialSession(new URL(config.pdsUrl));
  await session.login({ identifier: config.handle, password: config.password });
  const agent = new Agent(session);
  const agentDid = agent.assertDid;
  const agentDidPlcKey = agentDid.split(":")[2];
  log("atproto authenticated", { did: agentDid, handle: config.handle });

  // badge.blue attestation identity: every market record this spindle authors
  // (rfp, accept, event, accepts.x402) carries an inline signature by this key.
  const attestationKeypair = await loadOrGenerateKeypair(Deno.env.get("ATTESTATION_PRIVATE_KEY_HEX"));
  const signer: RecordSigner = {
    keypair: attestationKeypair,
    issuer: spindleHostname ? `did:web:${spindleHostname}` : agentDid,
  };
  log("attestation keypair loaded", { key: attestationKeypair.did(), issuer: signer.issuer });

  // MarketClient over our own PDS session; each method service-proxies via the
  // `atproto-proxy` header carrying the target's service DID ref. See ../lib/market.
  const marketClient = createMarketClient(session);

  // Build user_data with policy-engine bootstrap
  const userData = buildUserData(serviceName);

  // Create compute.vm record
  const vmRecord = {
    $type: VM_NSID,
    cpus: config.vm.cpus,
    mem: config.vm.mem,
    disk: config.vm.disk,
    network: config.vm.network,
    role: serviceName,
    user_data: userData,
    location: config.vm.location,
    createdAt: new Date().toISOString(),
  };
  const vmRef = await atprotoCreateRecord(agent, VM_NSID, vmRecord);
  log("compute.vm created", { uri: vmRef.uri });

  // Create market.rfp record wrapping the VM
  const rfpRecord: Record<string, unknown> = {
    $type: RFP_NSID,
    domain: "compute",
    payload: vmRef,
    createdAt: new Date().toISOString(),
  };
  if (spindleHostname) {
    rfpRecord.submitBid = `did:web:${spindleHostname}#${MARKET_SERVICE_ID}`;
  }
  const rfpRef = await createSignedRecord(agent, RFP_NSID, rfpRecord, signer);
  log("market.rfp created", { uri: rfpRef.uri });

  // Discover vouched bidders and notify them about the RFP before opening the window.
  const rfpUri = rfpRef.uri;
  const allowedBidderDids = await discoverAndNotifyBidders(
    { actor: trigger.actor, knot: trigger.knot },
    rfpUri,
    rfpRef.cid,
    VM_NSID,
    marketClient,
    log,
  );

  // Listen for bids during the bid window — only accept from allowed DIDs.
  const bids = await collectBidsForRfp(rfpUri, config.jetstreamUrl, config.bidWindowMs, log, allowedBidderDids);

  if (bids.length === 0) {
    throw new Error(`No bids received for RFP ${rfpUri} within ${config.bidWindowMs}ms`);
  }

  await resolveBidPayloads(bids, log);

  const winner = scoreLowestCost(bids);
  if (!winner) throw new Error("No scoreable bid found");
  log("bid winner selected", { bidUri: winner.uri, did: winner.did, cost: winner.payload?.cost });
  log("winner", { winner: winner });

  // The bid is a badge.blue-signed record by the bidder; reject it if its inline
  // signature is missing or does not verify before we settle and accept.
  const winnerSigOk = await verifyRecordSignatures({
    record: winner.record as unknown as Record<string, unknown>,
    repositoryDid: winner.did,
  });
  if (!winnerSigOk) {
    throw new Error(`winning bid ${winner.uri} has no valid badge.blue signature; refusing to accept`);
  }

  // The RBAC grant below is templated from the winner's config (issuer_uri, actx).
  // A bid without a resolved config cannot be authorized — fail instead of
  // emitting an RBAC record with `undefined` substituted into the trust fields.
  if (!winner.config) {
    throw new Error(`Winning bid ${winner.uri} has no resolved config; cannot build RBAC grant`);
  }
  const winnerConfig = winner.config;

  const bidRef: StrongRef = {
    $type: "com.atproto.repo.strongRef",
    uri: winner.uri,
    cid: winner.cid,
  };

  // Payment leg: settle the bid's payment terms before accepting.
  // - x402 bids: mint accepts.x402, GET the payment endpoint, get back a
  //   receipts.x402 proof-of-payment strongRef used as market.accept payload.
  // - free bids: no payment, no receipt endpoint — payload is omitted.
  const bidPayload = winner.payload;
  let paymentReceiptRef: StrongRef | undefined;
  if (bidPayload?.$type === BIDS_X402_NSID) {
    const x402Url = String(bidPayload?.url ?? "");
    if (!x402Url) {
      throw new Error(`winning bid ${winner.uri} has no x402 payment url; cannot settle`);
    }
    paymentReceiptRef = await settleX402Payment({
      agent,
      signer,
      bid: bidRef,
      bidPayload: winner.record.payload,
      url: x402Url,
      egress: { blockPrivate: !!Deno.env.get("MARKET_BLOCK_PRIVATE_EGRESS") },
      log: (_level, msg, fields) => log(msg, fields),
    });
  } else if (bidPayload?.$type !== BIDS_FREE_NSID) {
    throw new Error(`winning bid ${winner.uri} has unknown payload type ${bidPayload?.$type}; cannot settle`);
  }

  // Accept the winning bid. payload carries the proof-of-payment (x402) or is
  // omitted (free). submitEvent tells the bidder where it can report events
  // about the resource it provisions directly, bypassing the firehose.
  const acceptRecord: Record<string, unknown> = {
    $type: ACCEPT_NSID,
    rfp: rfpRef,
    bid: bidRef,
    ...(paymentReceiptRef ? { payload: paymentReceiptRef } : {}),
    createdAt: new Date().toISOString(),
  };
  if (spindleHostname) {
    acceptRecord.submitEvent = `did:web:${spindleHostname}#${COMPUTE_EVENT_SERVICE_ID}`;
  }
  const acceptRef = await createSignedRecord(agent, ACCEPT_NSID, acceptRecord, signer);
  log("market.accept created", { uri: acceptRef.uri });

  // Create com.fedproxy.rbac BEFORE submitting receipt
  // Grants agentDid permission to createRecord com.fedproxy.sshPublicKey
  // with the specific service name, so the VM can register itself.
  const rbacRecord = {
    $type: RBAC_NSID,
    roles: {
      [serviceName]: {
        role_name: serviceName,
        definition: {
          // aud is us
          aud: `api://ATProto?actx=${agentDid}`,
          iss: `${winnerConfig.issuer_uri}`,
          // actx is them for this simple example
          // TODO Thi should be templating winnerConfig.subject
          sub: `actx:${winnerConfig.actx}:plc:${agentDidPlcKey}:role:${serviceName}`,
          policies: ["ssh-key-register"],
        },
      },
    },
    policies: {
      "ssh-key-register": {
        meta: {
          policy: "ssh-key-register",
        },
        schemas: {
          "/xrpc/com.atproto.repo.createRecord": {
            type: "object",
            $schema: "http://json-schema.org/draft-07/schema#",
            required: ["capability", "body"],
            properties: {
              capability: {
                enum: ["create"],
              },
              body: {
                type: "object",
                additionalProperties: false,
                required: ["collection", "record"],
                properties: {
                  collection: {
                    type: "string",
                    const: SSH_KEY_NSID,
                  },
                  record: {
                    type: "object",
                    properties: {
                      service: {
                        type: "string",
                        const: serviceName,
                      },
                    },
                    required: ["service"],
                  },
                },
              },
            },
          },
        },
      },
    },
    custom_claims_roles_index: {
      job_workflow_ref: {},
    },
    createdAt: new Date().toISOString(),
  };
  log("com.fedproxy.rbac creating", { record: rbacRecord });
  const rbacRef = await atprotoCreateRecord(agent, RBAC_NSID, rbacRecord);
  log("com.fedproxy.rbac created", { uri: rbacRef.uri, subject: agentDid, serviceName });

  // Settlement leg: submit the accept to the bidder via its submitAccept
  // procedure (provisions the resource, creates market.receipt). The response
  // carries a strongRef to the receipt plus the bidder's submitEvent endpoint —
  // the channel we use to tell it to delete the VM later, since the bidder
  // treats provisioned VMs as a black box and can't observe that itself. Routed
  // through our PDS via service-proxying: the bid's submitAccept field holds a
  // service DID ref (did:web:HOST#pdr_temp_market), distinct from the x402 payment
  // url used for the payment leg above.
  let receiptRef: StrongRef | undefined;
  let providerSubmitEventUrl: string | undefined;
  const bidderServiceRef = String(winner.record.submitAccept ?? "");
  if (bidderServiceRef) {
    log("submitting accept to bidder via submitAccept", { ref: bidderServiceRef, acceptUri: acceptRef.uri });
    try {
      const body = await marketClient.submitAccept(bidderServiceRef, {
        acceptUri: acceptRef.uri,
        acceptCid: acceptRef.cid,
      });
      if (body.uri && body.cid) {
        receiptRef = { $type: "com.atproto.repo.strongRef", uri: body.uri, cid: body.cid };
      }
      providerSubmitEventUrl = body.submitEvent;
      log("submitAccept proxied call", { ref: bidderServiceRef, receiptRef, providerSubmitEventUrl });
    } catch (err) {
      log("submitAccept proxied call failed", { ref: bidderServiceRef, err: String(err) });
    }
  }

  // Reports a compute.events.vm.delete event back to the provider's
  // submitEvent endpoint — used both when the workflow finishes and when the
  // policy engine never comes up, so the provider knows to tear the VM down.
  // The RBAC grant only needs to exist while the VM is alive and registering
  // its SSH key; once we're tearing the VM down, remove it so stale grants
  // don't accumulate (mirrors the bidder's deleteRbacRecord for droplet RBAC).
  let rbacRemoved = false;
  const removeRbacRecord = async (reason: string): Promise<void> => {
    if (rbacRemoved) return;
    rbacRemoved = true;
    log("com.fedproxy.rbac deleting", { uri: rbacRef.uri, subject: agentDid, serviceName, reason });
    try {
      await atprotoDeleteRecord(agent, rbacRef);
      log("com.fedproxy.rbac deleted", { uri: rbacRef.uri, subject: agentDid, serviceName, reason });
    } catch (err) {
      log("com.fedproxy.rbac delete failed", { uri: rbacRef.uri, subject: agentDid, serviceName, reason, err: String(err) });
    }
  };

  const reportVmDelete = async (reason: string): Promise<void> => {
    await removeRbacRecord(reason);
    if (!receiptRef || !providerSubmitEventUrl) {
      log("cannot report vm.delete: missing receipt strongRef or provider submitEvent endpoint", { receiptRef, providerSubmitEventUrl, reason });
      return;
    }
    try {
      const nowIso = new Date().toISOString();
      const deletePayloadRef = await atprotoCreateRecord(agent, VM_DELETE_EVENT_NSID, {
        $type: VM_DELETE_EVENT_NSID,
        reason,
        createdAt: nowIso,
      });
      const eventRecord = {
        $type: EVENT_NSID,
        receipt: receiptRef,
        payload: deletePayloadRef,
        createdAt: nowIso,
      };
      const eventRef = await createSignedRecord(agent, EVENT_NSID, eventRecord, signer);
      // providerSubmitEventUrl holds a did:web:HOST#pdr_temp_compute_event service ref;
      // route the submitEvent call through our PDS via service proxying.
      const res = await marketClient.submitEvent(providerSubmitEventUrl, {
        uri: eventRef.uri,
        cid: eventRef.cid,
        record: eventRecord,
      });
      log("submitEvent vm.delete POST", { url: providerSubmitEventUrl, reason, success: res.ok });
    } catch (err) {
      log("submitEvent vm.delete POST failed", { url: providerSubmitEventUrl, reason, err: String(err) });
    }
  };

  // Derive policy engine URL from service name + handle + fedproxy host.
  // This doesn't depend on the jetstream event, so we can start polling it
  // immediately rather than waiting on the sshPublicKey registration first.
  const peUrl = `https://${serviceName}--${config.handle.replace(/\./g, "-")}.${config.fedproxyHost}`;
  log("policy engine URL", { peUrl });

  // Watch jetstream for com.fedproxy.sshPublicKey with our service name (tells
  // us the VM has booted, started the policy engine, and registered itself)
  // in parallel with directly polling the policy engine's /health route. The
  // jetstream event has been known to lag behind the VM actually being ready,
  // so whichever signal arrives first is good enough to proceed on.
  const sshKeyPromise = watchForSshKey(serviceName, config.jetstreamUrl, config.vmReadyTimeoutMs, log);
  const healthPromise = waitForPolicyEngine(peUrl, config.vmReadyTimeoutMs, log);
  sshKeyPromise.catch(() => {});
  healthPromise.catch(() => {});

  let sawHealthFirst = false;
  try {
    const winner = await Promise.any([
      sshKeyPromise.then((event) => ({ via: "sshKey" as const, event })),
      healthPromise.then(() => ({ via: "health" as const })),
    ]);
    if (winner.via === "sshKey") {
      log("VM registered SSH key", { serviceName, did: winner.event.did });
    } else {
      sawHealthFirst = true;
      log("policy engine /health came up before sshPublicKey jetstream event, proceeding", { serviceName, peUrl });
    }
  } catch (err) {
    await reportVmDelete("policy_engine_never_came_up");
    throw new Error(`Neither sshPublicKey registration nor policy engine /health became ready: ${String(err)}`);
  }

  // Poll until policy engine is ready — if it never comes up, the bidder has
  // no way to know (it never talks to the policy engine), so we tell it to
  // delete the VM ourselves before giving up on the workflow. Skipped if the
  // /health poll above already confirmed readiness.
  if (!sawHealthFirst) {
    try {
      await waitForPolicyEngine(peUrl, config.peReadyTimeoutMs, log);
    } catch (err) {
      await reportVmDelete("policy_engine_never_came_up");
      throw err;
    }
  }

  // Submit workflow to the remote policy engine
  const req = {
    workflow: workflowObj,
    context: {
      config: {
        env: {
          GITHUB_ACTOR: trigger.actor,
          GITHUB_REPOSITORY: `${trigger.repoDid}/${trigger.repoName}`,
          GITHUB_SHA: trigger.ref,
          GITHUB_REF: trigger.ref,
          GITHUB_SERVER_URL: `https://${trigger.knot}`,
          SPINDLE_HOSTNAME: spindleHostname,
          SPINDLE_KNOT: trigger.knot,
          SPINDLE_REPO_DID: trigger.repoDid,
        },
      },
    },
    inputs: trigger.inputs,
  };

  const submitRes = await fetch(`${peUrl}/request/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(30000),
  });

  if (!submitRes.ok) {
    throw new Error(`Remote PE submit failed ${submitRes.status}: ${await submitRes.text()}`);
  }

  const status = await submitRes.json() as PolicyEngineStatus;
  const taskId = status.detail?.id as string;
  if (!taskId) throw new Error("Remote PE returned no task ID");

  log("workflow submitted to remote PE", { taskId, peUrl });
  return { taskId, peUrl, reportVmDelete };
}

// ---------------------------------------------------------------------------
// Config from env vars
// ---------------------------------------------------------------------------

export function marketRFPConfigFromEnv(): MarketRFPConfig {
  return {
    pdsUrl:         Deno.env.get("ATPROTO_PDS_URL") ?? "https://bsky.social",
    handle:         Deno.env.get("ATPROTO_HANDLE") ?? "",
    password:       Deno.env.get("ATPROTO_PASSWORD") ?? "",
    atpRelayUrl:    Deno.env.get("ATP_RELAY_URL") ?? "https://rp.fedproxy.com",
    fedproxyHost:   Deno.env.get("FEDPROXY_HOST") ?? "fedproxy.com",
    jetstreamUrl:   Deno.env.get("JETSTREAM_URL") ?? "wss://jetstream2.us-east.bsky.network/subscribe",
    vm: {
      cpus:    parseInt(Deno.env.get("VM_CPUS") ?? "2", 10),
      mem:     Deno.env.get("VM_MEM")  ?? "4G",
      disk:    Deno.env.get("VM_DISK") ?? "40G",
      network: Deno.env.get("VM_NETWORK") ?? "500G",
      role:    Deno.env.get("VM_ROLE") ?? "policy-engine",
      location: {
        country: Deno.env.get("VM_LOCATION_COUNTRY") ?? "USA",
        region:  Deno.env.get("VM_LOCATION_REGION")  ?? "west",
      },
    },
    bidWindowMs:       parseInt(Deno.env.get("BID_WINDOW_MS")        ?? "30000", 10),
    vmReadyTimeoutMs:  parseInt(Deno.env.get("VM_READY_TIMEOUT_MS")  ?? "600000", 10),
    peReadyTimeoutMs:  parseInt(Deno.env.get("PE_READY_TIMEOUT_MS")  ?? "120000", 10),
  };
}
