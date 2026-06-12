/**
 * Relay subscriber client — refactored to use @publicdomainrelay/xrpc-relay.
 *
 * DISPATCHER_HOST=xrpc-test.fedproxy.com deno run -A -- client-example.ts --load-keypair
 *
 * 1. Loads/generates Secp256k1 did:key keypair.
 * 2. Logs into PDS for service-auth JWT issuance.
 * 3. Creates subscriber client → registers with relay.
 * 4. Handles inbound #request frames via local Hono app.
 * 5. Handles #subscribe frames with synthetic event stream.
 */

import { Hono } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { Secp256k1Keypair } from "npm:@atproto/crypto";
import { Agent, CredentialSession } from "npm:@atproto/api";
import { IdResolver } from "npm:@atproto/identity";
import { createSubscriber, log, hostnameOnly } from "@publicdomainrelay/xrpc-relay";
import { verifyServiceAuth } from "../lib/market/auth.ts";
import { DEFAULT_MARKET_SERVICE_ID } from "@publicdomainrelay/lexicons";

// ── CLI args ──────────────────────────────────────────────────────

interface CliArgs { saveKeypair: boolean; loadKeypair: boolean; keypairPath: string; }

function parseArgs(args: string[]): CliArgs {
  let saveKeypair = false, loadKeypair = false, keypairPath = "./keypair.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--save-keypair") {
      saveKeypair = true;
      if (args[i + 1] && !args[i + 1].startsWith("--")) keypairPath = args[++i];
    } else if (args[i] === "--load-keypair") {
      loadKeypair = true;
      if (args[i + 1] && !args[i + 1].startsWith("--")) keypairPath = args[++i];
    }
  }
  return { saveKeypair, loadKeypair, keypairPath };
}

const cli = parseArgs(Deno.args);

// ── keypair ───────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string { return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(hex: string): Uint8Array { const o = new Uint8Array(hex.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return o; }

async function getKeypair(): Promise<Secp256k1Keypair> {
  if (cli.loadKeypair) {
    const state = JSON.parse(await Deno.readTextFile(cli.keypairPath));
    const kp = await Secp256k1Keypair.import(hexToBytes(state.privateKeyHex));
    log("info", { component: "client", event: "keypair_loaded", path: cli.keypairPath, did: kp.did() });
    return kp;
  }
  const kp = await Secp256k1Keypair.create({ exportable: true });
  log("info", { component: "client", event: "keypair_generated", did: kp.did() });
  if (cli.saveKeypair) {
    const priv = bytesToHex(await kp.export());
    await Deno.writeTextFile(cli.keypairPath, JSON.stringify({ privateKeyHex: priv, did: kp.did(), createdAt: new Date().toISOString() }, null, 2));
    log("info", { component: "client", event: "keypair_saved", path: cli.keypairPath });
  }
  return kp;
}

const keypair = await getKeypair();

// ── PDS session ───────────────────────────────────────────────────

const DISPATCHER_HOST = Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
const ATPROTO_PDS     = Deno.env.get("ATPROTO_PDS") ?? "https://bsky.social";
const ATPROTO_HANDLE  = Deno.env.get("ATPROTO_HANDLE");
const ATPROTO_PASSWORD = Deno.env.get("ATPROTO_PASSWORD");

if (!ATPROTO_HANDLE || !ATPROTO_PASSWORD) {
  log("error", { component: "client", event: "missing_env", message: "ATPROTO_HANDLE and ATPROTO_PASSWORD must be set" });
  Deno.exit(1);
}

const session = new CredentialSession(new URL(ATPROTO_PDS));
await session.login({ identifier: ATPROTO_HANDLE, password: ATPROTO_PASSWORD });
const agent = new Agent(session);
log("info", { component: "client", event: "session_created", did: session.did });

const dispatcherHostname = hostnameOnly(DISPATCHER_HOST);

async function getServiceAuthToken(nsid: string): Promise<string> {
  const res = await agent.com.atproto.server.getServiceAuth({ aud: `did:web:${dispatcherHostname}`, lxm: nsid });
  return res.data.token;
}

// ── local Hono app (handles #request frames) ──────────────────────

const idResolver = new IdResolver();
let registeredSubdomain: string | undefined;

const app = new Hono();
app.use("*", cors());

app.get("/.well-known/did.json", (c) => {
  const subdomain = keypair.did().replaceAll(":", "-").toLowerCase();
  return c.json({
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: `did:web:${subdomain}.${DISPATCHER_HOST}`,
    verificationMethod: [{
      id: `did:web:${subdomain}.${DISPATCHER_HOST}#atproto`,
      type: "Multikey",
      controller: `did:web:${subdomain}.${DISPATCHER_HOST}`,
      publicKeyMultibase: keypair.did().replace(/^did:key:/, ""),
    }],
    service: [{ id: `#${DEFAULT_MARKET_SERVICE_ID}`, type: "PDRTempMarket", serviceEndpoint: `https://${subdomain}.${DISPATCHER_HOST}` }],
  });
});

app.use("/xrpc/*", async (c, next) => {
  if (!registeredSubdomain) return c.json({ error: "Unauthorized", message: "not yet registered" }, 401);
  const hostname = `${registeredSubdomain}.${DISPATCHER_HOST}`;
  const nsid = c.req.path.slice("/xrpc/".length);
  try {
    const auth = await verifyServiceAuth({ authHeader: c.req.header("Authorization"), hostname, lxm: nsid, serviceIds: [DEFAULT_MARKET_SERVICE_ID], idResolver });
    c.set("callerDid" as never, auth.issuerDid);
    c.req.raw.headers.set("x-caller-did", auth.issuerDid);
  } catch (err) { return c.json({ error: "Unauthorized", message: String(err) }, 401); }
  await next();
});

app.post("/xrpc/com.publicdomainrelay.temp.market.submitBid", async (c) => {
  const callerDid = c.req.header("x-caller-did");
  let input: { uri?: string; cid?: string; record?: unknown };
  try { input = await c.req.json(); } catch { return c.json({ error: "InvalidRequest", message: "invalid JSON" }, 400); }
  if (!input.uri || !input.cid || !input.record) return c.json({ error: "InvalidRequest", message: "uri, cid, record required" }, 400);
  log("info", { component: "handler", event: "submitBid", callerDid, uri: input.uri });
  return c.json({ ok: true });
});

app.all("/xrpc/*", (c) => c.json({ error: "MethodNotImplemented", nsid: c.req.path.replace("/xrpc/", "") }, 501));

// ── connect subscriber ────────────────────────────────────────────

const sub = await createSubscriber({
  keypair,
  getServiceAuthToken,
  dispatcherHost: DISPATCHER_HOST,
  synthetic: true,
  handleRequest: async (req) => {
    const url = new URL(`http://local${req.path}`);
    for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);
    const hasBody = !["GET", "HEAD"].includes(req.method) && req.body != null;
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (hasBody) headers["content-type"] = "application/json";
    const r = new Request(url, { method: req.method, headers, body: hasBody ? JSON.stringify(req.body) : undefined });
    const res = await app.fetch(r);
    const ct = res.headers.get("content-type") ?? "application/json";
    const text = await res.text();
    let body: unknown = text;
    if (ct.includes("application/json")) { try { body = JSON.parse(text); } catch { /* ok */ } }
    return { status: res.status, body, contentType: ct };
  },
});

registeredSubdomain = sub.subdomain;
log("info", { component: "client", event: "registered", subdomain: sub.subdomain, proxyRef: sub.proxyRef });
