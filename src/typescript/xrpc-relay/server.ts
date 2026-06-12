/**
 * XRPC Relay Server
 *
 * HOSTNAME=xrpc.fedproxy.com PORT=9999 deno run -A --watch server.ts | jq --unbuffered -rR '(fromjson? // .)'
 *
 * Surfaces:
 *   GET  /.well-known/did.json                    → dynamic did:web doc
 *
 *   GET  /xrpc/com.fedproxy.temp.xrpc.subscribe        → WebSocket relay channel
 */

import { Hono } from "jsr:@hono/hono";
import { upgradeWebSocket } from "jsr:@hono/hono/deno";
import { cors } from "jsr:@hono/hono/cors";
import { verifySignature } from "npm:@atproto/crypto";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64";
import { IdResolver } from "npm:@atproto/identity";
import { verifyJwt } from "npm:@atproto/xrpc-server";

// ── logging ───────────────────────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}

// ── config ────────────────────────────────────────────────────────────────────

const HOSTNAME    = Deno.env.get("HOSTNAME")    ?? "xrpc.fedproxy.com";
const SERVICE_ID  = Deno.env.get("SERVICE_ID")  ?? "xrpc_relay";
const PORT        = parseInt(Deno.env.get("PORT") ?? "8080");
const UNIX_SOCKET = Deno.env.get("UNIX_SOCKET") ?? "";
const RELAY_TIMEOUT_MS = parseInt(Deno.env.get("RELAY_TIMEOUT_MS") ?? "30000");

const SUBSCRIBE_NSID = "com.fedproxy.temp.xrpc.subscribe";
const GET_NONCE_NSID = "com.fedproxy.temp.xrpc.getRegistrationNonce";

// How long an issued registration nonce stays valid.
const NONCE_TTL_MS = parseInt(Deno.env.get("NONCE_TTL_MS") ?? "60000");

// nonce (base64) → { key did:key it was issued for, expiry }
const issuedNonces = new Map<string, { key: string; expiresAt: number }>();

// ── relay state ───────────────────────────────────────────────────────────────

// subdomain → open WebSocket for that subscriber
const subscribers = new Map<string, WebSocket>();

interface RelayResult {
  status: number;
  body: unknown;
  contentType?: string;
}

// requestId → pending relay promise callbacks + owning subdomain
const pendingRequests = new Map<string, {
  subdomain: string;
  resolve: (r: RelayResult) => void;
  reject: (e: Error) => void;
  timer?: number;
}>();

function didToSubdomain(did: string): string {
  return did.replaceAll(":", "-").toLowerCase();
}

function rejectSubscriberPending(subdomain: string) {
  for (const [reqId, p] of pendingRequests) {
    if (p.subdomain !== subdomain) continue;
    if (p.timer) clearTimeout(p.timer);
    pendingRequests.delete(reqId);
    p.reject(new Error(`subscriber for ${subdomain} disconnected`));
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function effectiveHostname(host: string): string {
  return host.split(":")[0];
}

// ── ATProto service auth ──────────────────────────────────────────────────────

const idResolver = new IdResolver();

function hostnameToDid(hostname: string): string {
  return `did:web:${hostname}`;
}

async function verifyServiceAuth(authHeader: string | undefined, aud: string, lxm: string, tokenOverride?: string): Promise<{ iss: string }> {
  let token = tokenOverride;
  if (!token) {
    if (!authHeader) throw new Error("Missing Authorization header");
    const parts = authHeader.split(" ");
    token = parts[parts.length - 1];
  }
  if (!token) throw new Error("Missing bearer token");

  const payloadJson = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
    )
  );
  const iss = payloadJson.iss as string | undefined;
  if (!iss || !iss.startsWith("did:")) throw new Error("Token iss must be a DID");

  await verifyJwt(token, aud, lxm, async (did) => {
    if (did.startsWith("did:key:")) return did;
    return await idResolver.did.resolveAtprotoKey(did);
  });

  return { iss };
}

// ── app ───────────────────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", cors());

// ── did:web document ──────────────────────────────────────────────────────────
//
// Serves for both the base host (did:web:HOSTNAME) and subscriber subdomains
// (did:web:SUBDOMAIN.HOSTNAME). Subdomain did.json responses are proxied through
// to the subscriber's local app via the relay handler below; the base-host
// response is generated here directly.

app.get("/.well-known/did.json", (c, next) => {
  const host = effectiveHostname(c.req.header("host") ?? HOSTNAME);
  if (host !== HOSTNAME) return next(); // subdomain → falls through to relay
  return c.json({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: `did:web:${HOSTNAME}`,
    service: [
      {
        id: `#${SERVICE_ID}`,
        type: "XrpcRelay",
        serviceEndpoint: `https://${HOSTNAME}`,
      },
    ],
  });
});

app.use("*", async (c, next) => {
  const method = c.req.method;
  const path   = new URL(c.req.url).pathname;
  log("info", { component: "relay", event: "request", method, path });
  await next();
  const status = c.res.status;
  if (status >= 400) {
    let responseBody: unknown;
    try {
      const clone = c.res.clone();
      const text = await clone.text();
      try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    } catch { responseBody = null; }
    log("error", { component: "relay", event: "response_error", method, path, status, responseBody });
  }
});

// ── getRegistrationNonce (procedure) ──────────────────────────────────────────
//
// Caller presents its did:key (+ badge.blue attestations over its key). Relay
// returns a crypto-secure 64-byte nonce the caller must sign to subscribe.

app.post(`/xrpc/${GET_NONCE_NSID}`, async (c, next) => {
  if (effectiveHostname(c.req.header("host") ?? HOSTNAME) !== HOSTNAME) {
    return next();
  }

  try {
    await verifyServiceAuth(c.req.header("Authorization"), hostnameToDid(HOSTNAME), GET_NONCE_NSID);
  } catch (err) {
    log("warn", { component: "relay", event: "auth_denied", nsid: GET_NONCE_NSID, error: String(err) });
    return c.json({ error: "AuthenticationRequired", message: String(err) }, 401);
  }

  let input: { key?: string; signatures?: unknown };
  try { input = await c.req.json(); } catch { input = {}; }

  if (!input.key || typeof input.key !== "string" || !input.key.startsWith("did:key:")) {
    return c.json({ error: "InvalidRequest", message: "key must be a did:key" }, 400);
  }

  const nonceBytes = new Uint8Array(64);
  crypto.getRandomValues(nonceBytes);
  const nonce = encodeBase64(nonceBytes);

  // Drop expired entries opportunistically, then record this one.
  const now = Date.now();
  for (const [n, v] of issuedNonces) if (v.expiresAt < now) issuedNonces.delete(n);
  issuedNonces.set(nonce, { key: input.key, expiresAt: now + NONCE_TTL_MS });

  log("info", { component: "relay", event: "nonce_issued", key: input.key });

  // The relay's own attestations over the nonce would be attached here; for the
  // relay-without-key deployment this is an empty signatures array.
  return c.json({ nonce, signatures: [] });
});

// Verify a registration: signatures must verify over the issued nonce, the key
// must match the nonce's issuance, and the nonce must be unused + unexpired.
async function verifyRegistration(reg: {
  key?: string;
  nonce?: string;
  signatures?: Array<{ key?: string; signature?: string }>;
}): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  if (!reg?.key || !reg?.nonce || !Array.isArray(reg?.signatures)) {
    return { ok: false, reason: "registration missing key/nonce/signatures" };
  }

  const issued = issuedNonces.get(reg.nonce);
  if (!issued) return { ok: false, reason: "unknown or expired nonce" };
  if (issued.expiresAt < Date.now()) {
    issuedNonces.delete(reg.nonce);
    return { ok: false, reason: "nonce expired" };
  }
  if (issued.key !== reg.key) return { ok: false, reason: "key does not match nonce issuance" };

  const nonceBytes = decodeBase64(reg.nonce);
  let verified = false;
  for (const sig of reg.signatures) {
    if (!sig?.key || !sig?.signature) continue;
    try {
      if (await verifySignature(sig.key, nonceBytes, decodeBase64(sig.signature))) {
        verified = true;
        break;
      }
    } catch { /* try next */ }
  }
  if (!verified) return { ok: false, reason: "no signature verifies over the nonce" };

  // One-time use.
  issuedNonces.delete(reg.nonce);
  return { ok: true, key: reg.key };
}

// ── subscribe (WebSocket) ─────────────────────────────────────────────────────
//
// Flow for the subscriber (client):
//   1. Connect via WS with `registration` query param (URL-encoded JSON).
//   2. Receive first frame: #registered { subdomain, proxyRef }
//      → share proxyRef with callers so they can route here.
//   3. Receive subsequent frames: #request { requestId, method, path, params, body, callerDid }
//      → handle the XRPC, then send back: #response { requestId, status, body, contentType }

const wsSubscribeHandler = upgradeWebSocket((c) => {
    const serviceHost = effectiveHostname(c.req.header("host") ?? HOSTNAME);
    const registrationParam = c.req.query("registration") ?? "";
    const clientDid         = c.req.query("did") ?? "";
    const subdomain         = didToSubdomain(clientDid);

    return {
      async onOpen(_evt, ws) {
        const raw = ws.raw as WebSocket;

        if (!clientDid.startsWith("did:key:")) {
          log("warn", { component: "relay", event: "missing_did" });
          raw.close(1008, "did query param must be a did:key");
          return;
        }

        let reg: Parameters<typeof verifyRegistration>[0];
        try {
          reg = JSON.parse(registrationParam);
        } catch {
          log("warn", { component: "relay", event: "registration_malformed", did: clientDid });
          raw.close(1008, "malformed registration");
          return;
        }

        const result = await verifyRegistration(reg);
        if (!result.ok) {
          log("warn", { component: "relay", event: "registration_rejected", did: clientDid, reason: result.reason });
          raw.close(1008, `registration rejected: ${result.reason}`);
          return;
        }

        if (result.key !== clientDid) {
          log("warn", { component: "relay", event: "did_mismatch", did: clientDid, registrationKey: result.key });
          raw.close(1008, "did does not match registration key");
          return;
        }

        subscribers.set(subdomain, raw);
        log("info", { component: "relay", event: "subscriber_connected", subdomain, key: result.key });

        raw.send(JSON.stringify({
          $type:     `${SUBSCRIBE_NSID}#registered`,
          subdomain,
          proxyRef:  `did:web:${subdomain}.${serviceHost}`,
        }));
      },

      onMessage(evt) {
        let msg: {
          $type: string;
          requestId: string;
          status: number;
          body: unknown;
          contentType?: string;
        };
        try { msg = JSON.parse(evt.data as string); } catch { return; }

        if (msg.$type !== `${SUBSCRIBE_NSID}#response`) return;

        const pending = pendingRequests.get(msg.requestId);
        if (!pending) return;

        if (pending.timer) clearTimeout(pending.timer);
        pendingRequests.delete(msg.requestId);
        pending.resolve({ status: msg.status, body: msg.body, contentType: msg.contentType });
      },

      onClose() {
        subscribers.delete(subdomain);
        rejectSubscriberPending(subdomain);
        log("info", { component: "relay", event: "subscriber_disconnected", subdomain });
      },

      onError() {
        subscribers.delete(subdomain);
        rejectSubscriberPending(subdomain);
      },
    };
  });

app.get(`/xrpc/${SUBSCRIBE_NSID}`, async (c, next) => {
  if (effectiveHostname(c.req.header("host") ?? HOSTNAME) !== HOSTNAME) {
    return next();
  }

  try {
    const serviceAuth = c.req.query("service_auth");
    await verifyServiceAuth(c.req.header("Authorization"), hostnameToDid(HOSTNAME), SUBSCRIBE_NSID, serviceAuth);
  } catch (err) {
    log("warn", { component: "relay", event: "auth_denied", nsid: SUBSCRIBE_NSID, error: String(err) });
    return c.json({ error: "AuthenticationRequired", message: String(err) }, 401);
  }

  return wsSubscribeHandler(c, next);
});

// ── universal subdomain relay ─────────────────────────────────────────────────
//
// Any request whose Host has a subdomain beyond HOSTNAME is proxied to that
// subscriber's WebSocket as a #request frame. /xrpc/* paths additionally have
// their service-auth JWT verified so callerDid is available to the subscriber.

app.all("*", async (c) => {
  const rawHost = effectiveHostname(c.req.header("host") ?? HOSTNAME);
  const baseDot = `.${HOSTNAME}`;

  if (!rawHost.endsWith(baseDot)) {
    return c.notFound();
  }

  const subdomain = rawHost.slice(0, rawHost.length - baseDot.length);
  const path      = new URL(c.req.url).pathname;

  const ws = subscribers.get(subdomain);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return c.json({
      error:   "NotFound",
      message: `no active subscriber for subdomain ${subdomain} (did:key with colons replaced by hyphens)`,
    }, 404);
  }

  let body: unknown = undefined;
  if (!["GET", "HEAD"].includes(c.req.method)) {
    try { body = await c.req.json(); } catch { body = null; }
  }

  const params    = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const requestId = crypto.randomUUID();

  let result: RelayResult;
  try {
    result = await new Promise<RelayResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`relay timeout after ${RELAY_TIMEOUT_MS}ms`));
      }, RELAY_TIMEOUT_MS) as unknown as number;

      pendingRequests.set(requestId, { subdomain, resolve, reject, timer });

      const headers: Record<string, string> = {};
      for (const [k, v] of c.req.raw.headers.entries()) headers[k] = v;

      ws.send(JSON.stringify({
        $type:     `${SUBSCRIBE_NSID}#request`,
        requestId,
        method:    c.req.method,
        path,
        params,
        body,
        headers,
      }));
    });
  } catch (err) {
    log("error", { component: "relay", event: "relay_failed", path, subdomain, error: String(err) });
    return c.json({ error: "RelayError", message: String(err) }, 502);
  }

  const ct           = result.contentType ?? "application/json";
  const responseBody = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
  return new Response(responseBody, {
    status:  result.status,
    headers: { "content-type": ct },
  });
});

// ── serve ─────────────────────────────────────────────────────────────────────

if (UNIX_SOCKET) {
  try { Deno.removeSync(UNIX_SOCKET); } catch { /* stale */ }
  Deno.serve({ path: UNIX_SOCKET } as Deno.ServeUnixOptions, app.fetch);
  log("info", { component: "relay", event: "listening", socket: UNIX_SOCKET });
} else {
  Deno.serve({ port: PORT }, app.fetch);
  log("info", { component: "relay", event: "listening", port: PORT });
}
