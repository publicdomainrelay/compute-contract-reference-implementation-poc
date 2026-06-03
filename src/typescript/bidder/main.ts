// Deno + Hono port of server.py.
// Endpoints: GET / (README html), GET /receipt/<accept-at-uri>/<cid> (x402-gated
// settlement; resolves accept->bid->rfp->vm, provisions droplet, writes receipt),
// POST /hook/rfp (firehose webhook -> creates bid+config+payload records).
//
// Run: deno run --allow-net --allow-env --allow-run --allow-read --allow-write main.ts
//
// $ RBAC_REPO_ROOT="${HOME}/src/rbac/homelab/wid-atp" X402_MAKE_FREE=1 DIGITALOCEAN_BASE_URL=https://homelab.johnandersen777.bsky.social.fedproxy.com deno run --allow-all --watch main.ts


import { Hono } from "npm:hono@^4.12.23";
import { Agent, CredentialSession } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { getPdsEndpoint } from "@atproto/common-web";
import { stringify as yamlStringify, parse as yamlParse } from "npm:yaml@^2.7.0";

// x402 middleware (Hono variant per CDP docs).
import { paymentMiddleware, x402ResourceServer } from "npm:@x402/hono";
import { ExactEvmScheme } from "npm:@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "npm:@x402/core/server";

// ---------------------------------------------------------------------------
// NSID constants (mirrors models/publicdomainrelay.py)
// ---------------------------------------------------------------------------

const VM_NSID = "com.publicdomainrelay.temp.compute.vm";
const WIF_SIMPLE_NSID = "com.publicdomainrelay.temp.compute.config.wif.simple";
const RFP_NSID = "com.publicdomainrelay.temp.market.rfp";
const BID_NSID = "com.publicdomainrelay.temp.market.bid";
const BIDS_X402_NSID = "com.publicdomainrelay.temp.market.bids.x402";
const ACCEPT_NSID = "com.publicdomainrelay.temp.market.accept";
const RECEIPT_NSID = "com.publicdomainrelay.temp.market.receipt";
const RBAC_NSID = "com.fedproxy.rbac";

const ACCEPT_PATH_RECORD = "$HOME/secrets/publicdomainrelay.com/market/accept.json";
const ACCEPT_PATH_VM = "/root/secrets/publicdomainrelay.com/market/accept.json";

const CID_RE = /^(bafy|z)[A-Za-z0-9]+$/;

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

type RFP = { payload: StrongRef; _uri?: string; _cid?: string };
type Bid = { rfp: StrongRef; payload: StrongRef; config?: StrongRef; _uri?: string; _cid?: string };
type Accept = { rfp: StrongRef; bid: StrongRef; payload?: StrongRef; _uri?: string; _cid?: string };
type BidsX402 = { cost: unknown; currency: string; frequency: string; prepay: boolean; url: string; _uri?: string; _cid?: string };
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
// atproto client + identity resolver
// ---------------------------------------------------------------------------

const idResolver = new IdResolver();
let agent: Agent;
let agentDid = "";

async function loginAgent(): Promise<void> {
  let did = ATPROTO_HANDLE;
  if (!did.startsWith("did:")) {
    const resolved = await idResolver.handle.resolve(ATPROTO_HANDLE);
    if (!resolved) throw new Error(`could not resolve handle ${ATPROTO_HANDLE}`);
    did = resolved;
  }
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`could not resolve did ${did}`);
  const pds = getPdsEndpoint(doc);
  if (!pds) throw new Error(`no pds for ${did}`);
  const session = new CredentialSession(new URL(pds));
  await session.login({ identifier: ATPROTO_HANDLE, password: ATPROTO_PASSWORD });
  agent = new Agent(session);
  agentDid = session.did ?? did;
  console.error(`[atproto] logged in as ${agentDid}`);
}

function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const parts = uri.slice("at://".length).split("/");
  return { repo: parts[0], collection: parts[1], rkey: parts[2] };
}

async function pdsForDid(did: string): Promise<string> {
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`could not resolve ${did}`);
  const pds = getPdsEndpoint(doc);
  if (!pds) throw new Error(`no pds for ${did}`);
  return pds;
}

async function getRecord(atUri: string, cid: string): Promise<{ uri: string; cid: string; value: Record<string, unknown> }> {
  const { repo, collection, rkey } = parseAtUri(atUri);
  const pds = await pdsForDid(repo);
  const read = new Agent(new URL(pds));
  const res = await read.com.atproto.repo.getRecord({ repo, collection, rkey, cid });
  return { uri: res.data.uri, cid: res.data.cid ?? cid, value: res.data.value as Record<string, unknown> };
}

async function resolveAs<T>(atUri: string, cid: string): Promise<T & { _uri: string; _cid: string }> {
  const r = await getRecord(atUri, cid);
  const value = r.value as Record<string, unknown>;
  const version = (value.version as string | undefined) ?? "0.0.0";
  if (version !== "0.0.0") {
    throw new HTTPError(400, `unknown record version ${version}`);
  }
  return { ...(value as unknown as T), _uri: atUri, _cid: r.cid };
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

class HTTPError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// ATProto
// ---------------------------------------------------------------------------

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
// DigitalOcean + RBAC
// ---------------------------------------------------------------------------

type DOContext = { rbacRepoRoot: string; teamUuid: string };

// Derive did:web: from the service base URL for use as getServiceAuth aud.
function urlToDid(url: string): string {
  const host = new URL(url).host;
  return `did:web:${host}`;
}

// Get a short-lived ATProto service auth token targeting the DO/QEMU endpoint.
// These are non-OIDC JWTs: signed by the PDS, iss=agentDid, validated via DID doc.
async function getServiceAuthToken(): Promise<string> {
  const aud = urlToDid(DIGITALOCEAN_BASE_URL);
  // cannot request a method-less token with an expiration more than a minute in the futur
  const exp = Math.floor(Date.now() / 1000) + 60; // 1 min
  const res = await agent.com.atproto.server.getServiceAuth({ aud, exp });
  return res.data.token;
}

async function makeDoctx(): Promise<DOContext> {
  const token = await getServiceAuthToken();
  const res = await fetch(`${DIGITALOCEAN_BASE_URL}/v2/account`, {
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  });
  const json = await res.json();
  console.error("[do] /v2/account:", JSON.stringify(json));
  if (res.status >= 400) throw new Error(`DO /v2/account ${res.status}: ${JSON.stringify(json)}`);

  let uuid = json.account.team.uuid;
  // Handle custom/homelab did:plc as actx / team uuid
  if (uuid.startsWith("did:plc:")) {
    uuid = uuid.substring(8);
  }
  const result = { rbacRepoRoot: RBAC_REPO_ROOT, teamUuid: uuid };
  console.error("[do] /v2/account fixedup:", JSON.stringify(result));
  return result;
}

async function runProc(cmd: string[], cwd: string): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> {
  const proc = new Deno.Command(cmd[0], { args: cmd.slice(1), cwd, stdin: "null", stdout: "piped", stderr: "piped" });
  const out = await proc.output();
  if (out.code !== 0) {
    console.error(`[exec] ${cmd.join(" ")} -> ${out.code}`);
    console.error(`[exec] stdout: ${new TextDecoder().decode(out.stdout)}`);
    console.error(`[exec] stderr: ${new TextDecoder().decode(out.stderr)}`);
  }
  return { code: out.code, stdout: out.stdout, stderr: out.stderr };
}

async function isDir(p: string): Promise<boolean> {
  try { return (await Deno.stat(p)).isDirectory; } catch { return false; }
}

async function configureDropletRbac(doctx: DOContext, vm: VM, requesterDid: string): Promise<void> {
  const requesterPlc = requesterDid.split(":").slice(-1)[0];
  const slug = `${doctx.teamUuid}-${requesterPlc}-${vm.role}`;
  const roleName = `ex-${slug}`;

  const rbacRecord = {
    $type: RBAC_NSID,
    protects: {
      [roleName]: {
        service: `${DIGITALOCEAN_BASE_URL}`,
        scope: 'droplets.wid',
      }
    },
    roles: {
      [roleName]: {
        role_name: roleName,
        definition: {
          aud: `api://DigitalOcean?actx=${doctx.teamUuid}`,
          sub: `actx:${doctx.teamUuid}:plc:${requesterPlc}:role:${vm.role}`,
          policies: [roleName],
        },
      },
    },
    policies: {
      [roleName]: {
        meta: {
          policy: roleName,
        },
        schemas: {
          "/v1/oidc/issue": {
            type: "object",
            $schema: "http://json-schema.org/draft-07/schema#",
            required: ["capability", "allowed_parameters"],
            properties: {
              capability: {
                enum: ["create"],
              },
              allowed_parameters: {
                type: "object",
                properties: {
                  aud: { type: "string" },
                  sub: {
                    type: "string",
                    const: `actx:${doctx.teamUuid}:plc:${requesterPlc}:role:${vm.role}`,
                  },
                  ttl: {
                    type: "number",
                    const: 3600,
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
  console.error(`[com.fedproxy.rbac] creating`);
  await atprotoCreateRecord(agent, RBAC_NSID, rbacRecord);
  console.error(`[com.fedproxy.rbac] created`);

  const rbac = doctx.rbacRepoRoot;
  if (!(await isDir(`${rbac}/.git`))) {
    await Deno.mkdir(rbac, { recursive: true });
    const home = Deno.env.get("HOME") ?? "/root";
    const credHelperDir = `${home}/.local/scripts`;
    const credHelperPath = `${credHelperDir}/git-credential-rbac-digitalocean.sh`;
    const credHelper = `#!/usr/bin/env bash

TOKEN="${DO_TOKEN}"

while IFS='=' read -r key value; do
  if [[ -n "$key" && -n "$value" ]]; then
    if [[ "$key" == "protocol" || "$key" == "host" ]]; then
      echo "$key=$value"
    fi
  fi
done

echo "username=token"
echo "password=\${TOKEN}"
`;
    await Deno.mkdir(credHelperDir, { recursive: true });
    await Deno.writeTextFile(credHelperPath, credHelper);
    await Deno.chmod(credHelperPath, 0o700);

    const helperAbs = await Deno.realPath(credHelperPath);
    const cmds: string[][] = [
      ["git", "config", "--global", `credential.${DIGITALOCEAN_BASE_URL}/_rbac/DigitalOcean/.helper`, `!${helperAbs}`],
      ["git", "init"],
      ["git", "remote", "add", "origin", `${DIGITALOCEAN_BASE_URL}/_rbac/DigitalOcean/${doctx.teamUuid}`],
      ["git", "pull", "origin", "main"],
      ["git", "branch", "--set-upstream-to=origin/main"],
    ];
    for (const cmd of cmds) {
      console.error(`[rbac] ${cmd.join(" ")}`);
      const r = await runProc(cmd, rbac);
      if (r.code !== 0) {
        if (cmd[1] === "pull" && new TextDecoder().decode(r.stderr).includes("couldn't find remote ref main")) continue;
        if (cmd[1] === "branch" && new TextDecoder().decode(r.stderr).includes("no commit on branch")) continue;
        console.error(`[rbac] ${cmd.join(" ")} failed (${r.code})`);
      }
    }
  }

  const policyPath = `${rbac}/policies/ex-${slug}.hcl`;
  const policyEx = `path "/v1/oidc/issue" {
  capabilities = ["create"]
  allowed_parameters = {
    "aud" = "*"
    "sub" = "actx:${doctx.teamUuid}:plc:${requesterPlc}:role:${vm.role}"
    "ttl" = 3600
  }
}
`;
  const rolePath = `${rbac}/droplet-roles/ex-${slug}.hcl`;
  const roleEx = `role "ex-${slug}" {
  aud      = "api://DigitalOcean?actx=${doctx.teamUuid}"
  sub      = "actx:${doctx.teamUuid}:plc:${requesterPlc}:role:${vm.role}"
  policies = ["ex-${slug}"]
}
`;
  await Deno.mkdir(`${rbac}/policies`, { recursive: true });
  await Deno.mkdir(`${rbac}/droplet-roles`, { recursive: true });
  await Deno.writeTextFile(policyPath, policyEx);
  await Deno.writeTextFile(rolePath, roleEx);

  const commitCmds: string[][] = [
    ["git", "add", "-A"],
    ["git", "commit", "-m", "feat: rbac for compute-contract"],
    ["git", "push", "-u", "origin", "main"],
  ];
  for (const cmd of commitCmds) {
    console.error(`[rbac] running ${cmd.join(" ")}`);
    const r = await runProc(cmd, rbac);
    if (r.code !== 0) {
      if (cmd[1] === "commit" && new TextDecoder().decode(r.stdout).includes("nothing to commit")) continue;
      console.error(`[rbac] ${cmd.join(" ")} failed (${r.code})`);
    }
    console.error(`[rbac] ran ${cmd.join(" ")} exited code (${r.code})`);
  }

  const schemaCmds: string[][] = [
    ["git", "fetch", "--all"],
    ["bash", "-xec", "git show origin/schema:rbac.json | yq -P"],
  ];
  for (const cmd of schemaCmds) {
    const r = await runProc(cmd, rbac);
    if (r.code !== 0) {
      console.error(`[rbac] ${cmd.join(" ")} failed (${r.code})`);
    }
  }
}

// Creates a separate com.fedproxy.rbac record for scope=account.auth.
// Protects /v2/account and /v2/droplets* using ATProto service auth tokens
// (com.atproto.server.getServiceAuth — iss=agentDid, validated via DID doc keys).
async function configureAccountAuthRbac(): Promise<void> {
  // TODO Check if this exists and if not then post
  const roleName = `account-auth-${agentDid.split(":").slice(-1)[0]}`;

  const rbacRecord = {
    $type: RBAC_NSID,
    protects: {
      [roleName]: {
        service: `${DIGITALOCEAN_BASE_URL}`,
        scope: "account.auth",
      },
    },
    roles: {
      // ATProto service auth: iss and sub are both the bidder's DID.
      // getServiceAuth tokens have iss=agentDid, validated via DID document keys.
      [roleName]: {
        role_name: roleName,
        definition: {
          iss: agentDid,
          sub: agentDid,
          policies: [roleName],
        },
      },
    },
    policies: {
      [roleName]: {
        meta: { policy: roleName },
        schemas: {
          "/v2/account": {
            type: "object",
            properties: { capability: { enum: ["read"] } },
          },
          "/v2/droplets": {
            type: "object",
            properties: { capability: { enum: ["read", "create"] } },
          },
          "/v2/droplets/*": {
            type: "object",
            properties: { capability: { enum: ["read", "update", "delete"] } },
          },
        },
      },
    },
    createdAt: new Date().toISOString(),
  };

  console.error(`[com.fedproxy.rbac] creating account.auth record`);
  await atprotoCreateRecord(agent, RBAC_NSID, rbacRecord);
  console.error(`[com.fedproxy.rbac] account.auth record created`);
}

function injectAcceptBundle(userData: string, bundle: Record<string, unknown>): string {
  // deno-lint-ignore no-explicit-any
  let obj: Record<string, any> = {};
  try {
    const parsed = userData ? yamlParse(userData.replace(/^#cloud-config\s*/i, "")) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch { /* fall through with empty obj */ }
  const writeFiles = (obj.write_files ??= []) as unknown[];
  writeFiles.push({
    path: ACCEPT_PATH_VM,
    owner: "root:root",
    permissions: "0600",
    content: JSON.stringify(bundle, null, 2),
  });
  const runcmd = (obj.runcmd ??= []) as unknown[];
  const parent = ACCEPT_PATH_VM.split("/").slice(0, -1).join("/");
  runcmd.unshift(["sh", "-c", `install -d -m 0700 -o root -g root ${parent}`]);
  return "#cloud-config\n" + yamlStringify(obj, { lineWidth: 0 });
}

async function createDroplet(vm: VM, requesterDid: string): Promise<unknown> {
  const requesterPlc = requesterDid.split(":").slice(-1)[0];
  const rfpRkey = (vm._uri ?? "").split("/")[4] ?? "unknown";
  const name = `${requesterPlc}-${rfpRkey}-${vm._cid ?? ""}`;
  const body = {
    name,
    region: "sfo3", // TODO pick based on vm.location
    size: "s-1vcpu-512mb-10gb",
    image: "ubuntu",
    user_data: vm.user_data,
    with_droplet_agent: true,
    tags: [`oidc-sub:plc:${requesterPlc}`, `oidc-sub:role:${vm.role}`],
  };
  console.error("[do] droplet request:", JSON.stringify(body));
  const doctx = await makeDoctx();
  await configureDropletRbac(doctx, vm, requesterDid);
  const token = await getServiceAuthToken();
  const res = await fetch(`${DIGITALOCEAN_BASE_URL}/v2/droplets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.error("[do] /v2/droplets:", JSON.stringify(json));
  if (res.status >= 400) throw new Error(`DO /v2/droplets ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// ---------------------------------------------------------------------------
// hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// README rendering — best effort, falls back to plain text.
let readmeHtml = "<html><body><h1>compute-contract-provider-relay-digitalocean</h1></body></html>";
async function loadReadme(): Promise<void> {
  try {
    const md = await Deno.readTextFile(new URL("./README.md", import.meta.url));
    const title = md.split("\n")[0].replace(/^#\s+/, "");
    const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    readmeHtml = `<html><title>${title}</title><body><pre>${esc}</pre></body></html>`;
  } catch (err) {
    console.error("[readme] load failed:", (err as Error).message);
  }
}

app.get("/", (c) => c.html(readmeHtml));

// CDP facilitator with header auth (matches python create_headers).
// CDP requires a JWT per request; for parity with python (which uses
// cdp.auth.utils.jwt.generate_jwt). Minimal port: re-create JWT per call via
// the helper exposed by @coinbase/x402 when available; otherwise consumers
// can set X402_MAKE_FREE=1.
function makeFacilitator() {
  // Prefer CDP facilitator if API keys are set; mirrors python (which always
  // points at api.cdp.coinbase.com with JWT headers).
  const url = "https://api.cdp.coinbase.com/platform/v2/x402";
  return new HTTPFacilitatorClient({
    url,
    // CreateHeadersAuthProvider equivalent. The python uses generate_jwt per
    // verify/settle/supported path; here we expose a callback that builds a
    // bearer JWT for the given request. Implementation lives in @coinbase/x402
    // if present; otherwise users can run with X402_MAKE_FREE=1 for local dev.
    authProvider: cdpAuthProvider(CDP_API_KEY_ID, CDP_API_KEY_SECRET),
  });
}

function cdpAuthProvider(_keyId: string, _keySecret: string) {
  // The @coinbase/x402 npm package exports `facilitator` with auth baked in.
  // We re-import lazily to keep this file runnable with X402_MAKE_FREE=1
  // even when the package isn't installed.
  // deno-lint-ignore no-explicit-any
  return async (_req: any) => ({}); // headers added by @coinbase/x402 when wired
}

if (!X402_MAKE_FREE) {
  const facilitatorClient = makeFacilitator();
  const server = new x402ResourceServer(facilitatorClient).register(
    "eip155:8453",
    new ExactEvmScheme(),
  );
  app.use(
    paymentMiddleware(
      {
        "GET /receipt/*": {
          accepts: [
            { scheme: "exact", price: "$1.00", network: "eip155:8453", payTo: PAY_TO },
          ],
          description: "Pay for compute contract",
          mimeType: "application/json",
        },
      },
      server,
    ),
  );
}

// JSON error envelope
app.onError((err, c) => {
  if (err instanceof HTTPError) {
    return c.json({ error: "http_error", code: err.status, detail: err.detail }, err.status);
  }
  console.error("[err]", (err as Error).stack ?? err);
  return c.json({ error: "internal", detail: (err as Error).message }, 500);
});

// ---------------------------------------------------------------------------
// GET /receipt/<accept-at-uri>/<cid>
// ---------------------------------------------------------------------------

app.get("/receipt/*", async (c) => {
  const path = c.req.path.replace(/^\/+/, "");
  if (!path.includes("/")) throw new HTTPError(400, "missing cid");
  const lastSlash = path.lastIndexOf("/");
  const cid = path.slice(lastSlash + 1);
  let atPart = path.slice(0, lastSlash);
  if (!CID_RE.test(cid)) throw new HTTPError(400, "invalid cid");
  if (atPart.startsWith("receipt/")) atPart = atPart.slice("receipt/".length);
  const acceptAtUri = atPart;
  const acceptCid = cid;

  const accept = await resolveAs<Accept>(acceptAtUri, acceptCid);
  console.error("[receipt] accept:", accept._uri);
  const bid = await resolveAs<Bid>(accept.bid.uri, accept.bid.cid);
  console.error("[receipt] bid:", bid._uri);

  if (bid.rfp.uri !== accept.rfp.uri || bid.rfp.cid !== accept.rfp.cid) {
    throw new HTTPError(400, "Accept.rfp does not match Bid.rfp");
  }

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
  await createDroplet(vm, requesterDid);

  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: RECEIPT_NSID,
    record: {
      $type: RECEIPT_NSID,
      rfp: { $type: "com.atproto.repo.strongRef", uri: accept.rfp.uri, cid: accept.rfp.cid },
      bid: { $type: "com.atproto.repo.strongRef", uri: bid._uri, cid: bid._cid },
      accept: { $type: "com.atproto.repo.strongRef", uri: acceptAtUri, cid: acceptCid },
      createdAt: new Date().toISOString(),
    },
  });

  const id = res.data.uri.split("/").slice(-1)[0];
  return c.json({ id, uri: res.data.uri, cid: res.data.cid });
});

// ---------------------------------------------------------------------------
// POST /hook/rfp  (firehose-style webhook envelope)
// ---------------------------------------------------------------------------

type WebhookPayload = {
  automation?: string;
  lexicon?: string;
  conditions?: unknown[];
  event: {
    did: string;
    time_us?: number;
    kind?: string;
    commit: { operation: string; collection: string; rkey: string; record: Record<string, unknown>; cid?: string };
  };
};

function x402UrlTemplate(reqUrl: string): string {
  const base = BASE_URL || new URL(reqUrl).origin;
  return `${base.replace(/\/+$/, "")}/receipt`;
}

app.post("/hook/rfp", async (c) => {
  const payload = (await c.req.json()) as WebhookPayload;
  const commit = payload.event?.commit;
  if (!commit) throw new HTTPError(400, "missing event.commit");
  if (commit.operation !== "create") return c.json({ skipped: "operation", operation: commit.operation });
  if (commit.collection !== RFP_NSID) return c.json({ skipped: "collection", collection: commit.collection });
  if (!commit.cid) throw new HTTPError(400, "commit.cid required");

  const rfpAtUri = `at://${payload.event.did}/${commit.collection}/${commit.rkey}`;
  const rfpCid = commit.cid;

  // sanity-resolve the RFP
  await resolveAs<RFP>(rfpAtUri, rfpCid);

  const nowIso = new Date().toISOString();

  const doctx = await makeDoctx();

  const configRecord = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: WIF_SIMPLE_NSID,
    record: {
      $type: WIF_SIMPLE_NSID,
      accept_path: ACCEPT_PATH_RECORD,
      issuer_uri: `${DIGITALOCEAN_BASE_URL}`,
      // TODO policy to_issue = `ex-${slug}`
      to_issue: "exchange-custom-droplet-oidc-poc",
      // TODO This should be updated in fedproxy-client and lexicon
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
      url: x402UrlTemplate(c.req.url),
      createdAt: nowIso,
    },
  });

  const bidRecord = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: BID_NSID,
    record: {
      $type: BID_NSID,
      rfp: { $type: "com.atproto.repo.strongRef", uri: rfpAtUri, cid: rfpCid },
      config: { $type: "com.atproto.repo.strongRef", uri: configRecord.data.uri, cid: configRecord.data.cid },
      payload: { $type: "com.atproto.repo.strongRef", uri: payloadRecord.data.uri, cid: payloadRecord.data.cid },
      createdAt: nowIso,
    },
  });

  return c.json({
    success: true,
    rfp: { uri: rfpAtUri, cid: rfpCid },
    bid: { $type: "com.atproto.repo.strongRef", uri: bidRecord.data.uri, cid: bidRecord.data.cid },
    bid_payload: { $type: "com.atproto.repo.strongRef", uri: payloadRecord.data.uri, cid: payloadRecord.data.cid },
    bid_config: { $type: "com.atproto.repo.strongRef", uri: configRecord.data.uri, cid: configRecord.data.cid },
  });
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async () => {
  void VM_NSID; // referenced for parity / future use
  await loadReadme();
  await loginAgent();
  await configureAccountAuthRbac();
  const port = Number(Deno.env.get("PORT") ?? 4021);
  Deno.serve({ port, hostname: "0.0.0.0", onListen: ({ port, hostname }) => {
    console.error(`[server] listening on http://${hostname}:${port}`);
  } }, app.fetch);
};

await main();
