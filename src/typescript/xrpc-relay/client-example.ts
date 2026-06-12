/**
 * Relay subscriber client — Deno
 *
 * DISPATCHER_HOST=xrpc.fedproxy.com deno run -A --watch client-example.ts | tee client.ndjson | jq --unbuffered -rR '(fromjson? // .)'
 *
 * 1. Generates (or loads) a Secp256k1 did:key keypair.
 * 2. Calls com.fedproxy.temp.xrpc.getRegistrationNonce to obtain a 64-byte nonce.
 * 3. Signs the nonce → builds a com.fedproxy.temp.xrpc.registration record.
 * 4. Connects to the relay WebSocket with the registration as a query param.
 * 5. First frame received is #registered → contains subdomain and proxyRef.
 *    Share proxyRef (did:web:HOST#subdomain) with callers so they route here.
 * 6. Subsequent frames are #request → dispatched against an in-process Hono app
 *    via app.fetch (no socket opened); the Response becomes a #response frame
 *    sent back on the same WebSocket.
 *
 * Keypair behavior (default: fresh key every run):
 *   --save-keypair [path]   persist the generated keypair (default ./keypair.json)
 *   --load-keypair [path]   load an existing keypair instead of generating
 *
 * Run:
 *   DISPATCHER_HOST=dispatcher.example.com \
 *   deno run --allow-net --allow-read --allow-write client-example.ts
 */

import { Hono } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { Secp256k1Keypair } from "npm:@atproto/crypto";
import { Agent, CredentialSession } from "npm:@atproto/api";
import { IdResolver } from "npm:@atproto/identity";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64";
import { verifyServiceAuth } from "../lib/market/auth.ts";
import { DEFAULT_MARKET_SERVICE_ID } from "@publicdomainrelay/lexicons";

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}

// ── CLI args ──────────────────────────────────────────────────────────────────

interface CliArgs {
  saveKeypair: boolean;
  loadKeypair: boolean;
  keypairPath: string;
}

function parseArgs(args: string[]): CliArgs {
  let saveKeypair = false;
  let loadKeypair = false;
  let keypairPath = "./keypair.json";

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

// ── keypair ───────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function getKeypair(args: CliArgs): Promise<Secp256k1Keypair> {
  if (args.loadKeypair) {
    const state = JSON.parse(await Deno.readTextFile(args.keypairPath));
    const kp = await Secp256k1Keypair.import(hexToBytes(state.privateKeyHex));
    log("info", { component: "client", event: "keypair_loaded", path: args.keypairPath, did: kp.did() });
    return kp;
  }

  const kp = await Secp256k1Keypair.create({ exportable: true });
  log("info", { component: "client", event: "keypair_generated", did: kp.did() });

  if (args.saveKeypair) {
    const privateKeyHex = bytesToHex(await kp.export());
    await Deno.writeTextFile(
      args.keypairPath,
      JSON.stringify({ privateKeyHex, did: kp.did(), createdAt: new Date().toISOString() }, null, 2),
    );
    log("info", { component: "client", event: "keypair_saved", path: args.keypairPath });
  }
  return kp;
}

const keypair = await getKeypair(cli);

// ── config ────────────────────────────────────────────────────────────────────

const DISPATCHER_HOST = Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
const SUBSCRIBE_NSID  = "com.fedproxy.temp.xrpc.subscribe";
const GET_NONCE_NSID  = "com.fedproxy.temp.xrpc.getRegistrationNonce";
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

const idResolver = new IdResolver();

// Set after #registered frame is received; used by auth middleware.
let registeredSubdomain: string | undefined;

// ── service auth ──────────────────────────────────────────────────────────────

async function getServiceAuthToken(nsid: string): Promise<string> {
  const res = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${DISPATCHER_HOST}`,
    lxm: nsid,
  });
  return res.data.token;
}

// ── registration ──────────────────────────────────────────────────────────────

async function buildRegistration(): Promise<string> {
  const token = await getServiceAuthToken(GET_NONCE_NSID);
  const res = await fetch(`https://${DISPATCHER_HOST}/xrpc/${GET_NONCE_NSID}`, {
    method:  "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
    body:    JSON.stringify({ key: keypair.did(), signatures: [] }),
  });
  if (!res.ok) throw new Error(`getRegistrationNonce failed: ${res.status} ${await res.text()}`);

  const { nonce } = await res.json() as { nonce: string };
  const sig = await keypair.sign(decodeBase64(nonce));

  const registration = {
    $type:      "com.fedproxy.temp.xrpc.registration",
    key:        keypair.did(),
    nonce,
    signatures: [{ key: keypair.did(), signature: encodeBase64(sig) }],
  };
  log("info", { component: "client", event: "registration_built", key: keypair.did() });
  return JSON.stringify(registration);
}

// ── frame types ───────────────────────────────────────────────────────────────

interface RegisteredFrame {
  $type:     "com.fedproxy.temp.xrpc.subscribe#registered";
  subdomain: string;
  proxyRef:  string;
}

interface RequestFrame {
  $type:     "com.fedproxy.temp.xrpc.subscribe#request";
  requestId: string;
  method:    string;
  path:      string;
  params:    Record<string, string>;
  body:      unknown;
  headers:   Record<string, string>;
}

interface ResponseFrame {
  $type:        "com.fedproxy.temp.xrpc.subscribe#response";
  requestId:    string;
  status:       number;
  body:         unknown;
  contentType?: string;
}

// ── local Hono app ────────────────────────────────────────────────────────────
//
// Inbound #request frames are dispatched against this in-process Hono app via
// app.fetch. JWT verification runs here for /xrpc/* routes; the verified
// callerDid is exposed on the `x-caller-did` header for route handlers.

const app = new Hono();

app.use('*', cors());

// did:web document for this subscriber's subdomain identity.
// The relay forwards /.well-known/did.json requests for <subdomain>.<host> here.
app.get("/.well-known/did.json", (c) => {
  const subdomain = keypair.did().replaceAll(":", "-").toLowerCase();
  const host = `${subdomain}.${DISPATCHER_HOST}`;
  const did = `did:web:${host}`;
  return c.json({
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: keypair.did().replace(/^did:key:/, ""),
      },
    ],
    service: [
      {
        id: `#${DEFAULT_MARKET_SERVICE_ID}`,
        type: "PDRTempMarket",
        serviceEndpoint: `https://${host}`,
      },
    ],
  });
});

// Verify service-auth JWT for all /xrpc/* routes.
app.use("/xrpc/*", async (c, next) => {
  if (!registeredSubdomain) {
    return c.json({ error: "Unauthorized", message: "not yet registered" }, 401);
  }
  const hostname = `${registeredSubdomain}.${DISPATCHER_HOST}`;
  const nsid     = c.req.path.slice("/xrpc/".length);
  try {
    const auth = await verifyServiceAuth({
      authHeader: c.req.header("Authorization"),
      hostname,
      lxm:        nsid,
      serviceIds: [
        DEFAULT_MARKET_SERVICE_ID,
      ],
      idResolver,
    });
    c.set("callerDid" as never, auth.issuerDid);
    c.req.raw.headers.set("x-caller-did", auth.issuerDid);
  } catch (err) {
    return c.json({ error: "Unauthorized", message: String(err) }, 401);
  }
  await next();
});

// com.publicdomainrelay.temp.market.submitBid stub
app.post("/xrpc/com.publicdomainrelay.temp.market.submitBid", async (c) => {
  const callerDid = c.req.header("x-caller-did");
  let input: { uri?: string; cid?: string; record?: unknown };
  try { input = await c.req.json(); } catch {
    return c.json({ error: "InvalidRequest", message: "invalid JSON body" }, 400);
  }
  if (!input.uri || !input.cid || !input.record) {
    return c.json({ error: "InvalidRequest", message: "uri, cid, and record are required" }, 400);
  }
  log("info", { component: "handler", event: "submitBid", callerDid, uri: input.uri, cid: input.cid });
  return c.json({ ok: true });
});

app.all("/xrpc/*", (c) =>
  c.json({ error: "MethodNotImplemented", nsid: c.req.path.replace(/^\/xrpc\//, "") }, 501));

// ── request handler ───────────────────────────────────────────────────────────

async function handleRequest(req: RequestFrame): Promise<{ status: number; body: unknown; contentType: string }> {
  log("info", { component: "handler", event: "request", requestId: req.requestId, path: req.path });

  const url = new URL(`http://local${req.path}`);
  for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);

  const hasBody = !["GET", "HEAD"].includes(req.method) && req.body != null;
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (hasBody) headers["content-type"] = "application/json";

  const request = new Request(url, {
    method: req.method,
    headers,
    body:   hasBody ? JSON.stringify(req.body) : undefined,
  });

  const res         = await app.fetch(request);
  const contentType = res.headers.get("content-type") ?? "application/json";
  const text        = await res.text();
  let body: unknown = text;
  if (contentType.includes("application/json")) {
    try { body = JSON.parse(text); } catch { /* leave as text */ }
  }
  return { status: res.status, body, contentType };
}

// ── subscription loop ─────────────────────────────────────────────────────────

async function connect() {
  let registration: string;
  try {
    registration = await buildRegistration();
  } catch (err) {
    log("error", { component: "client", event: "registration_failed", error: String(err) });
    setTimeout(connect, 5_000);
    return;
  }

  const serviceAuthToken = await getServiceAuthToken(SUBSCRIBE_NSID);
  const url = `wss://${DISPATCHER_HOST}/xrpc/${SUBSCRIBE_NSID}?did=${encodeURIComponent(keypair.did())}&registration=${encodeURIComponent(registration)}&service_auth=${encodeURIComponent(serviceAuthToken)}`;
  log("info", { component: "client", event: "connecting", host: DISPATCHER_HOST });

  const ws = new WebSocket(url);
  let reconnectDelay = 1_000;

  ws.addEventListener("open", () => {
    log("info", { component: "client", event: "connected" });
    reconnectDelay = 1_000;
  });

  ws.addEventListener("message", async (evt) => {
    let frame: RegisteredFrame | RequestFrame;
    try {
      frame = JSON.parse(evt.data as string);
    } catch {
      log("warn", { component: "client", event: "non_json_frame_skipped" });
      return;
    }

    if (frame.$type === `${SUBSCRIBE_NSID}#registered`) {
      registeredSubdomain = frame.subdomain;
      log("info", {
        component: "client",
        event:     "registered",
        subdomain: frame.subdomain,
        proxyRef:  frame.proxyRef,
        note:      "share proxyRef as atproto-proxy header value with callers",
      });
      return;
    }

    if (frame.$type === `${SUBSCRIBE_NSID}#request`) {
      const req = frame as RequestFrame;
      let result: { status: number; body: unknown; contentType: string };

      try {
        result = await handleRequest(req);
      } catch (err) {
        result = {
          status:      500,
          body:        { error: "HandlerError", message: String(err) },
          contentType: "application/json",
        };
      }

      const response: ResponseFrame = {
        $type:       `${SUBSCRIBE_NSID}#response`,
        requestId:   req.requestId,
        status:      result.status,
        body:        result.body,
        contentType: result.contentType,
      };

      ws.send(JSON.stringify(response));
      log("info", { component: "client", event: "responded", requestId: req.requestId, status: result.status });
      return;
    }
  });

  ws.addEventListener("close", () => {
    log("info", { component: "client", event: "disconnected_reconnecting", subdomain: registeredSubdomain, reconnectDelayMs: reconnectDelay });
    registeredSubdomain = undefined;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  ws.addEventListener("error", (e) => {
    log("error", { component: "client", event: "ws_error", error: String(e) });
  });
}

connect();
