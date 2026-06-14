/**
 * xrpc-relay-pds — atproto repo PDS server + relay subscriber
 *
 * Exports:
 *   createRequesterPDS()    – keypair → did:plc → repo factory → relay subscriber
 *   runComputeContract()    – VM → RFP → collect bids → accept → receipt → vm.delete
 *
 * When run directly (import.meta.main), starts the PDS and runs the full flow.
 *
 * Run:
 *   PORT=8080 deno run -A server.ts [--vm-name my-vm] [--bid-window-sec 30]
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
import {
  loadOrGenerateKeypair,
  attestationFor,
  toStorableEntry,
  listRecordsAll,
  createSubmitBidHandler,
  createRecordResolver,
  verifyRecordSignatures,
  verifyRemoteProof,
  stripResolved,
  atUriAuthority,
  discoverBiddersFromRegistries,
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
  LIST_BIDDERS_NSID,
} from "@publicdomainrelay/lexicons";

const VOUCH_NSID = "sh.tangled.graph.vouch";
import { TID } from "@atproto/common";
import { buildDefaultUserData } from "./cloud-init-presets.ts";

// ── dns label helper ─────────────────────────────────────────────────

/** Mirror atprp-ssh-relay's flattenLabel. Must stay in sync with
 *  cmd/atprp-ssh-relay/main.go:flattenLabel. */
export function flattenLabel(s: string): string {
  return s.replace(/[.:]/g, "-");
}

// ── ssh keypair ──────────────────────────────────────────────────────

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

async function runSshSession(
  privateKeyPath: string,
  fqdn: string,
  program: string,
): Promise<number> {
  const interactive = Deno.stdin.isTerminal();
  const args = [...sshTunnelArgs(privateKeyPath, fqdn)];
  if (interactive) {
    args.push("-tt", `root@${fqdn}`);
  } else {
    args.push(`root@${fqdn}`, program);
  }
  const cmd = new Deno.Command("ssh", { args, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const child = cmd.spawn();
  const { code } = await child.status;
  return code;
}

// ── exported types ───────────────────────────────────────────────────

export interface PDSOptions {
  port?: number;
  privateKeyHex?: string;
  plcDirectoryUrl?: string;
  dispatcherHost?: string;
  /** Label for relay log lines. */
  label?: string;
}

export type CollectedBid = {
  did: string;
  uri: string;
  cid: string;
  record: Record<string, unknown>;
};

export interface RequesterPDS {
  did: string;
  signer: Signer;
  keypair: Secp256k1Keypair;
  api: ReturnType<typeof createRepoFactory>["api"];
  app: ReturnType<typeof createRepoFactory>["app"];
  proxyRef: string;
  relaySubdomain: string;
  relayReady: Promise<{ subdomain: string; proxyRef: string }>;
  pendingBids: Map<string, CollectedBid[]>;
  stop: () => void;
  createRepoRecord(collection: string, record: Record<string, unknown>): Promise<{ uri: string; cid: string }>;
  createSignedRepoRecord(collection: string, record: Record<string, unknown>, attestationKp: AttestationKeypair, issuer?: string): Promise<{ uri: string; cid: string }>;
  resolveBidderEndpoint(endpointUrl: string): Promise<{ targetUrl: string; audDid: string } | null>;
  callBidder(targetBase: string, nsid: string, lxm: string, audDid: string, body: Record<string, unknown>): Promise<{ status: number; ok: boolean; body: unknown }>;
  attestationKp: AttestationKeypair;
  privateKeyHex: string;
}

export interface ContractFlowOptions {
  vmName?: string;
  bidWindowSec?: number;
  /** Additional bidder DIDs beyond the defaults. */
  extraBidderDids?: string[];
  /** DIDs to exclude from bidding, even if in defaults or vouched. */
  denyBidderDids?: string[];
  /** Skip SSH wait+session + cloud-init generation. */
  skipSsh?: boolean;
  /** For non-TTY sessions: program to run in the VM. */
  execProgram?: string;
  /** Keep the VM after the ssh session exits (skip vm.delete event). */
  noDelete?: boolean;
  /** How long to wait for sshd to answer through the tunnel. */
  vmReadyTimeoutSec?: number;
  /** Called just before the interactive SSH session starts. */
  onSshStart?: () => void;
  /** Called just after the interactive SSH session ends. */
  onSshEnd?: () => void | Promise<void>;
}

// ── createRequesterPDS ───────────────────────────────────────────────

export async function createRequesterPDS(opts: PDSOptions = {}): Promise<RequesterPDS> {
  const PORT = opts.port ?? parseInt(Deno.env.get("PORT") ?? "8080");
  const PRIVATE_KEY_HEX = opts.privateKeyHex ?? Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
  const PLC_DIRECTORY_URL = opts.plcDirectoryUrl ?? Deno.env.get("PLC_DIRECTORY_URL") ?? "https://plc.directory";
  const DISPATCHER_HOST = opts.dispatcherHost ?? Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
  const BASE_ORIGIN = Deno.env.get("BASE_ORIGIN") ?? `http://localhost:${PORT}`;
  const LABEL = opts.label ?? "xrpc-relay-pds";

  // ── keypair ────────────────────────────────────────────────────

  const keypair = PRIVATE_KEY_HEX
    ? await Secp256k1Keypair.import(PRIVATE_KEY_HEX)
    : await Secp256k1Keypair.create({ exportable: true });

  const privateKeyHex = PRIVATE_KEY_HEX ||
    Array.from(await keypair.export()).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (!PRIVATE_KEY_HEX) {
    console.log(JSON.stringify({
      event: "keypair_generated",
      hint: "set REPO_PRIVATE_KEY_HEX to reuse this identity",
      // private_key_hex: privateKeyHex,
      did_key: keypair.did(),
    }));
  }

  // ── attestation keypair (same raw bytes) ───────────────────────

  const attestationKp = await loadOrGenerateKeypair(privateKeyHex);

  // ── did:plc registration ───────────────────────────────────────

  const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });
  const signingKeyDid = keypair.did();

  const { did, op } = await createGenesisOp({
    rotationKeys: [signingKeyDid],
    verificationMethods: {
      atproto: signingKeyDid,
      // Publish the attestation key so badge.blue inline signatures on market
      // records verify against the DID document. Required when the receiving
      // handler has bindKeys: true.
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

  console.log(JSON.stringify({ event: "did_plc_registering", did }));
  await plc.submitOp(did, op);
  console.log(JSON.stringify({ event: "did_plc_registered", did }));

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

  // ── pending bids ────────────────────────────────────────────────

  const pendingBids: Map<string, CollectedBid[]> = new Map();

  // ── repo factory ────────────────────────────────────────────────

  const { app, subscribe, api } = createRepoFactory({
    storage: new MemoryStorage(),
    signer,
    baseOrigin: BASE_ORIGIN,
    // Publish the same market services in the did:web doc as in the PLC doc, so
    // an RFP that advertises submitBid as a did:web proxyRef resolves to this
    // endpoint. Mirrors the `services` block in the genesis op above.
    didWebServices: [
      { id: "pdr_temp_market", type: "PDRTempMarket" },
      { id: "pdr_temp_compute_event", type: "PDRTempComputeEvent" },
    ],
  });

  const logInfo = (obj: Record<string, unknown>) => console.log(JSON.stringify(obj));

  // ── request/response logging ────────────────────────────────────
  app.use("*", async (c, next) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const start = Date.now();
    logInfo({ event: "request", method, path });
    await next();
    const status = c.res.status;
    const durationMs = Date.now() - start;
    let responseBody: unknown;
    try {
      const text = await c.res.clone().text();
      try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    } catch { responseBody = null; }
    const event = status >= 400 ? "response_error" : "response";
    logInfo({ event, method, path, status, durationMs, responseBody });
  });

  // ── submitBid handler ───────────────────────────────────────────

  const idResolver = new IdResolver();

  const onBid: SubmitBidCallback = ({ uri, cid, record, issuerDid }) => {
    const rfpUri = (record.rfp as Record<string, unknown> | undefined)?.uri as string | undefined;
    if (!rfpUri) return;
    const queue = pendingBids.get(rfpUri) ?? [];
    queue.push({ did: issuerDid, uri, cid, record: record as unknown as Record<string, unknown> });
    pendingBids.set(rfpUri, queue);
    console.log(JSON.stringify({ event: "submitBid_queued", callerDid: issuerDid, uri, rfpUri }));
  };

  const bidHandler = createSubmitBidHandler({
    deps: {
      hostname: (req: Request) => {
        const host = req.headers.get("host") ?? req.headers.get("x-forwarded-host");
        return host ? host.split(":")[0] : relaySubdomain
          ? `${relaySubdomain}.${DISPATCHER_HOST}`
          : DISPATCHER_HOST;
      },
      idResolver,
      resolve: createRecordResolver(idResolver),
      // RFPs advertise submitBid as `${did:plc}#pdr_temp_market` (the did:plc
      // PLC doc publishes the service; the relay subdomain did:web does not), so
      // a bidder's PDS proxies to the did:plc and mints `aud: did:plc[#svc]`.
      // Accept our own did:plc as an audience alongside the host did:web.
      audienceDids: [did],
    },
    serviceIds: ["pdr_temp_market"],
    onBid,
  });
  app.post(`/xrpc/${SUBMIT_BID_NSID}`, (c) => bidHandler(c.req.raw));

  // ── HTTP server ─────────────────────────────────────────────────

  const serverController = new AbortController();
  Deno.serve({ port: PORT, signal: serverController.signal }, app.fetch);

  logInfo({ event: "listening", port: PORT, did, baseOrigin: BASE_ORIGIN });

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
    subscribe,
    onLog: (e) => logInfo({
      event: "relay",
      severity: e.severity,
      message: e.message,
    }),
    onRegistered: (info) => {
      relaySubdomain = info.subdomain;
      relayProxyRef = info.proxyRef;
      logInfo({
        event: "relay_registered",
        subdomain: info.subdomain,
        proxyRef: info.proxyRef,
      });
      relayRegistered?.(info);
    },
    onSubscriptionOpen: (sub) => logInfo({
      event: "relay_subscription_open",
      subscriptionId: sub.subscriptionId,
      nsid: sub.nsid,
      params: sub.params,
    }),
    onStatus: (status) => logInfo({ event: "relay_status", status }),
  });

  logInfo({ event: "relay_connecting", dispatcherHost: DISPATCHER_HOST });

  // ── helpers ─────────────────────────────────────────────────────

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
    aKp: AttestationKeypair,
    issuer?: string,
  ): Promise<{ uri: string; cid: string }> {
    const rkey = TID.next().toString();
    const att = attestationFor(aKp, issuer);
    const entry = await att.sign({ record, repository: did }) as InlineAttestation;
    const signed = { ...record, signatures: [toStorableEntry(entry)] };
    await api.applyWrites(did, [{ action: "create", collection, rkey, record: signed }]);
    const rec = await api.getRecord(did, collection, rkey);
    return { uri: `at://${did}/${collection}/${rkey}`, cid: rec?.cid ?? "" };
  }

  async function resolveBidderEndpoint(
    endpointUrl: string,
  ): Promise<{ targetUrl: string; audDid: string } | null> {
    if (endpointUrl.startsWith("http://") || endpointUrl.startsWith("https://")) {
      return {
        targetUrl: `${endpointUrl.replace(/\/+$/, "")}/xrpc`,
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
      // The service is fronted by the relay at the endpoint's host, so the
      // service-auth JWT's aud must be the did:web at that host, not the
      // did:plc the service definition lives in. The relay verifies the token
      // against its own did:web identity.
      const svcHost = new URL(svcEndpoint).host;
      return {
        targetUrl: `${svcEndpoint.replace(/\/+$/, "")}/xrpc`,
        audDid: `did:web:${svcHost}`,
      };
    }
    return null;
  }

  async function callBidder(
    targetBase: string,
    nsid: string,
    lxm: string,
    audDid: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; ok: boolean; body: unknown }> {
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

  return {
    did,
    signer,
    keypair,
    api,
    app,
    proxyRef: relayProxyRef,
    relaySubdomain,
    relayReady,
    pendingBids,
    stop: () => { relayController.stop(); serverController.abort(); },
    createRepoRecord,
    createSignedRepoRecord,
    resolveBidderEndpoint,
    callBidder,
    attestationKp,
    privateKeyHex,
  };
}

// ── runComputeContract ───────────────────────────────────────────────

export async function runComputeContract(
  pds: RequesterPDS,
  opts: ContractFlowOptions = {},
): Promise<Record<string, unknown>> {
  const vmName = opts.vmName ?? "compute";
  const bidWindowSec = opts.bidWindowSec ?? 30;
  const skipSsh = opts.skipSsh ?? false;
  const execProgram = opts.execProgram ?? "bash";
  const noDelete = opts.noDelete ?? false;
  const vmReadyTimeoutSec = opts.vmReadyTimeoutSec ?? 300;
  const extraBidderDids = opts.extraBidderDids ?? [];
  const denyBidderDids = opts.denyBidderDids ?? [];

  const { proxyRef, subdomain: relaySubdomain } = await pds.relayReady;
  pds.proxyRef = proxyRef;
  pds.relaySubdomain = relaySubdomain;

  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, ...extra }));

  log("relay_ready_for_rfp", { proxyRef });

  let cloudInit = "";
  let privateKeyPath = "";
  let vmFqdn = "";

  if (!skipSsh) {
    vmFqdn = `${flattenLabel(vmName)}--${flattenLabel(pds.did)}.fedproxy.com`;
    const ssh = await generateSshKeypair(vmName);
    privateKeyPath = ssh.privateKeyPath;
    log("ssh_keypair_generated", {
      privateKeyPath,
      publicKey: ssh.publicKey,
      vmFqdn,
      hint: `ssh -i ${privateKeyPath} -o ProxyCommand='websocat --binary wss://${vmFqdn}' root@${vmFqdn}`,
    });

    cloudInit = buildDefaultUserData({
      vmName,
      didPlc: pds.did,
      didPlcKey: pds.did.replace(/^did:plc:/, ""),
      xrpcRelaySubdomain: relaySubdomain,
      sshAuthorizedKey: ssh.publicKey,
    });
  } else {
    cloudInit = `#cloud-config
packages:
  - curl
runcmd:
  - echo "test VM (no sshd) ready" | tee /tmp/ready
`;
  }

  // 1. Create compute.vm record.
  const { uri: vmUri, cid: vmCid } = await pds.createRepoRecord(COMPUTE_VM_NSID, {
    $type: COMPUTE_VM_NSID,
    role: vmName.trim() || "compute",
    user_data: cloudInit,
    createdAt: new Date().toISOString(),
  });
  log("vm_record_created", { uri: vmUri, cid: vmCid });

  // 2. Create signed market.rfp.
  const { uri: rfpUri, cid: rfpCid } = await pds.createSignedRepoRecord(RFP_NSID, {
    $type: RFP_NSID,
    domain: "compute",
    payload: { $type: "com.atproto.repo.strongRef", uri: vmUri, cid: vmCid },
    // Use did:plc (not proxyRef/did:web) so the bidder can resolve the
    // pdr_temp_market service published in this DID's PLC document.  did:web
    // at the relay subdomain serves only atproto_pds via the factory default.
    submitBid: `${pds.did}#pdr_temp_market`,
    createdAt: new Date().toISOString(),
    // Bind the inline attestation's issuer to the did:plc — its PLC document
    // publishes the #attestation verificationMethod, and it is also the RFP's
    // repository. The did:web proxyRef subdomain serves only atproto_pds and
    // does NOT publish the attestation key, so a bindKeys verifier (e.g. the
    // bidder) rejects an issuer=did:web signature as unbindable.
  }, pds.attestationKp, pds.did);
  log("rfp_created", { uri: rfpUri, cid: rfpCid });

  // 3. Discover bidder DIDs and submit RFP.
  const DEFAULT_BIDDER_DIDS = ["did:plc:5svqtrhheairglgiiyvutzik"];
  let vouchedDids: string[] = [];
  try {
    const vouchRecords = await pds.api.listRecords(pds.did, VOUCH_NSID);
    vouchedDids = Array.from(new Set(
      (vouchRecords?.records ?? [])
        .filter((r) => (r.value as Record<string, unknown>).kind !== "denounce")
        .map((r) => r.uri.split("/").pop() ?? "")
        .filter((rkey) => rkey.startsWith("did:"))
    ));
    log("vouch_discovery", { count: vouchedDids.length });
  } catch (err) {
    log("vouch_discovery_error", { error: String(err) });
  }

  // ── registry-based discovery ───────────────────────────────────────
  let registryDids: string[] = [];
  try {
    const idResolverForReg = new IdResolver();
    const registryResult = await discoverBiddersFromRegistries({
      payloadNsid: COMPUTE_VM_NSID,
      callListBidders: async (endpointUrl, payloadNsid) => {
        // Resolve the registry endpoint: did:web:HOST#pdr_temp_market → https://HOST/xrpc
        let targetBase: string;
        let audDid: string;
        if (endpointUrl.startsWith("http://") || endpointUrl.startsWith("https://")) {
          targetBase = `${endpointUrl.replace(/\/+$/, "")}/xrpc`;
          audDid = `did:web:${new URL(endpointUrl).host}`;
        } else if (endpointUrl.startsWith("did:")) {
          const didPart = endpointUrl.split("#")[0];
          const svcDoc = await idResolverForReg.did.resolve(didPart);
          const svcId = endpointUrl.includes("#") ? endpointUrl.split("#")[1] : "pdr_temp_market";
          const svc = (svcDoc?.service ?? []).find((s: { id: string }) => s.id === `#${svcId}`);
          if (!svc) throw new Error(`service ${svcId} not found in DID doc`);
          const ep = (svc as { serviceEndpoint: string }).serviceEndpoint.replace(/\/+$/, "");
          targetBase = `${ep}/xrpc`;
          audDid = `did:web:${new URL(ep).host}`;
        } else {
          throw new Error(`unresolvable endpoint: ${endpointUrl}`);
        }
        const token = await signServiceAuth(pds.signer, { aud: audDid, lxm: LIST_BIDDERS_NSID });
        const url = `${targetBase}/${LIST_BIDDERS_NSID}?payloadNsid=${encodeURIComponent(payloadNsid)}`;
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { bidders?: Array<{ bidderDid?: string; appliesTo?: string[] }> };
        return (data.bidders ?? []).map((b) => ({
          bidderDid: b.bidderDid ?? "",
          appliesTo: b.appliesTo ?? [],
        }));
      },
      log: (severity: string, msg: string, extra?: Record<string, unknown>) =>
        log(msg.replace(/: /g, "_"), extra),
    });
    registryDids = Array.from(registryResult);
    if (registryDids.length > 0) log("registry_discovery", { count: registryDids.length });
  } catch (err) {
    log("registry_discovery_error", { error: String(err) });
  }

  const bidderDids = Array.from(new Set([...DEFAULT_BIDDER_DIDS, ...vouchedDids, ...registryDids, ...extraBidderDids]));
  const deniedSet = new Set(denyBidderDids);
  const filteredBidderDids = bidderDids.filter(d => !deniedSet.has(d));
  log("bidder_discovery", { total: filteredBidderDids.length, denied: bidderDids.length - filteredBidderDids.length });

  const idResolver = new IdResolver();
  for (const bidderDid of filteredBidderDids) {
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

        const target = await pds.resolveBidderEndpoint(endpointUrl);
        if (!target) {
          log("bidder_unknown_endpoint", { endpointUrl });
          continue;
        }
        log("submitting_rfp", { bidderDid, endpointUrl });
        const r = await pds.callBidder(target.targetUrl, SUBMIT_RFP_NSID, SUBMIT_RFP_LXM, target.audDid, {
          rfpUri, rfpCid,
        });
        log("submitRfp_result", { bidderDid, status: r.status, ok: r.ok });
      }
    } catch (err) {
      log("bidder_error", { bidderDid, error: String(err) });
    }
  }

  // 4. Wait for bids.
  log("waiting_for_bids", { bidWindowSec });
  await new Promise<void>((resolve) => setTimeout(resolve, bidWindowSec * 1000));

  const bids = pds.pendingBids.get(rfpUri) ?? [];
  pds.pendingBids.delete(rfpUri);
  log("bids_collected", { count: bids.length });

  if (bids.length === 0) {
    const err = { event: "no_bids", error: `no bids received within ${bidWindowSec}s` };
    log("no_bids", err);
    return err;
  }

  // 5. Pick lowest-cost winner.
  const winner = bids.reduce((best, b) => {
    const cost = (n: CollectedBid) => Number((n.record.payload as Record<string, unknown> | undefined)?.cost ?? Infinity);
    return cost(b) < cost(best) ? b : best;
  }, bids[0]);
  log("winner", { uri: winner.uri, did: winner.did });

  // 6. Create signed market.accept.
  const { uri: acceptUri, cid: acceptCid } = await pds.createSignedRepoRecord(ACCEPT_NSID, {
    $type: ACCEPT_NSID,
    rfp: { $type: "com.atproto.repo.strongRef", uri: rfpUri, cid: rfpCid },
    bid: { $type: "com.atproto.repo.strongRef", uri: winner.uri, cid: winner.cid },
    submitEvent: `${pds.did}#pdr_temp_compute_event`,
    createdAt: new Date().toISOString(),
    // issuer = did:plc (publishes #attestation); did:web proxyRef does not, so a
    // bindKeys verifier rejects it. Same binding as the RFP signature above.
  }, pds.attestationKp, pds.did);
  log("accept_created", { uri: acceptUri, cid: acceptCid });

  // 7. Submit accept to winning bidder.
  const submitAcceptTarget = winner.record.submitAccept as string | undefined;
  let receiptUri: string | undefined;
  let receiptCid: string | undefined;
  let submitEventRef: string | undefined;

  if (submitAcceptTarget) {
    const target = await pds.resolveBidderEndpoint(submitAcceptTarget);
    if (target) {
      log("submitting_accept", { target: submitAcceptTarget });
      const r = await pds.callBidder(target.targetUrl, SUBMIT_ACCEPT_NSID, SUBMIT_ACCEPT_LXM, target.audDid, {
        acceptUri, acceptCid,
      });
      const body = r.body as { id?: string; uri?: string; cid?: string; submitEvent?: string };
      receiptUri = body.uri;
      receiptCid = body.cid;
      submitEventRef = body.submitEvent;
      log("submitAccept_result", { status: r.status, receiptUri, receiptCid, submitEventRef });
    } else {
      log("accept_target_unresolvable", { submitAcceptTarget });
    }
  }

  // 7b. Verify the receipt before trusting the VM. The receipt is a badge.blue
  // remote-attestation proof minted by the bidder: it must (a) carry a valid
  // inline signature in the bidder's repo, and (b) bind to *our* accept record —
  // its `cid` recomputes over the accept (in our repo) + the receipt's metadata.
  // No receipt, or either check failing, means the provider never durably
  // committed to this contract; we must not poll/use the VM.
  let receiptOk = false;
  if (receiptUri && receiptCid) {
    try {
      const resolver = createRecordResolver(new IdResolver());
      const receipt = await resolver.resolve({ uri: receiptUri, cid: receiptCid });
      const accept = await resolver.resolve({ uri: acceptUri, cid: acceptCid });
      const receiptBare = stripResolved(receipt) as Record<string, unknown>;
      const sigOk = await verifyRecordSignatures({
        record: receiptBare,
        repositoryDid: atUriAuthority(receiptUri),
      });
      const bindOk = verifyRemoteProof({
        subjectRecord: stripResolved(accept) as Record<string, unknown>,
        subjectRepositoryDid: pds.did,
        proofRecord: receiptBare,
      });
      receiptOk = sigOk && bindOk;
      log("receipt_verified", { receiptUri, sigOk, bindOk, ok: receiptOk });
    } catch (err) {
      log("receipt_verify_error", { receiptUri, error: String(err) });
    }
  } else {
    log("receipt_missing", { receiptUri, receiptCid });
  }

  const result: Record<string, unknown> = {
    event: "compute_request_complete",
    vmUri, vmCid,
    rfpUri, rfpCid,
    acceptUri, acceptCid,
    bidUri: winner.uri, bidCid: winner.cid, winnerDid: winner.did,
    receiptUri, receiptCid, submitEventRef,
    receiptOk,
    bids: bids.length,
  };
  log("compute_request_complete", result);

  // 8. SSH (skip for tests). Gated on a verified receipt: without a valid
  // provider commitment we bail out of using the VM and fall straight through to
  // teardown so we don't leave a resource we can't trust running.
  if (skipSsh) {
    // tests / headless: skip SSH regardless.
  } else if (!receiptOk) {
    log("vm_poll_bailed", { reason: "no valid receipt", receiptUri, receiptCid });
  } else {
    log("vm_ssh_waiting", { vmFqdn, timeoutSec: vmReadyTimeoutSec });
    const ready = await pollSshReady(privateKeyPath, vmFqdn, vmReadyTimeoutSec * 1000, log);
    if (!ready) {
      log("vm_ssh_unavailable", { vmFqdn });
    } else {
      opts.onSshStart?.();
      const code = await runSshSession(privateKeyPath, vmFqdn, execProgram);
      await opts.onSshEnd?.();
      log("vm_ssh_session_exit", { vmFqdn, code });
    }
  }

  // 9. Tear down VM via compute.events.vm.delete (unless --no-delete).
  if (noDelete) {
    log("vm_delete_skipped", { reason: "--no-delete" });
  } else if (!receiptUri || !receiptCid || !submitEventRef) {
    log("vm_delete_skipped", { reason: "missing receipt refs", receiptUri, receiptCid, submitEventRef });
  } else {
    try {
      const nowIso = new Date().toISOString();
      const { uri: delUri, cid: delCid } = await pds.createSignedRepoRecord(
        COMPUTE_EVENTS_VM_DELETE_NSID,
        { $type: COMPUTE_EVENTS_VM_DELETE_NSID, reason: "session_ended", createdAt: nowIso },
        pds.attestationKp, pds.did,
      );
      const eventRecord = {
        $type: EVENT_NSID,
        receipt: { $type: "com.atproto.repo.strongRef", uri: receiptUri, cid: receiptCid },
        payload: { $type: "com.atproto.repo.strongRef", uri: delUri, cid: delCid },
        createdAt: nowIso,
      };
      const { uri: eventUri, cid: eventCid } = await pds.createSignedRepoRecord(
        EVENT_NSID, eventRecord, pds.attestationKp, pds.did,
      );
      const target = await pds.resolveBidderEndpoint(submitEventRef);
      if (!target) {
        log("vm_delete_target_unresolvable", { submitEventRef });
      } else {
        log("submitting_vm_delete", { submitEventRef, eventUri });
        const r = await pds.callBidder(target.targetUrl, SUBMIT_EVENT_NSID, SUBMIT_EVENT_LXM, target.audDid, {
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

  return result;
}

// ── CLI main (when run directly) ──────────────────────────────────────

if (import.meta.main) {
  const pds = await createRequesterPDS();
  // Wait for relay registration so proxyRef is set before the flow runs.
  const { proxyRef, subdomain } = await pds.relayReady;
  pds.proxyRef = proxyRef;
  pds.relaySubdomain = subdomain;

  await runComputeContract(pds, {
    // Default `compute-<8 hex>` when --vm-name is absent (distinct per run);
    // an explicit --vm-name is used verbatim.
    vmName: (() => {
      const i = Deno.args.indexOf("--vm-name");
      if (i >= 0 && Deno.args[i + 1]) return Deno.args[i + 1];
      const b = new Uint8Array(4);
      crypto.getRandomValues(b);
      return `compute-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
    })(),
    bidWindowSec: (() => { const i = Deno.args.indexOf("--bid-window-sec"); return i >= 0 ? parseInt(Deno.args[i + 1] ?? "30", 10) : 30; })(),
    skipSsh: false,
    noDelete: Deno.args.includes("--no-delete"),
    execProgram: (() => { const i = Deno.args.indexOf("--exec"); return i >= 0 ? Deno.args[i + 1] ?? "bash" : "bash"; })(),
    vmReadyTimeoutSec: (() => { const i = Deno.args.indexOf("--vm-ready-timeout-sec"); return i >= 0 ? parseInt(Deno.args[i + 1] ?? "300", 10) : 300; })(),
  });
}
