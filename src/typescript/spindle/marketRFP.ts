// marketRFP.ts — ATProto market RFP compute provider for tangled-spindle-minimal
//
// When COMPUTE_PROVIDER=market.rfp, this module handles workflow submission by:
//   1. Generating a random service name: policy-engine-${hex}
//   2. Building cloud-init user_data that pulls + starts the policy-engine binary
//   3. Creating compute.vm + market.rfp ATProto records
//   4. Listening for bids on the jetstream
//   5. Accepting the winning bid
//   6. Creating com.fedproxy.rbac to authorize the VM's DID to register its SSH key
//   7. Submitting the accept bundle to the bidder (x402 receipt endpoint)
//   8. Watching jetstream for com.fedproxy.sshPublicKey with the generated service name
//   9. Polling the fedproxy URL until the policy engine is ready
//  10. Forwarding the workflow submission to the remote policy engine
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
import { getPdsEndpoint } from "npm:@atproto/common-web";

// ---------------------------------------------------------------------------
// NSIDs
// ---------------------------------------------------------------------------

const VM_NSID     = "com.publicdomainrelay.temp.compute.vm";
const RFP_NSID    = "com.publicdomainrelay.temp.market.rfp";
const BID_NSID    = "com.publicdomainrelay.temp.market.bid";
const ACCEPT_NSID = "com.publicdomainrelay.temp.market.accept";
const RECEIPT_NSID = "com.publicdomainrelay.temp.market.receipt";
const BIDS_X402_NSID = "com.publicdomainrelay.temp.market.bids.x402";
const RBAC_NSID   = "com.fedproxy.rbac";
const SSH_KEY_NSID = "com.fedproxy.sshPublicKey";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

type BidRecord = {
  $type: string;
  rfp: StrongRef;
  payload: StrongRef;
  config?: StrongRef;
};

type CollectedBid = {
  did: string;
  uri: string;
  cid: string;
  record: BidRecord;
  payload?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

// Per-RFP queue for bids submitted directly via HTTP (sendBid endpoint).
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

async function resolvePDS(did: string): Promise<string> {
  const resolver = new IdResolver();
  const doc = await resolver.did.resolve(did);
  if (!doc) throw new Error(`Could not resolve DID ${did}`);
  const pds = getPdsEndpoint(doc);
  if (!pds) throw new Error(`No PDS endpoint for ${did}`);
  return pds;
}

async function atprotoCreateRecord(
  agent: Agent,
  collection: string,
  record: Record<string, unknown>,
): Promise<StrongRef> {
  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection,
    record,
  });
  return {
    $type: "com.atproto.repo.strongRef",
    uri: res.data.uri,
    cid: res.data.cid,
  };
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

      curl -sfL 'https://github.com/publicdomainrelay/sshai/releases/download/latest/policy_engine_0.0.1-next_linux_amd64.tar.gz' | tar -xvz -C /usr/local/bin
      curl -sfL 'https://github.com/publicdomainrelay/atproto-reverse-proxy/releases/download/latest/atproto-reverse-proxy_linux_amd64.tar.gz' | tar -xvz -C /usr/local/bin

      mkdir -pv /home/agent/
      cd $(mktemp -d)
      curl -L https://github.com/publicdomainrelay/sshai/archive/main.tar.gz | tar xz --wildcards --no-anchored 'src/policy_engine/bundled-actions/*' --strip-components=1
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
// Jetstream bid collector
// ---------------------------------------------------------------------------

async function collectBidsForRfp(
  rfpUri: string,
  jetstreamUrl: string,
  windowMs: number,
  log: RFPLogger,
): Promise<CollectedBid[]> {
  const bids: CollectedBid[] = [];
  const seen = new Set<string>();

  // Pre-seed from any bids already submitted via sendBid HTTP route.
  const pre = pendingBids.get(rfpUri) ?? [];
  for (const b of pre) {
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
      // Drain any bids that arrived via sendBid during the window.
      const direct = pendingBids.get(rfpUri) ?? [];
      for (const b of direct) {
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
  const x402Bids = bids.filter((b) => b.payload?.$type === BIDS_X402_NSID);
  if (x402Bids.length === 0) return bids[0];

  return x402Bids.reduce((best, b) => {
    const bCost = Number(b.payload?.cost ?? Infinity);
    const bestCost = Number(best.payload?.cost ?? Infinity);
    return bCost < bestCost ? b : best;
  }, x402Bids[0]);
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
  log("waiting for policy engine", { peUrl, timeoutMs });

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${peUrl}/health`, { signal: AbortSignal.timeout(200) });
      if (res.ok) {
        log("policy engine ready", { peUrl });
        return;
      }
      log("policy engine not yet ready", { res: res });
    } catch (err) {
      log("policy engine not yet ready", { err: String(err) });
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
  // Step 1: Generate service name before user_data so it knows its name
  const serviceName = `${config.vm.role}-${randomHex(8)}`;
  log("service name generated", { serviceName });

  // Step 2: Login to ATProto
  const session = new CredentialSession(new URL(config.pdsUrl));
  await session.login({ identifier: config.handle, password: config.password });
  const agent = new Agent(session);
  const agentDid = agent.assertDid;
  const agentDidPlcKey = agentDid.split(":")[2];
  log("atproto authenticated", { did: agentDid, handle: config.handle });

  // Step 3: Build user_data with policy-engine bootstrap
  const userData = buildUserData(serviceName);

  // Step 4: Create compute.vm record
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

  // Step 5: Create market.rfp record wrapping the VM
  const sendBidUrl = spindleHostname
    ? `https://${spindleHostname}/xrpc/com.publicdomainrelay.temp.market.submitBid`
    : undefined;
  const rfpRecord: Record<string, unknown> = {
    $type: RFP_NSID,
    domain: "compute",
    payload: vmRef,
    createdAt: new Date().toISOString(),
  };
  if (sendBidUrl) rfpRecord.sendBid = sendBidUrl;
  const rfpRef = await atprotoCreateRecord(agent, RFP_NSID, rfpRecord);
  log("market.rfp created", { uri: rfpRef.uri });

  // Step 6: Listen for bids during the bid window
  const rfpUri = rfpRef.uri;
  const bids = await collectBidsForRfp(rfpUri, config.jetstreamUrl, config.bidWindowMs, log);

  if (bids.length === 0) {
    throw new Error(`No bids received for RFP ${rfpUri} within ${config.bidWindowMs}ms`);
  }

  await resolveBidPayloads(bids, log);

  const winner = scoreLowestCost(bids);
  if (!winner) throw new Error("No scoreable bid found");
  log("bid winner selected", { bidUri: winner.uri, did: winner.did, cost: winner.payload?.cost });
  log("winner", { winner: winner });

  const bidRef: StrongRef = {
    $type: "com.atproto.repo.strongRef",
    uri: winner.uri,
    cid: winner.cid,
  };

  // Step 7: Accept the winning bid
  const acceptRecord = {
    $type: ACCEPT_NSID,
    rfp: rfpRef,
    bid: bidRef,
    createdAt: new Date().toISOString(),
  };
  const acceptRef = await atprotoCreateRecord(agent, ACCEPT_NSID, acceptRecord);
  log("market.accept created", { uri: acceptRef.uri });

  // Step 8: Create com.fedproxy.rbac BEFORE submitting receipt
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
          iss: `${winner.config.issuer_uri}`,
          // actx is them for this simple example
          // TODO Thi should be templating winner.config.subject
          sub: `actx:${winner.config.actx}:plc:${agentDidPlcKey}:role:${serviceName}`,
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

  // Step 9: Submit to bidder's x402 receipt endpoint (creates market.receipt)
  const x402Payload = winner.payload;
  if (x402Payload) {
    const baseUrl = String(x402Payload.url ?? "");
    if (baseUrl) {
      const receiptUrl = `${baseUrl}/${acceptRef.uri}/${acceptRef.cid}`;
      log("submitting to x402 receipt endpoint", { url: receiptUrl });
      try {
        const res = await fetch(receiptUrl, {
          method: "GET",
          signal: AbortSignal.timeout(30000),
        });
        if (res.ok) {
          log("x402 receipt submitted", { status: res.status });
        } else {
          log("x402 receipt non-ok", { status: res.status });
        }
      } catch (err) {
        log("x402 receipt request failed", { err: String(err) });
      }
    }
  }

  // Step 10: Watch jetstream for com.fedproxy.sshPublicKey with our service name
  // This tells us the VM has booted, started the policy engine, and registered itself.
  const sshKeyEvent = await watchForSshKey(
    serviceName,
    config.jetstreamUrl,
    config.vmReadyTimeoutMs,
    log,
  );
  log("VM registered SSH key", { serviceName, did: sshKeyEvent.did });

  // Step 11: Derive policy engine URL from service name + handle + fedproxy host
  const peUrl = `https://${serviceName}--${config.handle.replace(/\./g, "-")}.${config.fedproxyHost}`;
  log("policy engine URL", { peUrl });

  // Step 12: Poll until policy engine is ready
  await waitForPolicyEngine(peUrl, config.peReadyTimeoutMs, log);

  // Step 13: Submit workflow to the remote policy engine
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
  return { taskId, peUrl };
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
    bidWindowMs:       parseInt(Deno.env.get("BID_WINDOW_MS")        ?? "5000",  10),
    vmReadyTimeoutMs:  parseInt(Deno.env.get("VM_READY_TIMEOUT_MS")  ?? "600000", 10),
    peReadyTimeoutMs:  parseInt(Deno.env.get("PE_READY_TIMEOUT_MS")  ?? "120000", 10),
  };
}
