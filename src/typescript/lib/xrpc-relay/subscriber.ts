import type { Secp256k1Keypair } from "@atproto/crypto";
import { log } from "./log.ts";

// Isomorphic base64 (Deno + browser) — avoids a Deno-only jsr: specifier so
// this module can be imported from a Vite/browser build unchanged.
function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
import { type SubscribeFrame, type SubscriptionCancelFrame, SUBSCRIBE_NSID, didToSubdomain, hostnameOnly, httpOrigin, wsOrigin } from "./types.ts";
import type { WsHandle } from "./ws.ts";

// ── types ─────────────────────────────────────────────────────────

/** Identifies one open subscription. */
export interface Subscription {
  subscriptionId: string;
  nsid: string;
  params?: Record<string, string>;
}

/**
 * Caller-provided event source. Given a subscription and an `emit` bound to it,
 * wire up whatever produces events (firehose, db, queue) and return a disposer
 * that stops it. The lib owns the WebSocket framing; the caller owns the data.
 */
export type SubscribeHandler = (
  sub: Subscription,
  emit: (message: unknown) => void,
) => (() => void) | void;

export interface RequestResult {
  status: number;
  body: unknown;
  contentType: string;
}

export interface SubscriberOptions {
  label?: string;
  keypair: Secp256k1Keypair;
  getServiceAuthToken: (nsid: string) => Promise<string>;
  dispatcherHost: string;
  /** Called when a non-subscription XRPC request arrives */
  handleRequest?: (req: { requestId: string; method: string; path: string; params: Record<string, string>; body: unknown; headers: Record<string, string> }) => Promise<RequestResult>;
  /** Called when a caller subscribes. Return false to reject. */
  onSubscribe?: (sub: Subscription) => boolean | void;
  /** Event source: wire a producer to the subscription, return a disposer. */
  subscribe?: SubscribeHandler;
  /** UI hook: every structured log event (mirrors the console log() sink). */
  onLog?: (e: { severity: "info" | "warn" | "error" | "event"; message: string }) => void;
  /** UI hook: registration completed (subdomain assigned). */
  onRegistered?: (info: { subdomain: string; proxyRef: string }) => void;
  /** UI hook: a subscription opened. */
  onSubscriptionOpen?: (sub: Subscription) => void;
  /** UI hook: the underlying WebSocket closed (for reconnect orchestration). */
  onClose?: (e: { code: number; reason: string }) => void;
}

export interface SubscriberHandle {
  ws: WsHandle;
  subdomain: string;
  proxyRef: string;
}

// ── implementation ────────────────────────────────────────────────

export async function createSubscriber(opts: SubscriberOptions): Promise<SubscriberHandle> {
  const label = opts.label ?? "subscriber";
  const keypair = opts.keypair;
  const did = keypair.did();
  const hostname = hostnameOnly(opts.dispatcherHost);
  const subdomain = didToSubdomain(did);
  const proxyRef = `did:web:${subdomain}.${hostname}`;
  const disposers = new Map<string, () => void>();

  // Registration
  const getNonceToken = await opts.getServiceAuthToken("com.fedproxy.temp.xrpc.getRegistrationNonce");
  const nonceRes = await fetch(`${httpOrigin(opts.dispatcherHost)}/xrpc/com.fedproxy.temp.xrpc.getRegistrationNonce`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${getNonceToken}` },
    body: JSON.stringify({ key: did, signatures: [] }),
  });
  if (!nonceRes.ok) throw new Error(`getRegistrationNonce: ${nonceRes.status} ${await nonceRes.text()}`);
  const { nonce } = await nonceRes.json() as { nonce: string };
  const sig = await keypair.sign(decodeBase64(nonce));
  const registration = JSON.stringify({
    $type: "com.fedproxy.temp.xrpc.registration",
    key: did,
    nonce,
    signatures: [{ key: did, signature: encodeBase64(sig) }],
  });
  log("info", { component: label, event: "registration_built", key: did });

  const subToken = await opts.getServiceAuthToken(SUBSCRIBE_NSID);
  const url = `${wsOrigin(opts.dispatcherHost)}/xrpc/${SUBSCRIBE_NSID}?did=${encodeURIComponent(did)}&registration=${encodeURIComponent(registration)}&service_auth=${encodeURIComponent(subToken)}`;

  let registeredSubdomain: string | undefined;

  function stopSub(id: string) {
    const dispose = disposers.get(id);
    if (!dispose) return;
    dispose();
    disposers.delete(id);
    log("info", { component: label, event: "sub_stopped", subscriptionId: id });
  }

  return new Promise<SubscriberHandle>((resolve, reject) => {
    let resolved = false;
    const raw = new WebSocket(url);

    raw.addEventListener("open", () => {
      log("info", { component: label, event: "ws_connected" });
    });

    raw.addEventListener("message", async (evt) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(evt.data as string); } catch { return; }

      const $type = frame.$type as string | undefined;
      if (!$type) return;
      const suffix = $type.includes("#") ? $type.slice($type.indexOf("#") + 1) : "";

      switch (suffix) {
        case "registered": {
          // Resolve the handle, so the caller gets the subdomain/proxyRef
          registeredSubdomain = frame.subdomain as string;
          const handle: SubscriberHandle = {
            ws: {
              close() { raw.close(1000, "closed by handle"); },
              send(d: string) { if (raw.readyState === WebSocket.OPEN) raw.send(d); },
            },
            subdomain: frame.subdomain as string,
            proxyRef: frame.proxyRef as string,
          };
          log("info", { component: label, event: "registered", subdomain: frame.subdomain, proxyRef: frame.proxyRef });
          opts.onRegistered?.({ subdomain: frame.subdomain as string, proxyRef: frame.proxyRef as string });
          opts.onLog?.({ severity: "info", message: `registered subdomain=${frame.subdomain} proxyRef=${frame.proxyRef}` });
          resolved = true;
          resolve(handle);
          break;
        }
        case "subscribe": {
          const sf = frame as unknown as SubscribeFrame;
          if (opts.onSubscribe?.(sf) === false) return;
          raw.send(JSON.stringify({ $type: `${SUBSCRIBE_NSID}#subscriptionOpen`, subscriptionId: sf.subscriptionId }));
          log("info", { component: label, event: "subscribe_ack", subscriptionId: sf.subscriptionId, nsid: sf.nsid });
          const sub: Subscription = { subscriptionId: sf.subscriptionId, nsid: sf.nsid, params: sf.params };
          opts.onSubscriptionOpen?.(sub);
          opts.onLog?.({ severity: "info", message: `sub:${sf.subscriptionId.slice(0, 8)} open ${sf.nsid}` });

          const emit = (message: unknown) => {
            raw.send(JSON.stringify({
              $type: `${SUBSCRIBE_NSID}#subscriptionEvent`,
              subscriptionId: sf.subscriptionId,
              message,
            }));
            log("info", { component: label, event: "event_sent", subscriptionId: sf.subscriptionId, nsid: sf.nsid });
            opts.onLog?.({ severity: "event", message: `sub:${sf.subscriptionId.slice(0, 8)} → event` });
          };
          const dispose = opts.subscribe?.(sub, emit);
          if (dispose) disposers.set(sf.subscriptionId, dispose);
          break;
        }
        case "subscriptionCancel": {
          const cf = frame as unknown as SubscriptionCancelFrame;
          stopSub(cf.subscriptionId);
          break;
        }
        case "request": {
          if (!opts.handleRequest) {
            raw.send(JSON.stringify({
              $type: `${SUBSCRIBE_NSID}#response`,
              requestId: frame.requestId as string,
              status: 501,
              body: { error: "NotImplemented" },
              contentType: "application/json",
            }));
            return;
          }
          opts.onLog?.({ severity: "info", message: `request: ${frame.method} ${frame.path}` });
          try {
            const result = await opts.handleRequest({
              requestId: frame.requestId as string,
              method: frame.method as string,
              path: frame.path as string,
              params: frame.params as Record<string, string>,
              body: frame.body,
              headers: frame.headers as Record<string, string>,
            });
            raw.send(JSON.stringify({
              $type: `${SUBSCRIBE_NSID}#response`,
              requestId: frame.requestId as string,
              status: result.status,
              body: result.body,
              contentType: result.contentType,
            }));
          } catch (err) {
            raw.send(JSON.stringify({
              $type: `${SUBSCRIBE_NSID}#response`,
              requestId: frame.requestId as string,
              status: 500,
              body: { error: "HandlerError", message: String(err) },
              contentType: "application/json",
            }));
          }
          break;
        }
      }
    });

    raw.addEventListener("close", (e) => {
      for (const [id] of disposers) stopSub(id);
      registeredSubdomain = undefined;
      opts.onClose?.({ code: e.code, reason: e.reason || "none" });
      opts.onLog?.({ severity: "warn", message: `websocket closed code=${e.code}` });
      if (!resolved) reject(new Error(`WS closed before registration: code=${e.code} reason=${e.reason}`));
    });

    raw.addEventListener("error", () => {
      reject(new Error("WebSocket error"));
    });

    // Timeout: if registration doesn't arrive within 10s, reject
    setTimeout(() => reject(new Error("registration timeout")), 10_000);
  });
}

// ── reconnecting wrapper ──────────────────────────────────────────

export interface ReconnectOptions extends Omit<SubscriberOptions, "onClose"> {
  /** Backoff start (ms). Default 1_000. */
  reconnectBase?: number;
  /** Backoff cap (ms). Default 30_000. */
  reconnectMax?: number;
  /** Connection status transitions. */
  onStatus?: (status: "connecting" | "connected" | "disconnected" | "error") => void;
}

export interface SubscriberController {
  readonly subdomain: string | null;
  readonly proxyRef: string | null;
  stop(): void;
}

/**
 * Runs a subscriber with automatic exponential-backoff reconnect. Owns the
 * handle/subdomain/proxyRef/backoff state so callers don't reimplement it.
 * Status is delivered via `onStatus`; not a Promise (long-lived).
 */
export function runSubscriber(opts: ReconnectOptions): SubscriberController {
  const base = opts.reconnectBase ?? 1_000;
  const max = opts.reconnectMax ?? 30_000;
  let delay = base;
  let stopped = false;
  let handle: SubscriberHandle | null = null;
  let subdomain: string | null = null;
  let proxyRef: string | null = null;

  const schedule = () => {
    if (stopped) return;
    opts.onStatus?.("disconnected");
    const d = delay;
    delay = Math.min(delay * 2, max);
    opts.onLog?.({ severity: "warn", message: `reconnecting in ${d}ms` });
    setTimeout(connect, d);
  };

  async function connect() {
    if (stopped) return;
    opts.onStatus?.("connecting");
    try {
      handle = await createSubscriber({
        ...opts,
        onRegistered: (info) => {
          subdomain = info.subdomain;
          proxyRef = info.proxyRef;
          delay = base;
          opts.onStatus?.("connected");
          opts.onRegistered?.(info);
        },
        onClose: () => {
          handle = subdomain = proxyRef = null;
          schedule();
        },
      });
    } catch (err) {
      if (stopped) return;
      opts.onStatus?.("error");
      opts.onLog?.({ severity: "error", message: `registration failed: ${err}` });
      schedule();
    }
  }

  void connect();

  return {
    get subdomain() { return subdomain; },
    get proxyRef() { return proxyRef; },
    stop() {
      stopped = true;
      handle?.ws.close();
      handle = subdomain = proxyRef = null;
      opts.onStatus?.("disconnected");
    },
  };
}
