import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64";
import type { Secp256k1Keypair } from "npm:@atproto/crypto";
import { log } from "./log.ts";
import { type SubscribeFrame, type SubscriptionCancelFrame, SUBSCRIBE_NSID, didToSubdomain, hostnameOnly, httpOrigin, wsOrigin } from "./types.ts";
import { buildSyntheticEvent } from "./synthetic.ts";
import type { WsHandle } from "./ws.ts";

// ── synthetic subscription state ──────────────────────────────────

interface SynSub {
  subscriptionId: string;
  nsid: string;
  seq: number;
  timer: ReturnType<typeof setInterval>;
}

// ── types ─────────────────────────────────────────────────────────

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
  onSubscribe?: (sub: { subscriptionId: string; nsid: string; params?: Record<string, string> }) => boolean | void;
  /** Enable synthetic event production for subscribe */
  synthetic?: boolean;
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
  const synSubs = new Map<string, SynSub>();

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

  function stopSynSub(id: string) {
    const s = synSubs.get(id);
    if (!s) return;
    clearInterval(s.timer);
    synSubs.delete(id);
    log("info", { component: label, event: "synthetic_sub_stopped", subscriptionId: id, nsid: s.nsid, events: s.seq });
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
          resolved = true;
          resolve(handle);
          break;
        }
        case "subscribe": {
          const sf = frame as unknown as SubscribeFrame;
          if (opts.onSubscribe?.(sf) === false) return;
          raw.send(JSON.stringify({ $type: `${SUBSCRIBE_NSID}#subscriptionOpen`, subscriptionId: sf.subscriptionId }));
          log("info", { component: label, event: "subscribe_ack", subscriptionId: sf.subscriptionId, nsid: sf.nsid });

          if (opts.synthetic !== false) {
            const seqRef = { seq: 0 };
            const emit = () => {
              const seq = ++seqRef.seq;
              const msg = buildSyntheticEvent(seq);
              raw.send(JSON.stringify({
                $type: `${SUBSCRIBE_NSID}#subscriptionEvent`,
                subscriptionId: sf.subscriptionId,
                message: msg,
              }));
              log("info", { component: label, event: "syn_event_sent", subscriptionId: sf.subscriptionId, nsid: sf.nsid, seq });
            };
            emit();
            const timer = setInterval(emit, 1_000);
            synSubs.set(sf.subscriptionId, { subscriptionId: sf.subscriptionId, nsid: sf.nsid, seq: 0, timer });
          }
          break;
        }
        case "subscriptionCancel": {
          const cf = frame as unknown as SubscriptionCancelFrame;
          stopSynSub(cf.subscriptionId);
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
      for (const [id] of synSubs) stopSynSub(id);
      registeredSubdomain = undefined;
      if (!resolved) reject(new Error(`WS closed before registration: code=${e.code} reason=${e.reason}`));
    });

    raw.addEventListener("error", () => {
      reject(new Error("WebSocket error"));
    });

    // Timeout: if registration doesn't arrive within 10s, reject
    setTimeout(() => reject(new Error("registration timeout")), 10_000);
  });
}
