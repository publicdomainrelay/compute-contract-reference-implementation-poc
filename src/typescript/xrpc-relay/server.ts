/**
 * XRPC Relay Server
 *
 * Surfaces:
 *   GET  /.well-known/did.json                    → dynamic did:web doc
 *
 *   GET  /xrpc/com.example.dispatcher.subscribe   → WebSocket relay channel
 *        On connect: server generates a serviceId and sends #registered as
 *        the very first frame. The client owns that serviceId for the lifetime
 *        of the connection.
 *
 *        Subsequent server→client frames are #request — an inbound XRPC call
 *        that the subscriber should handle. The subscriber replies with a
 *        #response frame on the same socket.
 *
 *   *    /xrpc/<any-nsid>  (catch-all relay)
 *        PDS proxies calls addressed to did:web:HOST#<serviceId> here.
 *        Server verifies service-auth JWT, extracts serviceId from aud,
 *        finds the subscriber WebSocket, sends a #request frame, and waits
 *        for the subscriber to send back a #response frame.
 */

import { Hono } from "jsr:@hono/hono";
import { upgradeWebSocket } from "jsr:@hono/hono/deno";
import { cors } from "jsr:@hono/hono/cors";
import { IdResolver } from "npm:@atproto/identity";
import { verifyJwt } from "npm:@atproto/xrpc-server";

// ── logging ───────────────────────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}

// ── config ────────────────────────────────────────────────────────────────────

const HOSTNAME    = Deno.env.get("HOSTNAME")    ?? "dispatcher.example.com";
const SERVICE_ID  = Deno.env.get("SERVICE_ID")  ?? "xrpc_dispatcher";
const PORT        = parseInt(Deno.env.get("PORT") ?? "8080");
const UNIX_SOCKET = Deno.env.get("UNIX_SOCKET") ?? "";
const RELAY_TIMEOUT_MS = parseInt(Deno.env.get("RELAY_TIMEOUT_MS") ?? "30000");

const SUBSCRIBE_NSID = "com.example.dispatcher.subscribe";

// ── relay state ───────────────────────────────────────────────────────────────

// serviceId → open WebSocket for that subscriber
const subscribers = new Map<string, WebSocket>();

interface RelayResult {
  status: number;
  body: unknown;
  contentType?: string;
}

// requestId → pending relay promise callbacks + owning serviceId
const pendingRequests = new Map<string, {
  serviceId: string;
  resolve: (r: RelayResult) => void;
  reject: (e: Error) => void;
  timer?: number;
}>();

function generateServiceId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  // Rejection sampling: discard bytes >= 234 (floor(256/26)*26) to eliminate modulo bias.
  const result: string[] = [];
  while (result.length < 16) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 234) result.push(chars[b % 26]);
      if (result.length === 16) break;
    }
  }
  return result.join("");
}

function rejectSubscriberPending(serviceId: string) {
  for (const [reqId, p] of pendingRequests) {
    if (p.serviceId !== serviceId) continue;
    if (p.timer) clearTimeout(p.timer);
    pendingRequests.delete(reqId);
    p.reject(new Error(`subscriber for ${serviceId} disconnected`));
  }
}

// ── auth ──────────────────────────────────────────────────────────────────────

const idResolver = new IdResolver();

function effectiveHostname(host: string): string {
  return host.split(":")[0];
}

function extractBearer(header: string | undefined | null): string {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) throw new Error("Authorization header must be 'Bearer <token>'");
  return m[1];
}

async function validateServiceAuth(
  authHeader: string | undefined | null,
  host: string,
  nsid: string,
): Promise<{ callerDid: string; audFragment: string | undefined }> {
  const token      = extractBearer(authHeader);
  const hostName   = effectiveHostname(host);
  const serviceDid = `did:web:${hostName}`;

  const payload = await verifyJwt(token, null, nsid, (did: string) =>
    idResolver.did.resolveAtprotoKey(did),
  );

  const aud = (payload as Record<string, unknown>).aud as string | undefined;

  if (aud !== serviceDid && !aud?.startsWith(`${serviceDid}#`)) {
    throw new Error(`unexpected audience ${aud ?? "(none)"}; expected ${serviceDid}[#fragment]`);
  }

  const iss = (payload as Record<string, unknown>).iss as string | undefined;
  if (!iss || !iss.startsWith("did:")) throw new Error("token missing DID issuer");

  const audFragment = aud?.includes("#") ? aud.split("#")[1] : undefined;
  return { callerDid: iss.split("#")[0], audFragment };
}

// ── app ───────────────────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", cors());

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

// ── did:web document ──────────────────────────────────────────────────────────

app.get("/.well-known/did.json", (c) => {
  const host        = c.req.header("host") ?? HOSTNAME;
  const serviceHost = effectiveHostname(host);

  const services: Array<{ id: string; type: string; serviceEndpoint: string }> = [
    {
      id:              `#${SERVICE_ID}`,
      type:            "XrpcRelay",
      serviceEndpoint: `https://${serviceHost}`,
    },
  ];

  for (const serviceId of subscribers.keys()) {
    services.push({
      id:              `#${serviceId}`,
      type:            "XrpcRelayTarget",
      serviceEndpoint: `https://${serviceHost}`,
    });
  }

  return c.json({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id:      `did:web:${serviceHost}`,
    service: services,
  });
});

// ── subscribe (WebSocket) ─────────────────────────────────────────────────────
//
// Flow for the subscriber (client):
//   1. Connect via WS.
//   2. Receive first frame: #registered { serviceId, proxyRef }
//      → share proxyRef with callers so they can route here.
//   3. Receive subsequent frames: #request { requestId, method, nsid, params, body, callerDid }
//      → handle the XRPC, then send back: #response { requestId, status, body, contentType }

app.get(
  `/xrpc/${SUBSCRIBE_NSID}`,
  upgradeWebSocket((c) => {
    const serviceId = generateServiceId();
    const host        = c.req.header("host") ?? HOSTNAME;
    const serviceHost = effectiveHostname(host);

    return {
      onOpen(_evt, ws) {
        const raw = ws.raw as WebSocket;
        subscribers.set(serviceId, raw);
        log("info", { component: "relay", event: "subscriber_connected", serviceId });

        raw.send(JSON.stringify({
          $type:     `${SUBSCRIBE_NSID}#registered`,
          serviceId,
          proxyRef:  `did:web:${serviceHost}#${serviceId}`,
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
        subscribers.delete(serviceId);
        rejectSubscriberPending(serviceId);
        log("info", { component: "relay", event: "subscriber_disconnected", serviceId });
      },

      onError() {
        subscribers.delete(serviceId);
        rejectSubscriberPending(serviceId);
      },
    };
  }),
);

// ── catch-all relay ───────────────────────────────────────────────────────────
//
// Receives any /xrpc/<nsid> proxied here by a PDS via atproto-proxy header.
// Verifies service-auth JWT, finds subscriber WS by serviceId (aud fragment),
// sends a #request frame, and awaits the #response frame.

app.all("/xrpc/:nsid{.+$}", async (c) => {
  const nsid = c.req.param("nsid");

  if (nsid === SUBSCRIBE_NSID) {
    return c.json({ error: "MethodNotAllowed" }, 405);
  }

  // Verify service-auth JWT.
  let callerDid:   string;
  let audFragment: string | undefined;
  try {
    ({ callerDid, audFragment } = await validateServiceAuth(
      c.req.header("Authorization"),
      c.req.header("host") ?? HOSTNAME,
      nsid,
    ));
  } catch (err) {
    return c.json({ error: "Unauthorized", message: String(err) }, 401);
  }

  if (!audFragment) {
    return c.json({
      error:   "InvalidRequest",
      message: "aud must include a #serviceId fragment",
    }, 400);
  }

  const ws = subscribers.get(audFragment);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return c.json({
      error:   "ServiceUnavailable",
      message: `no active subscriber for serviceId ${audFragment}`,
    }, 503);
  }

  // Parse request body.
  let body: unknown = undefined;
  if (!["GET", "HEAD"].includes(c.req.method)) {
    try { body = await c.req.json(); } catch { body = null; }
  }

  // Parse query params.
  const params = Object.fromEntries(new URL(c.req.url).searchParams.entries());

  // Send #request to subscriber and wait for #response.
  const requestId = crypto.randomUUID();

  let result: RelayResult;
  try {
    result = await new Promise<RelayResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`relay timeout after ${RELAY_TIMEOUT_MS}ms`));
      }, RELAY_TIMEOUT_MS) as unknown as number;

      pendingRequests.set(requestId, { serviceId: audFragment!, resolve, reject, timer });

      ws.send(JSON.stringify({
        $type:     `${SUBSCRIBE_NSID}#request`,
        requestId,
        method:    c.req.method,
        nsid,
        params,
        body,
        callerDid,
      }));
    });
  } catch (err) {
    log("error", { component: "relay", event: "relay_failed", nsid, audFragment, error: String(err) });
    return c.json({ error: "RelayError", message: String(err) }, 502);
  }

  const ct = result.contentType ?? "application/json";
  const responseBody = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
  return new Response(responseBody, {
    status: result.status,
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
