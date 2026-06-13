import { Secp256k1Keypair } from '@atproto/crypto';
import { Hono, type Context } from 'hono';
import { runSubscriber, type SubscriberController } from '../../../lib/xrpc-relay/subscriber.ts';
import { SUBSCRIBE_NSID, GET_NONCE_NSID } from '../../../lib/xrpc-relay/types.ts';
import { createSubscriberFactory } from '../../../lib/hono-factory-xrpc-subscriber/mod.ts';
import { EventBus } from '../../../lib/event-bus/mod.ts';

const KEYPAIR_KEY = 'relay-demo:keypair';
// Defaults to production; override at dev/build time with VITE_DISPATCHER_HOST
// (e.g. xrpc-test.fedproxy.com).
export const DISPATCHER_HOST = import.meta.env.VITE_DISPATCHER_HOST ?? 'xrpc.fedproxy.com';

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

// ── keypair codec helpers ─────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── demo Hono app ─────────────────────────────────────────────────
//
// Relay #request frames are dispatched into this app by the subscriber
// factory (createSubscriberFactory). This is a real XRPC server: callers
// hitting wss/https://<subdomain>.<dispatcher>/xrpc/<nsid> are routed here.

const startedAt = new Date().toISOString();

function xrpcError(c: Context, status: number, error: string, message: string) {
  return c.json({ error, message }, status as 400 | 404 | 500);
}

// ── event source ──────────────────────────────────────────────────
//
// Real event source for subscriptions: the Hono app publishes one event
// per XRPC request it handles, via the shared @publicdomainrelay/event-bus.
// Subscribers stream that live activity — no synthetic/fabricated data.

export interface RepoEvent {
  seq: number;
  time: string;
  type: 'request';
  method: string;
  path: string;
  status: number;
}

function buildDemoApp(did: string, bus: EventBus<RepoEvent>): Hono {
  const app = new Hono();
  let seq = 0;

  // Publish every handled XRPC request as a subscription event.
  app.use('/xrpc/*', async (c, next) => {
    await next();
    bus.publish({
      seq: ++seq,
      time: new Date().toISOString(),
      type: 'request',
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
    });
  });

  // Liveness probe.
  app.get('/xrpc/_health', (c) => c.json({ status: 'ok' }));

  // Identity / status of this subscriber.
  app.get('/xrpc/com.example.getStatus', (c) =>
    c.json({ did, startedAt, now: new Date().toISOString() }));

  // Echo query params back (typed XRPC query).
  app.get('/xrpc/com.example.echo', (c) => {
    const msg = c.req.query('msg');
    if (msg == null) return xrpcError(c, 400, 'InvalidRequest', 'missing "msg" param');
    return c.json({ msg });
  });

  // Accept a procedure body and acknowledge it.
  app.post('/xrpc/com.example.ping', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ pong: true, received: body, at: new Date().toISOString() });
  });

  // Unknown XRPC method → proper error shape.
  app.all('/xrpc/*', (c) =>
    xrpcError(c, 404, 'MethodNotImplemented', `no route for ${new URL(c.req.url).pathname}`));

  app.all('*', (c) => xrpcError(c, 404, 'NotFound', 'not an XRPC path'));
  return app;
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
  #ctrl: SubscriberController | null = null;

  constructor(callbacks: RelaySubscriberCallbacks) {
    this.#callbacks = callbacks;
  }

  get subdomain() { return this.#ctrl?.subdomain ?? null; }
  get proxyRef() { return this.#ctrl?.proxyRef ?? null; }

  #log(severity: LogEvent['severity'], message: string) {
    this.#callbacks.onLog({ ts: new Date().toISOString(), severity, message });
  }

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

  // ── connect ─────────────────────────────────────────────────────

  /** @param getServiceAuth — `(lxm: string) => Promise<string>` from the local PDS */
  async connect(getServiceAuth: (lxm: string) => Promise<string>): Promise<void> {
    this.#callbacks.onStatus('connecting');
    this.#log('info', 'starting relay subscriber');

    try {
      this.#keypair = await this.#loadOrGenerateKeypair();
      this.#log('info', `keypair ready: ${this.#keypair.did()}`);
    } catch (err) {
      this.#callbacks.onStatus('error');
      this.#log('error', `init failed: ${err}`);
      return;
    }

    const bus = new EventBus<RepoEvent>();
    const factory = createSubscriberFactory({ app: buildDemoApp(this.#keypair.did(), bus) });
    this.#ctrl = runSubscriber({
      label: 'relay-demo',
      keypair: this.#keypair,
      getServiceAuthToken: getServiceAuth,
      dispatcherHost: DISPATCHER_HOST,
      handleRequest: factory.handleRequest,
      onStatus: (s) => this.#callbacks.onStatus(s),
      onLog: (e) => this.#log(e.severity, e.message),
      onSubscriptionOpen: (sub) => this.#callbacks.onSubscription({
        subscriptionId: sub.subscriptionId,
        nsid: sub.nsid,
        params: sub.params ?? {},
        eventCount: 0,
        startedAt: new Date().toISOString(),
      }),
      // Real event source: fan out the request-activity bus to each subscriber.
      subscribe: (sub, emit) => bus.subscribe((msg) => {
        emit(msg);
        this.#callbacks.onSubscriptionEvent(sub.subscriptionId, msg);
      }),
    });
  }

  stop(): void {
    this.#ctrl?.stop();
    this.#ctrl = null;
  }
}
