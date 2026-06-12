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

import { log } from "@publicdomainrelay/xrpc-relay";
import { createRelayFactory } from "@publicdomainrelay/hono-factory-xrpc-relay";

const HOSTNAME          = Deno.env.get("HOSTNAME")          ?? "xrpc.fedproxy.com";
const SERVICE_ID        = Deno.env.get("SERVICE_ID")        ?? "xrpc_relay";
const PORT              = parseInt(Deno.env.get("PORT")              ?? "8080");
const UNIX_SOCKET       = Deno.env.get("UNIX_SOCKET")       ?? "";
const RELAY_TIMEOUT_MS  = parseInt(Deno.env.get("RELAY_TIMEOUT_MS")  ?? "30000");
const RECONNECT_GRACE_MS = parseInt(Deno.env.get("RECONNECT_GRACE_MS") ?? "10000");
const NONCE_TTL_MS      = parseInt(Deno.env.get("NONCE_TTL_MS")      ?? "60000");

const app = createRelayFactory({
  hostname: HOSTNAME,
  serviceId: SERVICE_ID,
  relayTimeoutMs: RELAY_TIMEOUT_MS,
  reconnectGraceMs: RECONNECT_GRACE_MS,
  nonceTtlMs: NONCE_TTL_MS,
}).createApp();

if (UNIX_SOCKET) {
  try { Deno.removeSync(UNIX_SOCKET); } catch { /* stale */ }
  Deno.serve({ path: UNIX_SOCKET } as Deno.ServeUnixOptions, app.fetch);
  log("info", { component: "relay", event: "listening", socket: UNIX_SOCKET });
} else {
  Deno.serve({ port: PORT }, app.fetch);
  log("info", { component: "relay", event: "listening", port: PORT });
}
