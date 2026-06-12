import { Secp256k1Keypair } from '@atproto/crypto';
import { Agent, CredentialSession } from '@atproto/api';

const KEYPAIR_KEY = 'relay-demo:keypair';
const DISPATCHER_HOST = 'xrpc.fedproxy.com';
const SUBSCRIBE_NSID = 'com.fedproxy.temp.xrpc.subscribe';
const GET_NONCE_NSID = 'com.fedproxy.temp.xrpc.getRegistrationNonce';

export type Status = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface LogEvent {
  ts: string;
  severity: 'info' | 'warn' | 'error' | 'event';
  message: string;
}

export interface SubscriptionInfo {
  subscriptionId: string;
  nsid: string;
  params: Record<string, string>;
  eventCount: number;
  startedAt: string;
}

// ── helpers ───────────────────────────────────────────────────────

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── frame types ───────────────────────────────────────────────────

interface RegisteredFrame {
  $type: `${typeof SUBSCRIBE_NSID}#registered`;
  subdomain: string;
  proxyRef: string;
}

interface RequestFrame {
  $type: `${typeof SUBSCRIBE_NSID}#request`;
  requestId: string;
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

interface SubscribeFrame {
  $type: `${typeof SUBSCRIBE_NSID}#subscribe`;
  subscriptionId: string;
  nsid: string;
  params: Record<string, string>;
}

// ── demo subscription producer ────────────────────────────────────
//
// For each incoming #subscribe frame we produce a demo event stream.
// Real subscribers would connect to an actual atproto firehose / app-view.

class SubscriptionProducer {
  #timer: ReturnType<typeof setInterval> | null = null;
  #seq = 0;
  #subscriptionId: string;
  #sendEvent: (subId: string, message: unknown) => void;
  #onLog: (event: LogEvent) => void;

  constructor(
    subscriptionId: string,
    nsid: string,
    sendEvent: (subId: string, message: unknown) => void,
    onLog: (event: LogEvent) => void,
  ) {
    this.#subscriptionId = subscriptionId;
    this.#sendEvent = sendEvent;
    this.#onLog = onLog;
    this.#start(nsid);
  }

  #start(nsid: string) {
    this.#onLog({ ts: new Date().toISOString(), severity: 'info', message: `sub:${this.#subscriptionId.slice(0, 8)} open ${nsid}` });

    this.#timer = setInterval(() => {
      const seq = this.#seq++;
      const message = {
        seq,
        time: new Date().toISOString(),
        nsid,
        event: `demo-event-${seq}`,
        data: { id: seq, ts: Date.now(), msg: 'subscription event via relay' },
      };
      this.#sendEvent(this.#subscriptionId, message);
      this.#onLog({ ts: message.time, severity: 'event', message: `sub:${this.#subscriptionId.slice(0, 8)} → event #${seq}` });
    }, 3000);
  }

  stop() {
    if (this.#timer !== null) clearInterval(this.#timer);
  }
}

// ── RelaySubscriber ───────────────────────────────────────────────

export interface RelaySubscriberCallbacks {
  onStatus(status: Status): void;
  onLog(event: LogEvent): void;
  onSubscription(sub: SubscriptionInfo): void;
  onSubscriptionEvent(subscriptionId: string, message: unknown): void;
}

export class RelaySubscriber {
  #callbacks: RelaySubscriberCallbacks;
  #keypair: Secp256k1Keypair | null = null;
  #ws: WebSocket | null = null;
  #subdomain: string | null = null;
  #proxyRef: string | null = null;
  #reconnectDelay = 1000;
  #stopped = false;
  #agent: Agent | null = null;

  // Active subscription producers keyed by subscriptionId
  #producers = new Map<string, SubscriptionProducer>();

  constructor(callbacks: RelaySubscriberCallbacks) {
    this.#callbacks = callbacks;
  }

  get subdomain() { return this.#subdomain; }
  get proxyRef() { return this.#proxyRef; }

  // ── keypair ─────────────────────────────────────────────────────

  async #loadOrGenerateKeypair(): Promise<Secp256k1Keypair> {
    const stored = localStorage.getItem(KEYPAIR_KEY);
    if (stored) {
      try {
        const state = JSON.parse(stored);
        return await Secp256k1Keypair.import(hexToBytes(state.privateKeyHex));
      } catch { /* corrupt — regenerate */ }
    }
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const privateKeyHex = bytesToHex(await kp.export());
    localStorage.setItem(KEYPAIR_KEY, JSON.stringify({ privateKeyHex, did: kp.did(), createdAt: new Date().toISOString() }));
    return kp;
  }

  // ── atproto login ───────────────────────────────────────────────

  async #login(handle: string, password: string): Promise<void> {
    const pdsSession = new CredentialSession(new URL('https://bsky.social'));
    await pdsSession.login({ identifier: handle, password });
    this.#agent = new Agent(pdsSession);
    this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'info', message: `logged in as ${pdsSession.did}` });
  }

  async #serviceAuthToken(lxm: string): Promise<string> {
    if (!this.#agent) throw new Error('not logged in');
    const res = await this.#agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${DISPATCHER_HOST}`,
      lxm,
    });
    return res.data.token;
  }

  // ── registration ────────────────────────────────────────────────

  async #buildRegistration(): Promise<string> {
    const kp = this.#keypair!;
    const token = await this.#serviceAuthToken(GET_NONCE_NSID);

    const res = await fetch(`https://${DISPATCHER_HOST}/xrpc/${GET_NONCE_NSID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: kp.did(), signatures: [] }),
    });
    if (!res.ok) throw new Error(`getRegistrationNonce: ${res.status} ${await res.text()}`);

    const { nonce } = await res.json() as { nonce: string };
    const sig = await kp.sign(b64decode(nonce));

    return JSON.stringify({
      $type: 'com.fedproxy.temp.xrpc.registration',
      key: kp.did(),
      nonce,
      signatures: [{ key: kp.did(), signature: b64encode(sig) }],
    });
  }

  // ── frame handlers ──────────────────────────────────────────────

  async #handleRequest(frame: RequestFrame): Promise<void> {
    // Simple echo handler for demo; real subscriber would dispatch to Hono app
    this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'info', message: `request: ${frame.method} ${frame.path}` });

    const response = {
      $type: `${SUBSCRIBE_NSID}#response` as const,
      requestId: frame.requestId,
      status: 200,
      body: { ok: true, echo: { path: frame.path, params: frame.params } },
      contentType: 'application/json',
    };
    this.#ws?.send(JSON.stringify(response));
  }

  #handleSubscribe(frame: SubscribeFrame): void {
    // Start a demo event producer for this subscription
    const producer = new SubscriptionProducer(
      frame.subscriptionId,
      frame.nsid,
      (subId, message) => {
        this.#ws?.send(JSON.stringify({
          $type: `${SUBSCRIBE_NSID}#subscriptionEvent`,
          subscriptionId: subId,
          message,
        }));
      },
      (event) => this.#callbacks.onLog(event),
    );

    this.#producers.set(frame.subscriptionId, producer);

    // Send subscriptionOpen to signal readiness
    this.#ws?.send(JSON.stringify({
      $type: `${SUBSCRIBE_NSID}#subscriptionOpen`,
      subscriptionId: frame.subscriptionId,
    }));

    this.#callbacks.onSubscription({
      subscriptionId: frame.subscriptionId,
      nsid: frame.nsid,
      params: frame.params,
      eventCount: 0,
      startedAt: new Date().toISOString(),
    });
  }

  #handleSubscriptionCancel(subscriptionId: string): void {
    const producer = this.#producers.get(subscriptionId);
    if (producer) {
      producer.stop();
      this.#producers.delete(subscriptionId);
    }
    this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'warn', message: `sub:${subscriptionId.slice(0, 8)} cancelled by relay` });
  }

  // ── connect ─────────────────────────────────────────────────────

  async connect(handle: string, password: string): Promise<void> {
    this.#stopped = false;

    this.#callbacks.onStatus('connecting');
    this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'info', message: 'starting relay subscriber' });

    try {
      this.#keypair = await this.#loadOrGenerateKeypair();
      this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'info', message: `keypair ready: ${this.#keypair.did()}` });

      await this.#login(handle, password);
    } catch (err) {
      this.#callbacks.onStatus('error');
      this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'error', message: `init failed: ${err}` });
      return;
    }

    this.#doConnect();
  }

  async #doConnect(): Promise<void> {
    if (this.#stopped) return;

    let registration: string;
    try {
      registration = await this.#buildRegistration();
    } catch (err) {
      this.#callbacks.onStatus('error');
      this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'error', message: `registration failed: ${err}` });
      if (!this.#stopped) setTimeout(() => this.#doConnect(), 5_000);
      return;
    }

    let serviceAuthToken: string;
    try {
      serviceAuthToken = await this.#serviceAuthToken(SUBSCRIBE_NSID);
    } catch (err) {
      this.#callbacks.onStatus('error');
      this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'error', message: `service auth failed: ${err}` });
      if (!this.#stopped) setTimeout(() => this.#doConnect(), 5_000);
      return;
    }

    const url = `wss://${DISPATCHER_HOST}/xrpc/${SUBSCRIBE_NSID}?did=${encodeURIComponent(this.#keypair!.did())}&registration=${encodeURIComponent(registration)}&service_auth=${encodeURIComponent(serviceAuthToken)}`;
    this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'info', message: `connecting to ${DISPATCHER_HOST}` });

    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#callbacks.onStatus('connected');
      this.#reconnectDelay = 1_000;
      this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'info', message: 'connected to relay' });
    });

    ws.addEventListener('message', async (evt) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(evt.data as string); } catch { return; }

      const $type = msg.$type as string | undefined;
      if (!$type || !$type.startsWith(`${SUBSCRIBE_NSID}#`)) return;

      const kind = $type.slice($type.indexOf('#') + 1);

      switch (kind) {
        case 'registered': {
          const f = msg as unknown as RegisteredFrame;
          this.#subdomain = f.subdomain;
          this.#proxyRef = f.proxyRef;
          this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'info', message: `registered subdomain=${f.subdomain} proxyRef=${f.proxyRef}` });
          break;
        }

        case 'request': {
          await this.#handleRequest(msg as unknown as RequestFrame);
          break;
        }

        case 'subscribe': {
          this.#handleSubscribe(msg as unknown as SubscribeFrame);
          break;
        }

        case 'subscriptionCancel': {
          this.#handleSubscriptionCancel(msg.subscriptionId as string);
          break;
        }
      }
    });

    ws.addEventListener('close', () => {
      this.#callbacks.onStatus('disconnected');
      this.#subdomain = null;
      this.#proxyRef = null;
      if (!this.#stopped) {
        this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'warn', message: `disconnected, reconnecting in ${this.#reconnectDelay}ms` });
        setTimeout(() => this.#doConnect(), this.#reconnectDelay);
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
      }
    });

    ws.addEventListener('error', () => {
      this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'error', message: 'websocket error' });
    });
  }

  stop(): void {
    this.#stopped = true;

    // Stop all subscription producers
    for (const [id, producer] of this.#producers) {
      producer.stop();
      this.#callbacks.onLog({ ts: new Date().toISOString(), severity: 'info', message: `sub:${id.slice(0, 8)} stopped` });
    }
    this.#producers.clear();

    this.#ws?.close();
    this.#ws = null;
    this.#callbacks.onStatus('disconnected');
    this.#subdomain = null;
    this.#proxyRef = null;
  }
}
