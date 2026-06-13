/**
 * xrpc-relay-pds — atproto repo PDS server + relay subscriber
 *
 * On start:
 *   1. Generate/load a secp256k1 keypair
 *   2. Register a did:plc with a PLC directory
 *   3. Mount the repo PDS factory (Hono app)
 *   4. Start the HTTP server (direct access)
 *   5. Connect to the XRPC relay as a subscriber (proxied access via
 *      relay → WebSocket #request → app.fetch())
 *   6. Run compute contract request flow
 *      (create VM → RFP → collect bids → accept → output result)
 *
 * Run:
 *   PORT=8080 deno run -A server.ts [--vm-name my-vm] [--bid-window-sec 30]
 *
 * Supply a stable signing key via REPO_PRIVATE_KEY_HEX; otherwise a fresh
 * secp256k1 keypair is generated each boot (the DID changes on restart).
 *
 * The cloud-init user-data is always built via buildDefaultUserData; it waits
 * for relay registration, runs the full compute contract request flow, prints
 * the result as JSON to stdout, and keeps the server running.
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
import { getPdsEndpoint } from "@atproto/common-web";
import { XrpcClient, XRPCError } from "@atproto/xrpc";
import {
  loadOrGenerateKeypair,
  attestationFor,
  toStorableEntry,
  listRecordsAll,
  createSubmitBidHandler,
  createRecordResolver,
  type AttestationKeypair,
  type InlineAttestation,
  type SubmitBidCallback,
} from "@publicdomainrelay/market";
import {
  COMPUTE_VM_NSID,
  RFP_NSID,
  ACCEPT_NSID,
  OFFERING_NSID,
  SUBMIT_RFP_NSID,
  SUBMIT_BID_NSID,
  SUBMIT_ACCEPT_NSID,
  SUBMIT_RFP_LXM,
  SUBMIT_ACCEPT_LXM,
  SUBMIT_EVENT_NSID,
  SUBMIT_EVENT_LXM,
  EVENT_NSID,
  COMPUTE_EVENTS_VM_DELETE_NSID,
} from "@publicdomainrelay/lexicons";

// sh.tangled.graph.vouch — external namespace, not in PDR lexicons module.
const VOUCH_NSID = "sh.tangled.graph.vouch";
import { TID } from "@atproto/common";
import { buildDefaultUserData } from "./cloud-init-presets.ts";

// ── ssh keypair for tunneled root login ──────────────────────────────

/**
 * Generate an ed25519 SSH keypair via ssh-keygen. The public key is injected
 * into the VM's cloud-init (root's authorized_keys, reached over the
 * websocat→sshd tunnel); the private key is written to disk so the operator can
 * `ssh -i <priv> root@<service>.fedproxy.com` through a websocat ProxyCommand.
 * Returns { publicKey, privateKeyPath }.
 */
async function generateSshKeypair(
  vmName: string,
): Promise<{ publicKey: string; privateKeyPath: string }> {
  const dir = await Deno.makeTempDir({ prefix: `ssh-${vmName}-` });
  const privateKeyPath = `${dir}/id_ed25519`;
  const cmd = new Deno.Command("ssh-keygen", {
    args: ["-t", "ed25519", "-N", "", "-C", `root@${vmName}`, "-f", privateKeyPath],
    stdout: "null",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`ssh-keygen failed: ${new TextDecoder().decode(stderr)}`);
  }
  const publicKey = (await Deno.readTextFile(`${privateKeyPath}.pub`)).trim();
  return { publicKey, privateKeyPath };
}

/**
 * Mirror atprp-ssh-relay's flattenLabel: fold an identity part (service name,
 * handle, or raw DID) into a single DNS label by replacing dots and colons with
 * dashes. The relay serves each tunnel at
 * `flattenLabel(SERVICE)--flattenLabel(SSH_USER).<endpoint>`; we recompute the
 * same host so we can poll/ssh the VM at the exact name the relay registers.
 * Must stay in sync with cmd/atprp-ssh-relay/main.go:flattenLabel.
 */
function flattenLabel(s: string): string {
  return s.replace(/[.:]/g, "-");
}

// ── ssh-over-websocat tunnel helpers ─────────────────────────────────

/**
 * Common ssh args reaching the VM through the fedproxy WebSocket tunnel:
 * `-o ProxyCommand=websocat --binary wss://<fqdn>` bridges ssh's stdio to the
 * relay-fronted websocat→sshd listener; the generated key is the only
 * credential (root login is key-only). Host-key checking is disabled because
 * each VM mints a fresh host key on first boot.
 */
function sshTunnelArgs(privateKeyPath: string, fqdn: string): string[] {
  return [
    "-o", `ProxyCommand=websocat --binary wss://${fqdn}`,
    "-o", `IdentityFile=${privateKeyPath}`,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
  ];
}

/**
 * Poll the VM until sshd answers through the tunnel, or give up after
 * timeoutMs. Each probe is a fresh non-interactive `ssh … true` with a short
 * ConnectTimeout (well under the ~18s fedproxy idle-WS cutoff). Returns true
 * once a probe exits 0.
 */
async function pollSshReady(
  privateKeyPath: string,
  fqdn: string,
  timeoutMs: number,
  log: (event: string, extra?: Record<string, unknown>) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const cmd = new Deno.Command("ssh", {
      args: [
        ...sshTunnelArgs(privateKeyPath, fqdn),
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        `root@${fqdn}`,
        "true",
      ],
      stdout: "null",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    if (code === 0) {
      log("vm_ssh_ready", { fqdn, attempt });
      return true;
    }
    log("vm_ssh_poll", { fqdn, attempt, code, error: new TextDecoder().decode(stderr).trim().slice(0, 200) });
    await new Promise((r) => setTimeout(r, 5000));
  }
  log("vm_ssh_timeout", { fqdn, timeoutMs });
  return false;
}

/**
 * Open an interactive ssh session (with TTY allocation) when stdin is a
 * terminal, letting the operator play in the VM. Otherwise run a one-off
 * `program` (default `bash`) non-interactively. Inherits stdio so the user
 * drives the session directly. Returns the ssh exit code.
 */
async function runSshSession(
  privateKeyPath: string,
  fqdn: string,
  program: string,
): Promise<number> {
  const interactive = Deno.stdin.isTerminal();
  const args = [...sshTunnelArgs(privateKeyPath, fqdn)];
  if (interactive) {
    // -tt forces TTY allocation even though our own stdin is inherited.
    args.push("-tt", `root@${fqdn}`);
  } else {
    args.push(`root@${fqdn}`, program);
  }
  const cmd = new Deno.Command("ssh", { args, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const child = cmd.spawn();
  const { code } = await child.status;
  return code;
}

// ── env ──────────────────────────────────────────────────────────────

const PORT = parseInt(Deno.env.get("PORT") ?? "8080");
const PRIVATE_KEY_HEX = Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
const BASE_ORIGIN = Deno.env.get("BASE_ORIGIN") ?? `http://localhost:${PORT}`;
const PLC_DIRECTORY_URL = Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
const DISPATCHER_HOST = Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
// fedproxy host fronting the per-VM websocat→sshd tunnel (distinct from the
// xrpc relay's DISPATCHER_HOST). The VM is reachable at
// `<vmName>--<did>.<FEDPROXY_HOST>` once fedproxy-client comes up inside it.
const FEDPROXY_HOST = Deno.env.get("FEDPROXY_HOST") ?? "fedproxy.com";

// ── keypair ──────────────────────────────────────────────────────────

const keypair = PRIVATE_KEY_HEX
  ? await Secp256k1Keypair.import(PRIVATE_KEY_HEX)
  : await Secp256k1Keypair.create({ exportable: true });

if (!PRIVATE_KEY_HEX) {
  const exported = await keypair.export();
  const hex = Array.from(exported).map((b) => b.toString(16).padStart(2, "0")).join("");
  console.log(JSON.stringify({
    event: "keypair_generated",
    hint: "set REPO_PRIVATE_KEY_HEX to reuse this identity",
    private_key_hex: hex,
    did_key: keypair.did(),
  }));
}

// ── did:plc registration ─────────────────────────────────────────────

const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });
const signingKeyDid = keypair.did();

const { did, op } = await createGenesisOp({
  rotationKeys: [signingKeyDid],
  verificationMethods: { atproto: signingKeyDid },
  alsoKnownAs: [
    `at://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
  ],
  services: {
    atproto_pds: {
      type: "AtprotoPersonalDataServer",
      endpoint: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
    },
  },
  sign: (bytes) => keypair.sign(bytes),
});

console.log(JSON.stringify({ event: "did_plc_registering", did }));
await plc.submitOp(did, op);
console.log(JSON.stringify({ event: "did_plc_registered", did }));

// Verify the directory resolves it.
const plcDoc = await plc.resolve(did);
console.log(JSON.stringify({ event: "did_plc_resolved", did, doc: plcDoc }));

// ── signer (did:plc identity, keypair signing) ───────────────────────

const signer: Signer = {
  did: () => did,
  sign: (bytes) => keypair.sign(bytes),
};

// ── relay registration promise (for compute contract flow) ─────────────

let relayRegistered: ((info: { subdomain: string; proxyRef: string }) => void) | null = null;
const relayReady = new Promise<{ subdomain: string; proxyRef: string }>((resolve) => {
  relayRegistered = resolve;
});

// Shared relay state (set once on registration).
let relaySubdomain = "";
let relayProxyRef = "";

// ── pending bids (for compute contract bid collection) ──────────────

type CollectedBid = {
  did: string;
  uri: string;
  cid: string;
  record: Record<string, unknown>;
};
const pendingBids: Map<string, CollectedBid[]> = new Map();

// ── repo factory ─────────────────────────────────────────────────────

const { app, subscribe, api } = createRepoFactory({
  storage: new MemoryStorage(),
  signer,
  baseOrigin: BASE_ORIGIN,
});

// ── submitBid handler (via market library factory) ───────────────────

// The onBid callback queues the bid into pendingBids. Service-auth
// verification + record signature checking is handled by the factory.
const onBid: SubmitBidCallback = ({ uri, cid, record, issuerDid }) => {
  const rfpUri = (record.rfp as Record<string, unknown> | undefined)?.uri as string | undefined;
  if (!rfpUri) return;
  const queue = pendingBids.get(rfpUri) ?? [];
  queue.push({ did: issuerDid, uri, cid, record: record as unknown as Record<string, unknown> });
  pendingBids.set(rfpUri, queue);
  console.log(JSON.stringify({ event: "submitBid_queued", callerDid: issuerDid, uri, rfpUri }));
};

const idResolver = new IdResolver();
const bidHandler = createSubmitBidHandler({
  deps: {
    hostname: (req: Request) => {
      // Derive hostname from the inbound request (relay forwards with original Host).
      // Fall back to the registered subdomain when known.
      const host = req.headers.get("host") ?? req.headers.get("x-forwarded-host");
      return host ? host.split(":")[0] : relaySubdomain
        ? `${relaySubdomain}.${DISPATCHER_HOST}`
        : DISPATCHER_HOST;
    },
    idResolver,
    resolve: createRecordResolver(idResolver),
  },
  serviceIds: ["pdr_temp_market"],
  onBid,
});
app.post(`/xrpc/${SUBMIT_BID_NSID}`, (c) => bidHandler(c.req.raw));

// ── HTTP server ──────────────────────────────────────────────────────

Deno.serve({ port: PORT }, app.fetch);
console.log(JSON.stringify({
  event: "listening",
  port: PORT,
  did,
  baseOrigin: BASE_ORIGIN,
}));

// ── relay subscriber ─────────────────────────────────────────────────

const dispatcherDid = `did:web:${DISPATCHER_HOST}`;
const { handleRequest } = createSubscriberFactory({ app });

async function getServiceAuthToken(lxm: string): Promise<string> {
  return await signServiceAuth(signer, {
    aud: dispatcherDid,
    lxm,
  });
}

runSubscriber({
  label: "xrpc-relay-pds",
  keypair,
  getServiceAuthToken,
  dispatcherHost: DISPATCHER_HOST,
  handleRequest,
  subscribe,
  onLog: (e) => console.log(JSON.stringify({
    event: "relay",
    severity: e.severity,
    message: e.message,
  })),
  onRegistered: (info) => {
    relaySubdomain = info.subdomain;
    relayProxyRef = info.proxyRef;
    console.log(JSON.stringify({
      event: "relay_registered",
      subdomain: info.subdomain,
      proxyRef: info.proxyRef,
    }));
    relayRegistered?.(info);
  },
  onSubscriptionOpen: (sub) => console.log(JSON.stringify({
    event: "relay_subscription_open",
    subscriptionId: sub.subscriptionId,
    nsid: sub.nsid,
    params: sub.params,
  })),
  onStatus: (status) => console.log(JSON.stringify({
    event: "relay_status",
    status,
  })),
});

console.log(JSON.stringify({ event: "relay_connecting", dispatcherHost: DISPATCHER_HOST }));

// ── helpers: create signed records via RepoApi ───────────────────────

/** Create an unsigned record in own repo. Returns { uri, cid }. */
async function createRepoRecord(
  collection: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  const rkey = TID.next().toString();
  await api.applyWrites(did, [{ action: "create", collection, rkey, record }]);
  const rec = await api.getRecord(did, collection, rkey);
  return { uri: `at://${did}/${collection}/${rkey}`, cid: rec?.cid ?? "" };
}

/** Create a badge.blue-signed record in own repo. Returns { uri, cid }. */
async function createSignedRepoRecord(
  collection: string,
  record: Record<string, unknown>,
  attestationKp: AttestationKeypair,
  issuer?: string,
): Promise<{ uri: string; cid: string }> {
  const rkey = TID.next().toString();
  const att = attestationFor(attestationKp, issuer);
  // Inline attestation (signing a record in own repo). The @atiproto library
  // returns SignatureEntry (InlineAttestation | RemoteAttestation); cast since
  // this is always inline (has key + signature, no uri).
  const entry = await att.sign({ record, repository: did }) as InlineAttestation;
  const signed = { ...record, signatures: [toStorableEntry(entry)] };
  await api.applyWrites(did, [{ action: "create", collection, rkey, record: signed }]);
  const rec = await api.getRecord(did, collection, rkey);
  return { uri: `at://${did}/${collection}/${rkey}`, cid: rec?.cid ?? "" };
}

// ── helpers: submit to bidder endpoints ──────────────────────────────

// Minimal procedure lexicon stubs so XrpcClient.call() can resolve the HTTP
// method (POST) and build the `/xrpc/<nsid>` request URL for each submit*;
// without a registered lexicon it throws "Lexicon not found". Mirrors
// lib/market's MARKET_PROCEDURE_LEXICONS — we only send these three (submitBid
// is received, not sent, by this server).
const SUBMIT_PROCEDURE_LEXICONS = [
  SUBMIT_RFP_NSID,
  SUBMIT_ACCEPT_NSID,
  SUBMIT_EVENT_NSID,
].map((id) => ({
  lexicon: 1 as const,
  id,
  defs: { main: { type: "procedure" as const } },
})) as ConstructorParameters<typeof XrpcClient>[1];

/** Resolve a DID ref or HTTP URL to a service origin and service-auth aud. */
async function resolveBidderEndpoint(
  endpointUrl: string,
): Promise<{ service: string; audDid: string } | null> {
  if (endpointUrl.startsWith("http://") || endpointUrl.startsWith("https://")) {
    return {
      service: endpointUrl.replace(/\/+$/, ""),
      audDid: `did:web:${new URL(endpointUrl).host}`,
    };
  }
  if (endpointUrl.startsWith("did:")) {
    const didPart = endpointUrl.split("#")[0];
    const svcDoc = await idResolver.did.resolve(didPart);
    const svcId = endpointUrl.includes("#") ? endpointUrl.split("#")[1] : "pdr_temp_market";
    const svc = (svcDoc?.service ?? []).find((s: { id: string }) => s.id === `#${svcId}`);
    const svcEndpoint = (svc as { serviceEndpoint?: string } | undefined)?.serviceEndpoint;
    if (!svcEndpoint) return null;
    return {
      service: svcEndpoint.replace(/\/+$/, ""),
      audDid: didPart,
    };
  }
  return null;
}

/**
 * POST an XRPC procedure to a bidder via the official @atproto/xrpc client.
 * XrpcClient builds the `/xrpc/<nsid>` URL, lexicon-encodes the JSON body, and
 * parses/validates the response. We attach the inter-service service-auth JWT
 * (aud = bidder DID, lxm = method NSID) as a bearer token: this server is its
 * own repo PDS, so it mints the token directly rather than routing through an
 * upstream PDS via the `atproto-proxy` header (the path MarketClient uses).
 * Non-2xx responses surface as a thrown XRPCError, which we fold back into the
 * { status, ok, body } shape the callers expect.
 */
async function callBidder(
  service: string,
  nsid: string,
  lxm: string,
  audDid: string,
  body: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const token = await signServiceAuth(signer, { aud: audDid, lxm });
  const client = new XrpcClient(service, SUBMIT_PROCEDURE_LEXICONS);
  try {
    const res = await client.call(nsid, {}, body, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: 200, ok: true, body: res.data };
  } catch (err) {
    const xe = XRPCError.from(err);
    return {
      status: typeof xe.status === "number" ? xe.status : 0,
      ok: false,
      body: { error: xe.error, message: xe.message },
    };
  }
}

// ── compute contract request flow ────────────────────────────────────

{
  const vmNameIdx = Deno.args.indexOf("--vm-name");
  const vmName = vmNameIdx >= 0 ? Deno.args[vmNameIdx + 1] ?? "compute" : "compute";
  const bidWindowIdx = Deno.args.indexOf("--bid-window-sec");
  const bidWindowSec = bidWindowIdx >= 0 ? parseInt(Deno.args[bidWindowIdx + 1] ?? "30", 10) : 30;
  // Program to run for a one-off (non-TTY) session; ignored when interactive.
  const execIdx = Deno.args.indexOf("--exec");
  const execProgram = execIdx >= 0 ? Deno.args[execIdx + 1] ?? "bash" : "bash";
  // When set, keep the VM after the ssh session exits (skip vm.delete event).
  const noDelete = Deno.args.includes("--no-delete");
  // How long to wait for sshd to answer through the tunnel before giving up.
  const vmReadyTimeoutIdx = Deno.args.indexOf("--vm-ready-timeout-sec");
  const vmReadyTimeoutSec = vmReadyTimeoutIdx >= 0 ? parseInt(Deno.args[vmReadyTimeoutIdx + 1] ?? "300", 10) : 300;

  let cloudInit = "";

  // Wait for relay registration.
  const { proxyRef } = await relayReady;
  console.log(JSON.stringify({ event: "relay_ready_for_rfp", proxyRef }));

  // Host the relay serves the VM's websocat→sshd tunnel at. The VM's
  // fedproxy-client connects with SERVICE=<vmName> and HANDLE=<did:plc> (see
  // cloud-init), and the relay flattens that to
  // `flattenLabel(vmName)--flattenLabel(did).<FEDPROXY_HOST>`. Recompute the
  // same name so we poll/ssh exactly what the relay registered.
  const vmFqdn = `${flattenLabel(vmName)}--${flattenLabel(did)}.${FEDPROXY_HOST}`;

  // Generate an SSH keypair; the public key is injected into root's
  // authorized_keys via the websocat default cloud-init, replacing whatever was
  // read from stdin. sshd is loopback-only and reached through the
  // websocat→fedproxy WebSocket tunnel.
  const { publicKey: sshAuthorizedKey, privateKeyPath } = await generateSshKeypair(vmName);
  console.log(JSON.stringify({
    event: "ssh_keypair_generated",
    privateKeyPath,
    publicKey: sshAuthorizedKey,
    vmFqdn,
    hint: `ssh -i ${privateKeyPath} -o ProxyCommand='websocat --binary wss://${vmFqdn}' root@${vmFqdn}`,
  }));

  cloudInit = buildDefaultUserData({
    vmName,
    didPlc: did,
    didPlcKey: did.replace(/^did:plc:/, ""),
    xrpcRelaySubdomain: relaySubdomain,
    sshAuthorizedKey,
  });

  // Build attestation keypair from server identity key.
  const kp = await loadOrGenerateKeypair(
    PRIVATE_KEY_HEX ||
      Array.from(await keypair.export()).map((b) => b.toString(16).padStart(2, "0")).join(""),
  );

  // 1. Create compute.vm record.
  const { uri: vmUri, cid: vmCid } = await createRepoRecord(COMPUTE_VM_NSID, {
    $type: COMPUTE_VM_NSID,
    role: vmName.trim() || "compute",
    user_data: cloudInit,
    createdAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({ event: "vm_record_created", uri: vmUri, cid: vmCid }));

  // 2. Create signed market.rfp.
  const { uri: rfpUri, cid: rfpCid } = await createSignedRepoRecord(RFP_NSID, {
    $type: RFP_NSID,
    domain: "compute",
    payload: { $type: "com.atproto.repo.strongRef", uri: vmUri, cid: vmCid },
    submitBid: `${proxyRef}#pdr_temp_market`,
    createdAt: new Date().toISOString(),
  }, kp, proxyRef);
  console.log(JSON.stringify({ event: "rfp_created", uri: rfpUri, cid: rfpCid }));

  // 3. Discover bidder DIDs and submit RFP.
  const DEFAULT_BIDDER_DIDS = ["did:plc:5svqtrhheairglgiiyvutzik"];
  let vouchedDids: string[] = [];
  try {
    const vouchRecords = await api.listRecords(did, VOUCH_NSID);
    vouchedDids = Array.from(new Set(
      (vouchRecords?.records ?? [])
        .filter((r) => (r.value as Record<string, unknown>).kind !== "denounce")
        .map((r) => r.uri.split("/").pop() ?? "")
        .filter((rkey) => rkey.startsWith("did:"))
    ));
    console.log(JSON.stringify({ event: "vouch_discovery", count: vouchedDids.length }));
  } catch (err) {
    console.log(JSON.stringify({ event: "vouch_discovery_error", error: String(err) }));
  }
  const bidderDids = Array.from(new Set([...DEFAULT_BIDDER_DIDS, ...vouchedDids]));
  console.log(JSON.stringify({ event: "bidder_discovery", total: bidderDids.length }));

  for (const bidderDid of bidderDids) {
    try {
      const doc = await idResolver.did.resolve(bidderDid);
      if (!doc) continue;
      const pdsUrl = getPdsEndpoint(doc);
      if (!pdsUrl) continue;
      const offerings = await listRecordsAll(pdsUrl, bidderDid, OFFERING_NSID);
      for (const offering of offerings) {
        const appliesTo = offering.value.appliesTo as string[] | undefined;
        const endpointUrl = offering.value.endpointUrl as string | undefined;
        if (!endpointUrl || !Array.isArray(appliesTo) || !appliesTo.includes(COMPUTE_VM_NSID)) continue;

        const target = await resolveBidderEndpoint(endpointUrl);
        if (!target) {
          console.log(JSON.stringify({ event: "bidder_unknown_endpoint", endpointUrl }));
          continue;
        }
        console.log(JSON.stringify({ event: "submitting_rfp", bidderDid, endpointUrl }));
        const r = await callBidder(target.service, SUBMIT_RFP_NSID, SUBMIT_RFP_LXM, target.audDid, { rfpUri, rfpCid });
        console.log(JSON.stringify({ event: "submitRfp_result", bidderDid, status: r.status, ok: r.ok }));
      }
    } catch (err) {
      console.log(JSON.stringify({ event: "bidder_error", bidderDid, error: String(err) }));
    }
  }

  // 4. Wait for bids.
  console.log(JSON.stringify({ event: "waiting_for_bids", bidWindowSec }));
  await new Promise<void>((resolve) => setTimeout(resolve, bidWindowSec * 1000));

  const bids = pendingBids.get(rfpUri) ?? [];
  pendingBids.delete(rfpUri);
  console.log(JSON.stringify({ event: "bids_collected", count: bids.length }));

  if (bids.length === 0) {
    console.log(JSON.stringify({ event: "no_bids", error: `no bids received within ${bidWindowSec}s` }));
  } else {
    // 5. Pick lowest-cost winner.
    const winner = bids.reduce((best, b) => {
      const cost = (n: CollectedBid) => Number((n.record.payload as Record<string, unknown> | undefined)?.cost ?? Infinity);
      return cost(b) < cost(best) ? b : best;
    }, bids[0]);
    console.log(JSON.stringify({ event: "winner", uri: winner.uri, did: winner.did }));

    // 6. Create signed market.accept.
    const { uri: acceptUri, cid: acceptCid } = await createSignedRepoRecord(ACCEPT_NSID, {
      $type: ACCEPT_NSID,
      rfp: { $type: "com.atproto.repo.strongRef", uri: rfpUri, cid: rfpCid },
      bid: { $type: "com.atproto.repo.strongRef", uri: winner.uri, cid: winner.cid },
      submitEvent: `${proxyRef}#pdr_temp_compute_event`,
      createdAt: new Date().toISOString(),
    }, kp, proxyRef);
    console.log(JSON.stringify({ event: "accept_created", uri: acceptUri, cid: acceptCid }));

    // 7. Submit accept to winning bidder.
    const submitAcceptTarget = winner.record.submitAccept as string | undefined;
    let receiptUri: string | undefined;
    let receiptCid: string | undefined;
    let submitEventRef: string | undefined;

    if (submitAcceptTarget) {
      const target = await resolveBidderEndpoint(submitAcceptTarget);
      if (target) {
        console.log(JSON.stringify({ event: "submitting_accept", target: submitAcceptTarget }));
        const r = await callBidder(target.service, SUBMIT_ACCEPT_NSID, SUBMIT_ACCEPT_LXM, target.audDid, { acceptUri, acceptCid });
        const body = r.body as { id?: string; uri?: string; cid?: string; submitEvent?: string };
        receiptUri = body.uri;
        receiptCid = body.cid;
        submitEventRef = body.submitEvent;
        console.log(JSON.stringify({ event: "submitAccept_result", status: r.status, receiptUri, receiptCid, submitEventRef }));
      } else {
        console.log(JSON.stringify({ event: "accept_target_unresolvable", submitAcceptTarget }));
      }
    }

    // 8. Output result as JSON to stdout.
    console.log(JSON.stringify({
      event: "compute_request_complete",
      vmUri, vmCid,
      rfpUri, rfpCid,
      acceptUri, acceptCid,
      bidUri: winner.uri, bidCid: winner.cid, winnerDid: winner.did,
      receiptUri, receiptCid, submitEventRef,
    }));

    // 9. Wait for the VM to come up, then drop the operator into it over the
    // websocat tunnel. When stdin is a TTY this is an interactive shell;
    // otherwise it runs `execProgram` (default bash) one-off.
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event, ...extra }));

    log("vm_ssh_waiting", { vmFqdn, timeoutSec: vmReadyTimeoutSec });
    const ready = await pollSshReady(privateKeyPath, vmFqdn, vmReadyTimeoutSec * 1000, log);

    if (!ready) {
      log("vm_ssh_unavailable", { vmFqdn });
    } else {
      const code = await runSshSession(privateKeyPath, vmFqdn, execProgram);
      log("vm_ssh_session_exit", { vmFqdn, code });
    }

    // 10. Tear the VM down (unless --no-delete) by reporting a
    // compute.events.vm.delete event to the bidder's submitEvent endpoint
    // returned in the receipt. The provider treats the VM as a black box and
    // can't observe that our session ended, so we tell it explicitly.
    if (noDelete) {
      log("vm_delete_skipped", { reason: "--no-delete" });
    } else if (!receiptUri || !receiptCid || !submitEventRef) {
      log("vm_delete_skipped", { reason: "missing receipt strongRef or submitEvent endpoint", receiptUri, receiptCid, submitEventRef });
    } else {
      try {
        const nowIso = new Date().toISOString();
        // Signed payload record describing the deletion (resolved + verified
        // by the provider's submitEvent handler via badge.blue).
        const { uri: delUri, cid: delCid } = await createSignedRepoRecord(
          COMPUTE_EVENTS_VM_DELETE_NSID,
          { $type: COMPUTE_EVENTS_VM_DELETE_NSID, reason: "session_ended", createdAt: nowIso },
          kp, proxyRef,
        );
        // Signed market.event wrapping the receipt + delete payload strongRefs.
        const eventRecord = {
          $type: EVENT_NSID,
          receipt: { $type: "com.atproto.repo.strongRef", uri: receiptUri, cid: receiptCid },
          payload: { $type: "com.atproto.repo.strongRef", uri: delUri, cid: delCid },
          createdAt: nowIso,
        };
        const { uri: eventUri, cid: eventCid } = await createSignedRepoRecord(
          EVENT_NSID, eventRecord, kp, proxyRef,
        );
        const target = await resolveBidderEndpoint(submitEventRef);
        if (!target) {
          log("vm_delete_target_unresolvable", { submitEventRef });
        } else {
          log("submitting_vm_delete", { submitEventRef, eventUri });
          const r = await callBidder(target.service, SUBMIT_EVENT_NSID, SUBMIT_EVENT_LXM, target.audDid, {
            uri: eventUri,
            cid: eventCid,
            record: eventRecord,
          });
          log("vm_delete_result", { status: r.status, ok: r.ok });
        }
      } catch (err) {
        log("vm_delete_error", { error: String(err) });
      }
    }
  }
}
