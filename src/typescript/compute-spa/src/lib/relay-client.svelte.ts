import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Secp256k1Keypair } from '@atproto/crypto';
import { IdResolver } from '@atproto/identity';
import * as jose from 'jose';
import { SSH_KEY_NSID, TTYD_CREDS_NSID, TTYD_USERNAME } from './constants.ts';

const KEYPAIR_STORAGE_KEY = 'relay:keypair';
const DISPATCHER_HOST = 'xrpc.fedproxy.com';
const SUBSCRIBE_NSID = 'com.fedproxy.temp.xrpc.subscribe';
const GET_NONCE_NSID = 'com.fedproxy.temp.xrpc.getRegistrationNonce';
const MARKET_SERVICE_ID = 'pdr_temp_market';
const COMPUTE_EVENT_SERVICE_ID = 'pdr_temp_compute_event';

export type CollectedBid = {
  did: string;
  uri: string;
  cid: string;
  record: Record<string, unknown>;
};

export const pendingBids: Map<string, CollectedBid[]> = new Map();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface RegisteredFrame {
  $type: 'com.fedproxy.temp.xrpc.subscribe#registered';
  subdomain: string;
  proxyRef: string;
}
interface RequestFrame {
  $type: 'com.fedproxy.temp.xrpc.subscribe#request';
  requestId: string;
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}
interface ResponseFrame {
  $type: 'com.fedproxy.temp.xrpc.subscribe#response';
  requestId: string;
  status: number;
  body: unknown;
  contentType?: string;
}

export interface TtydRequest {
  /** VM name / RBAC role (matches the OIDC sub `…:role:get-ttyd-password-<vmName>`). */
  vmName: string;
  /** fedproxy SERVICE name / terminal subdomain. */
  serviceName: string;
  /** Requesting user's full DID. */
  didPlc: string;
  /** Bare PLC key. */
  didPlcKey: string;
  /** ttyd password handed to the VM on an OIDC-validated getRecord. */
  password: string;
}

class RelayClient {
  // Minimal reactive state for debugging / consumers that want to observe
  status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
  subdomain = $state<string | null>(null);
  proxyRef = $state<string | null>(null);
  keypairDid = $state<string | null>(null);
  /** SERVICE names whose VM has published its sshPublicKey (un-gates Terminal). */
  sshReadyServices = $state<string[]>([]);

  // Pending VM ttyd handshakes, keyed by vmName.
  #ttydRequests = new Map<string, TtydRequest>();
  // Creates a record in the logged-in user's repo (wired from the SPA).
  #createRecord: ((collection: string, record: Record<string, unknown>) => Promise<{ uri: string; cid: string }>) | null = null;

  #keypair: Secp256k1Keypair | null = null;
  #ws: WebSocket | null = null;
  #reconnectDelay = 1_000;
  #stopped = false;
  #idResolver = new IdResolver();
  #app: Hono | null = null;

  #buildApp(): Hono {
    const app = new Hono();
    app.use('*', cors());

    // did:web document for this subscriber's subdomain identity
    app.get('/.well-known/did.json', (c) => {
      const kp = this.#keypair!;
      const subdomain = kp.did().replaceAll(':', '-').toLowerCase();
      const host = `${subdomain}.${DISPATCHER_HOST}`;
      const did = `did:web:${host}`;
      return c.json({
        '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
        id: did,
        verificationMethod: [
          {
            id: `${did}#atproto`,
            type: 'Multikey',
            controller: did,
            publicKeyMultibase: kp.did().replace(/^did:key:/, ''),
          },
        ],
        service: [
          {
            id: `#${MARKET_SERVICE_ID}`,
            type: 'PDRTempMarket',
            serviceEndpoint: `https://${host}`,
          },
          {
            id: `#${COMPUTE_EVENT_SERVICE_ID}`,
            type: 'PDRTempComputeEvent',
            serviceEndpoint: `https://${host}`,
          },
        ],
      });
    });

    // Auth for all /xrpc/* routes. VM ↔ relay calls (getRecord/createRecord)
    // carry an OIDC bearer (fedproxy-client AUTH_PLUGIN=oidc); market bidder
    // calls (submitBid/submitEvent) carry an atproto service-auth JWT.
    const VM_OIDC_NSIDS = ['com.atproto.repo.getRecord', 'com.atproto.repo.createRecord'];
    app.use('/xrpc/*', async (c, next) => {
      if (!this.subdomain) {
        return c.json({ error: 'Unauthorized', message: 'not yet registered' }, 401);
      }
      const hostname = `${this.subdomain}.${DISPATCHER_HOST}`;
      const nsid = c.req.path.slice('/xrpc/'.length);

      if (VM_OIDC_NSIDS.includes(nsid)) {
        try {
          const ttydReq = await this.#verifyTtydOidc(c.req.header('Authorization'));
          c.set('ttydReq' as never, ttydReq);
        } catch (err) {
          return c.json({ error: 'Unauthorized', message: String(err) }, 401);
        }
        await next();
        return;
      }

      try {
        const { verifyServiceAuth } = await import('@publicdomainrelay/market');
        const auth = await verifyServiceAuth({
          authHeader: c.req.header('Authorization'),
          hostname,
          lxm: nsid,
          serviceIds: [MARKET_SERVICE_ID, COMPUTE_EVENT_SERVICE_ID],
          idResolver: this.#idResolver,
        });
        c.set('callerDid' as never, auth.issuerDid);
        c.req.raw.headers.set('x-caller-did', auth.issuerDid);
      } catch (err) {
        return c.json({ error: 'Unauthorized', message: String(err) }, 401);
      }
      await next();
    });

    app.post('/xrpc/com.publicdomainrelay.temp.market.submitBid', async (c) => {
      const callerDid = c.req.header('x-caller-did') ?? '';
      let input: { uri?: string; cid?: string; record?: Record<string, unknown> };
      try { input = await c.req.json(); } catch {
        return c.json({ error: 'InvalidRequest', message: 'invalid JSON body' }, 400);
      }
      if (!input.uri || !input.cid || !input.record) {
        return c.json({ error: 'InvalidRequest', message: 'uri, cid, and record are required' }, 400);
      }
      const bid = input.record as Record<string, unknown>;
      const rfpUri = (bid.rfp as Record<string, unknown> | undefined)?.uri as string | undefined;
      if (!rfpUri) return c.json({ error: 'InvalidRequest', message: 'bid.rfp.uri missing' }, 400);
      const queue = pendingBids.get(rfpUri) ?? [];
      queue.push({ did: callerDid, uri: input.uri, cid: input.cid, record: bid });
      pendingBids.set(rfpUri, queue);
      console.log('[relay] submitBid queued', { callerDid, uri: input.uri, rfpUri });
      return c.json({ ok: true });
    });

    app.post('/xrpc/com.publicdomainrelay.temp.market.submitEvent', async (c) => {
      const callerDid = c.req.header('x-caller-did') ?? '';
      let input: { uri?: string; cid?: string; record?: Record<string, unknown> };
      try { input = await c.req.json(); } catch {
        return c.json({ error: 'InvalidRequest', message: 'invalid JSON body' }, 400);
      }
      if (!input.uri || !input.cid || !input.record) {
        return c.json({ error: 'InvalidRequest', message: 'uri, cid, and record are required' }, 400);
      }
      console.log('[relay] submitEvent received', { callerDid, uri: input.uri });
      return c.json({ ok: true });
    });

    // VM fetches its ttyd password (OIDC-validated in middleware above).
    app.get('/xrpc/com.atproto.repo.getRecord', (c) => {
      const ttydReq = c.get('ttydReq' as never) as TtydRequest | undefined;
      if (!ttydReq) return c.json({ error: 'Unauthorized' }, 401);
      const collection = c.req.query('collection');
      if (collection && collection !== TTYD_CREDS_NSID) {
        return c.json({ error: 'RecordNotFound', message: `unsupported collection ${collection}` }, 404);
      }
      console.log('[relay] ttyd getRecord served', { vmName: ttydReq.vmName });
      return c.json({
        uri: `at://${ttydReq.didPlc}/${TTYD_CREDS_NSID}/${ttydReq.vmName}`,
        value: {
          $type: TTYD_CREDS_NSID,
          username: TTYD_USERNAME,
          password: ttydReq.password,
        },
      });
    });

    // VM publishes its sshPublicKey; persist to the user's repo and un-gate Terminal.
    app.post('/xrpc/com.atproto.repo.createRecord', async (c) => {
      const ttydReq = c.get('ttydReq' as never) as TtydRequest | undefined;
      if (!ttydReq) return c.json({ error: 'Unauthorized' }, 401);
      let input: { collection?: string; record?: Record<string, unknown> };
      try { input = await c.req.json(); } catch {
        return c.json({ error: 'InvalidRequest', message: 'invalid JSON body' }, 400);
      }
      if (input.collection !== SSH_KEY_NSID || !input.record) {
        return c.json({ error: 'InvalidRequest', message: `only ${SSH_KEY_NSID} supported` }, 400);
      }
      if (!this.#createRecord) {
        return c.json({ error: 'NotReady', message: 'createRecord not wired (user not signed in)' }, 503);
      }
      try {
        const out = await this.#createRecord(SSH_KEY_NSID, input.record);
        this.#markSshReady(ttydReq.serviceName);
        console.log('[relay] sshPublicKey created', { serviceName: ttydReq.serviceName, uri: out.uri });
        return c.json(out);
      } catch (err) {
        return c.json({ error: 'HandlerError', message: String(err) }, 500);
      }
    });

    app.all('/xrpc/*', (c) =>
      c.json({ error: 'MethodNotImplemented', nsid: c.req.path.replace(/^\/xrpc\//, '') }, 501));

    return app;
  }

  async #loadOrGenerateKeypair(): Promise<Secp256k1Keypair> {
    const stored = localStorage.getItem(KEYPAIR_STORAGE_KEY);
    if (stored) {
      try {
        const state = JSON.parse(stored);
        return await Secp256k1Keypair.import(hexToBytes(state.privateKeyHex));
      } catch { /* corrupt — regenerate */ }
    }
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const privateKeyHex = bytesToHex(await kp.export());
    localStorage.setItem(
      KEYPAIR_STORAGE_KEY,
      JSON.stringify({ privateKeyHex, did: kp.did(), createdAt: new Date().toISOString() }),
    );
    return kp;
  }

  async #buildRegistration(): Promise<string> {
    const kp = this.#keypair!;
    const res = await fetch(`https://${DISPATCHER_HOST}/xrpc/${GET_NONCE_NSID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: kp.did(), signatures: [] }),
    });
    if (!res.ok) throw new Error(`getRegistrationNonce failed: ${res.status} ${await res.text()}`);
    const { nonce } = await res.json() as { nonce: string };
    const sig = await kp.sign(b64decode(nonce));
    return JSON.stringify({
      $type: 'com.fedproxy.temp.xrpc.registration',
      key: kp.did(),
      nonce,
      signatures: [{ key: kp.did(), signature: b64encode(sig) }],
    });
  }

  async #handleRequest(req: RequestFrame): Promise<{ status: number; body: unknown; contentType: string }> {
    const url = new URL(`http://local${req.path}`);
    for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);

    const hasBody = !['GET', 'HEAD'].includes(req.method) && req.body != null;
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (hasBody) headers['content-type'] = 'application/json';

    const request = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });

    const res = await this.#app!.fetch(request);
    const contentType = res.headers.get('content-type') ?? 'application/json';
    const text = await res.text();
    let body: unknown = text;
    if (contentType.includes('application/json')) {
      try { body = JSON.parse(text); } catch { /* leave as text */ }
    }
    return { status: res.status, body, contentType };
  }

  getKeypair(): import('@atproto/crypto').Secp256k1Keypair | null {
    return this.#keypair;
  }

  getAttestationKeypair(): { did: () => string; privateKey: { type: 'k256'; bytes: Uint8Array } } | null {
    const stored = localStorage.getItem(KEYPAIR_STORAGE_KEY);
    if (!stored || !this.#keypair) return null;
    try {
      const state = JSON.parse(stored);
      const bytes = hexToBytes(state.privateKeyHex);
      const did = this.#keypair.did();
      return { did: () => did, privateKey: { type: 'k256', bytes } };
    } catch { return null; }
  }

  // ── VM ttyd handshake wiring ───────────────────────────────────────────────

  /** Register a pending VM request so the relay can serve its ttyd password. */
  registerTtydRequest(req: TtydRequest) {
    this.#ttydRequests.set(req.vmName, req);
  }

  /** Wire the user-repo createRecord used to persist incoming sshPublicKey records. */
  setCreateRecord(fn: (collection: string, record: Record<string, unknown>) => Promise<{ uri: string; cid: string }>) {
    this.#createRecord = fn;
  }

  isSshReady(serviceName: string): boolean {
    return this.sshReadyServices.includes(serviceName);
  }

  #markSshReady(serviceName: string) {
    if (!this.sshReadyServices.includes(serviceName)) {
      this.sshReadyServices = [...this.sshReadyServices, serviceName];
    }
  }

  // Full OIDC validation of a VM's bearer token: match a pending request by
  // actx(didPlc) + scoped sub, then cryptographically verify against the
  // issuer's published JWKS (discovered via openid-configuration).
  async #verifyTtydOidc(authHeader?: string): Promise<TtydRequest> {
    const token = (authHeader ?? '').replace(/^Bearer\s+/i, '');
    if (token.split('.').length !== 3) throw new Error('missing or malformed OIDC token');

    const unverified = jose.decodeJwt(token);
    const rawAud = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud;
    const sub = unverified.sub ?? '';
    const iss = unverified.iss;
    if (!rawAud || !iss) throw new Error('OIDC token missing aud/iss');

    const qIdx = rawAud.indexOf('?');
    const actx = qIdx >= 0 ? new URLSearchParams(rawAud.slice(qIdx + 1)).get('actx') : null;
    if (!actx) throw new Error('OIDC aud missing actx');

    const match = [...this.#ttydRequests.values()].find((r) =>
      r.didPlc === actx &&
      sub.startsWith('actx:') &&
      sub.endsWith(`:plc:${r.didPlcKey}:role:get-ttyd-password-${r.vmName}`)
    );
    if (!match) throw new Error('no pending VM request matches token actx/sub');

    const oidcCfg = await fetch(`${iss}/.well-known/openid-configuration`).then((r) => r.json()) as { jwks_uri: string };
    const jwks = jose.createRemoteJWKSet(new URL(oidcCfg.jwks_uri));
    await jose.jwtVerify(token, jwks, { issuer: iss, audience: rawAud });
    return match;
  }

  async start() {
    this.#stopped = false;
    this.status = 'connecting';

    try {
      this.#keypair = await this.#loadOrGenerateKeypair();
      this.keypairDid = this.#keypair.did();
      this.#app = this.#buildApp();
    } catch (err) {
      console.error('[relay] keypair/app init failed:', err);
      this.status = 'disconnected';
      return;
    }

    this.#doConnect();
  }

  async #doConnect() {
    if (this.#stopped) return;

    let registration: string;
    try {
      registration = await this.#buildRegistration();
    } catch (err) {
      console.error('[relay] registration failed:', err);
      this.status = 'disconnected';
      if (!this.#stopped) setTimeout(() => this.#doConnect(), 5_000);
      return;
    }

    const url = `wss://${DISPATCHER_HOST}/xrpc/${SUBSCRIBE_NSID}?did=${encodeURIComponent(this.#keypair!.did())}&registration=${encodeURIComponent(registration)}`;
    console.log('[relay] connecting to', DISPATCHER_HOST);
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.status = 'connected';
      this.#reconnectDelay = 1_000;
      console.log('[relay] connected');
    });

    ws.addEventListener('message', async (evt) => {
      let frame: RegisteredFrame | RequestFrame;
      try { frame = JSON.parse(evt.data as string); } catch { return; }

      if (frame.$type === `${SUBSCRIBE_NSID}#registered`) {
        const f = frame as RegisteredFrame;
        this.subdomain = f.subdomain;
        this.proxyRef = f.proxyRef;
        console.log('[relay] registered', { subdomain: f.subdomain, proxyRef: f.proxyRef });
        return;
      }

      if (frame.$type === `${SUBSCRIBE_NSID}#request`) {
        const req = frame as RequestFrame;
        let result: { status: number; body: unknown; contentType: string };
        try {
          result = await this.#handleRequest(req);
        } catch (err) {
          result = { status: 500, body: { error: 'HandlerError', message: String(err) }, contentType: 'application/json' };
        }
        const response: ResponseFrame = {
          $type: `${SUBSCRIBE_NSID}#response`,
          requestId: req.requestId,
          status: result.status,
          body: result.body,
          contentType: result.contentType,
        };
        ws.send(JSON.stringify(response));
        console.log('[relay] responded', { requestId: req.requestId, status: result.status });
      }
    });

    ws.addEventListener('close', () => {
      this.status = 'disconnected';
      this.subdomain = null;
      this.proxyRef = null;
      if (!this.#stopped) {
        console.log('[relay] disconnected, reconnecting in', this.#reconnectDelay, 'ms');
        setTimeout(() => this.#doConnect(), this.#reconnectDelay);
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
      }
    });

    ws.addEventListener('error', (e) => {
      console.error('[relay] ws error', e);
    });
  }

  stop() {
    this.#stopped = true;
    this.#ws?.close();
    this.#ws = null;
    this.status = 'disconnected';
    this.subdomain = null;
    this.proxyRef = null;
  }
}

export const relayClient = new RelayClient();
