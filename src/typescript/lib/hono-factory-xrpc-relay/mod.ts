// @publicdomainrelay/hono-factory-xrpc-relay — Hono factory for the XRPC relay server.
//
// createRelayFactory(opts) returns a typed Hono factory with all relay routes
// wired up. Call factory.createApp() to get a ready-to-serve Hono instance.
//
// Usage:
//   import { createRelayFactory } from "@publicdomainrelay/hono-factory-xrpc-relay";
//   const app = createRelayFactory({ hostname: "xrpc.example.com" }).createApp();
//   Deno.serve({ port: 8080 }, app.fetch);

import { upgradeWebSocket } from "@hono/hono/deno";
import { cors } from "@hono/hono/cors";
import { createFactory } from "@hono/hono/factory";
import {
  log,
  hostnameOnly,
  hostnameToDid,
  didToSubdomain,
  SUBSCRIBE_NSID,
  GET_NONCE_NSID,
  RelayState,
  createNonceStore,
  verifyServiceAuth,
} from "@publicdomainrelay/xrpc-relay";

export interface RelayFactoryOptions {
  hostname: string;
  serviceId?: string;
  relayTimeoutMs?: number;
  reconnectGraceMs?: number;
  nonceTtlMs?: number;
}

export function createRelayFactory(opts: RelayFactoryOptions) {
  const hostname = opts.hostname;
  const serviceId = opts.serviceId ?? "xrpc_relay";
  const relayTimeoutMs = opts.relayTimeoutMs ?? 30_000;
  const reconnectGraceMs = opts.reconnectGraceMs ?? 10_000;
  const nonceTtlMs = opts.nonceTtlMs ?? 60_000;

  const state = new RelayState({ relayTimeoutMs, reconnectGraceMs });
  const nonceStore = createNonceStore(nonceTtlMs);

  return createFactory({
    initApp: (app) => {
      app.use("*", cors());

      // ── did:web document ─────────────────────────────────────────
      app.get("/.well-known/did.json", (c, next) => {
        const host = hostnameOnly(c.req.header("host") ?? hostname);
        if (host !== hostname) return next();
        return c.json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: `did:web:${hostname}`,
          service: [{
            id: `#${serviceId}`,
            type: "XrpcRelay",
            serviceEndpoint: `https://${hostname}`,
          }],
        });
      });

      // ── access log ───────────────────────────────────────────────
      app.use("*", async (c, next) => {
        const method = c.req.method;
        const path = new URL(c.req.url).pathname;
        log("debug", { component: "relay", event: "request", method, path });
        await next();
        const status = c.res.status;
        if (status >= 400) {
          let responseBody: unknown;
          try {
            const text = await c.res.clone().text();
            try { responseBody = JSON.parse(text); } catch { responseBody = text; }
          } catch { responseBody = null; }
          log("error", { component: "relay", event: "response_error", method, path, status, responseBody });
        }
      });

      // ── getRegistrationNonce ─────────────────────────────────────
      app.post(`/xrpc/${GET_NONCE_NSID}`, async (c, next) => {
        if (hostnameOnly(c.req.header("host") ?? hostname) !== hostname) return next();
        try {
          await verifyServiceAuth(c.req.header("Authorization"), hostnameToDid(hostname), GET_NONCE_NSID);
        } catch (err) {
          log("warn", { component: "relay", event: "auth_denied", nsid: GET_NONCE_NSID, error: String(err) });
          return c.json({ error: "AuthenticationRequired", message: String(err) }, 401);
        }
        let input: { key?: string };
        try { input = await c.req.json(); } catch { input = {}; }
        if (!input.key || typeof input.key !== "string" || !input.key.startsWith("did:key:")) {
          return c.json({ error: "InvalidRequest", message: "key must be a did:key" }, 400);
        }
        const nonce = nonceStore.issue(input.key);
        log("info", { component: "relay", event: "nonce_issued", key: input.key });
        return c.json({ nonce, signatures: [] });
      });

      // ── subscribe (WebSocket) ────────────────────────────────────
      const wsSubscribeHandler = upgradeWebSocket((c) => {
        const serviceHost = hostnameOnly(c.req.header("host") ?? hostname);
        const registrationParam = c.req.query("registration") ?? "";
        const clientDid = c.req.query("did") ?? "";
        const subdomain = didToSubdomain(clientDid);

        return {
          async onOpen(_evt, ws) {
            const raw = ws.raw as WebSocket;
            if (!clientDid.startsWith("did:key:")) {
              log("warn", { component: "relay", event: "missing_did" });
              raw.close(1008, "did query param must be a did:key");
              return;
            }
            let reg: { key?: string; nonce?: string; signatures?: Array<{ key?: string; signature?: string }> };
            try { reg = JSON.parse(registrationParam); } catch {
              log("warn", { component: "relay", event: "registration_malformed", did: clientDid });
              raw.close(1008, "malformed registration");
              return;
            }
            const result = await nonceStore.verify(reg);
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
            state.subscribers.set(subdomain, raw);
            log("info", { component: "relay", event: "subscriber_connected", subdomain, key: result.key });
            state.flushReconnectQueue(subdomain, raw);
            raw.send(JSON.stringify({
              $type: `${SUBSCRIBE_NSID}#registered`,
              subdomain,
              proxyRef: `did:web:${subdomain}.${serviceHost}`,
            }));
          },

          onMessage(evt) {
            let msg: Record<string, unknown>;
            try { msg = JSON.parse(evt.data as string) as Record<string, unknown>; } catch { return; }
            const $type = msg.$type as string | undefined;
            if (!$type || !$type.startsWith(`${SUBSCRIBE_NSID}#`)) return;
            const kind = $type.slice($type.indexOf("#") + 1);
            switch (kind) {
              case "response": {
                const requestId = msg.requestId as string | undefined;
                if (!requestId) return;
                state.handleResponse(requestId, msg.status as number, msg.body, msg.contentType as string | undefined);
                break;
              }
              case "subscriptionOpen":
                break;
              case "subscriptionEvent": {
                const subId = msg.subscriptionId as string | undefined;
                if (!subId) return;
                const sub = state.activeSubscriptions.get(subId);
                if (!sub || sub.callerWs.readyState !== WebSocket.OPEN) return;
                sub.callerWs.send(JSON.stringify(msg.message));
                break;
              }
              case "subscriptionClose": {
                const subId = msg.subscriptionId as string | undefined;
                if (!subId) return;
                const sub = state.activeSubscriptions.get(subId);
                if (sub && sub.callerWs.readyState === WebSocket.OPEN) {
                  sub.callerWs.close((msg.code as number) ?? 1000, msg.reason as string | undefined);
                }
                state.activeSubscriptions.delete(subId);
                break;
              }
            }
          },

          onClose() {
            state.subscribers.delete(subdomain);
            state.drainToReconnectQueue(subdomain);
            state.rejectSubscriberSubscriptions(subdomain);
            log("info", { component: "relay", event: "subscriber_disconnected", subdomain });
          },

          onError() {
            state.subscribers.delete(subdomain);
            state.drainToReconnectQueue(subdomain);
            state.rejectSubscriberSubscriptions(subdomain);
          },
        };
      });

      app.get(`/xrpc/${SUBSCRIBE_NSID}`, async (c, next) => {
        if (hostnameOnly(c.req.header("host") ?? hostname) !== hostname) return next();
        try {
          const serviceAuth = c.req.query("service_auth");
          await verifyServiceAuth(c.req.header("Authorization"), hostnameToDid(hostname), SUBSCRIBE_NSID, serviceAuth);
        } catch (err) {
          log("warn", { component: "relay", event: "auth_denied", nsid: SUBSCRIBE_NSID, error: String(err) });
          return c.json({ error: "AuthenticationRequired", message: String(err) }, 401);
        }
        return wsSubscribeHandler(c, next);
      });

      // ── caller WebSocket subscription relay ──────────────────────
      const wsRelaySubscriptionHandler = upgradeWebSocket((c) => {
        const host = hostnameOnly(c.req.header("host") ?? hostname);
        const subdomain = host.slice(0, -`.${hostname}`.length);
        const path = new URL(c.req.url).pathname;
        const nsid = path.startsWith("/xrpc/") ? path.slice("/xrpc/".length) : path;
        const params = Object.fromEntries(new URL(c.req.url).searchParams.entries());
        const subscriptionId = crypto.randomUUID();

        return {
          onOpen(_evt, ws) {
            const raw = ws.raw as WebSocket;
            const subWs = state.subscribers.get(subdomain);
            if (!subWs || subWs.readyState !== WebSocket.OPEN) {
              raw.close(4004, `no active subscriber for subdomain ${subdomain}`);
              return;
            }
            state.activeSubscriptions.set(subscriptionId, { callerWs: raw, subdomain, nsid });
            subWs.send(JSON.stringify({
              $type: `${SUBSCRIBE_NSID}#subscribe`,
              subscriptionId,
              nsid,
              params,
            }));
          },

          onClose() {
            const sub = state.activeSubscriptions.get(subscriptionId);
            if (!sub) return;
            state.activeSubscriptions.delete(subscriptionId);
            const subWs = state.subscribers.get(sub.subdomain);
            if (subWs && subWs.readyState === WebSocket.OPEN) {
              subWs.send(JSON.stringify({
                $type: `${SUBSCRIBE_NSID}#subscriptionCancel`,
                subscriptionId,
                reason: "caller disconnected",
              }));
            }
          },

          onError() {
            state.activeSubscriptions.delete(subscriptionId);
          },
        };
      });

      // Intercept WS upgrade at subdomains before universal relay.
      app.get("/xrpc/*", async (c, next) => {
        const host = hostnameOnly(c.req.header("host") ?? hostname);
        if (!host.endsWith(`.${hostname}`)) return next();
        if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return next();
        return wsRelaySubscriptionHandler(c, next);
      });

      // ── universal subdomain relay ────────────────────────────────
      app.all("*", async (c) => {
        const rawHost = hostnameOnly(c.req.header("host") ?? hostname);
        const baseDot = `.${hostname}`;
        if (!rawHost.endsWith(baseDot)) return c.notFound();

        const subdomain = rawHost.slice(0, rawHost.length - baseDot.length);
        const path = new URL(c.req.url).pathname;

        let body: unknown = undefined;
        if (!["GET", "HEAD"].includes(c.req.method)) {
          try { body = await c.req.json(); } catch { body = null; }
        }

        const params = Object.fromEntries(new URL(c.req.url).searchParams.entries());
        const requestId = crypto.randomUUID();
        const headers: Record<string, string> = {};
        for (const [k, v] of c.req.raw.headers.entries()) headers[k] = v;
        const frame = JSON.stringify({
          $type: `${SUBSCRIBE_NSID}#request`,
          requestId,
          method: c.req.method,
          path,
          params,
          body,
          headers,
        });

        let result;
        try {
          result = await state.dispatchRequest(subdomain, requestId, frame);
        } catch (err) {
          const msg = String(err);
          if (msg.includes("no active subscriber")) {
            return c.json({ error: "NotFound", message: msg }, 404);
          }
          log("error", { component: "relay", event: "relay_failed", path, subdomain, error: msg });
          return c.json({ error: "RelayError", message: msg }, 502);
        }

        const ct = result.contentType ?? "application/json";
        const responseBody = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
        return new Response(responseBody, { status: result.status, headers: { "content-type": ct } });
      });
    },
  });
}
