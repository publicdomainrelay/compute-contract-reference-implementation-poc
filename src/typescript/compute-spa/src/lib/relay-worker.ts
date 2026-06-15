/**
 * relay-worker.ts — SharedWorker that hosts the fedproxy relay connection.
 *
 * Why a SharedWorker: the in-browser relay (a WebSocket to xrpc.fedproxy.com
 * plus a Hono dispatcher that answers XRPC requests proxied back from the
 * dispatcher) must stay subscribed for a provisioned VM to publish its SSH host
 * key and bring up its terminal route. If that loop lives in the page, the
 * relay drops the moment the tab is backgrounded/navigated/closed and the VM's
 * createRecord gets "404 no active subscriber" → "no route configured for host".
 *
 * Hosting it in a SharedWorker keeps a single relay alive shared across every
 * same-origin tab: it survives one tab backgrounding, navigation, or closing as
 * long as ONE ui.fedfork.com tab stays open. (Nothing in-browser survives all
 * tabs closing — the OAuth session lives in page context.)
 *
 * OAuth-bound operations the relay needs — minting atproto service-auth,
 * writing the user's repo (createRecord), and forwarding public reads to the
 * in-browser PDS (pdsFetch) — require the page's OAuth session, so the worker
 * proxies them to an elected "host" port (a connected tab that has signed in).
 *
 * Everything else (WebSocket, Hono routing, OIDC verification of the VM's
 * bearer token, bid collection) runs entirely in the worker.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Secp256k1Keypair } from '@atproto/crypto';
import { IdResolver } from '@atproto/identity';
import * as jose from 'jose';
import { SSH_KEY_NSID, TTYD_CREDS_NSID, TTYD_USERNAME } from './constants.ts';

const DISPATCHER_HOST = 'xrpc.fedproxy.com';
const SUBSCRIBE_NSID = 'com.fedproxy.temp.xrpc.subscribe';
const GET_NONCE_NSID = 'com.fedproxy.temp.xrpc.getRegistrationNonce';
const MARKET_SERVICE_ID = 'pdr_temp_market';
const COMPUTE_EVENT_SERVICE_ID = 'pdr_temp_compute_event';

interface TtydRequest {
  vmName: string;
  serviceName: string;
  didPlc: string;
  didPlcKey: string;
  password: string;
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
interface RegisteredFrame {
  $type: 'com.fedproxy.temp.xrpc.subscribe#registered';
  subdomain: string;
  proxyRef: string;
}

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

// ── shared relay state (single instance per SharedWorker) ──────────────────

const idResolver = new IdResolver();
const ttydRequests = new Map<string, TtydRequest>();

let keypair: Secp256k1Keypair | null = null;
let ws: WebSocket | null = null;
let reconnectDelay = 1_000;
let stopped = false;
let app: Hono | null = null;

const state = {
  status: 'disconnected' as 'disconnected' | 'connecting' | 'connected',
  subdomain: null as string | null,
  proxyRef: null as string | null,
  keypairDid: null as string | null,
  sshReadyServices: [] as string[],
};

// ── connected ports (tabs) + host election ─────────────────────────────────

const ports = new Set<MessagePort>();
/** Ports whose tab has the OAuth session wired (can serve createRecord etc.). */
const minterPorts = new Set<MessagePort>();

function hostPort(): MessagePort | null {
  for (const p of minterPorts) return p; // first available
  return null;
}

function broadcast(msg: unknown) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch { /* dead port */ }
  }
}

function broadcastState() {
  broadcast({ t: 'state', ...state });
}

// ── OAuth proxy: call back into the elected host tab ───────────────────────

let oauthSeq = 0;
const pendingOauth = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function callHost(kind: string, args: unknown, transfer?: Transferable[]): Promise<unknown> {
  const host = hostPort();
  if (!host) return Promise.reject(new Error('no host tab available (user not signed in / all tabs closed)'));
  const id = `o${++oauthSeq}`;
  return new Promise((resolve, reject) => {
    pendingOauth.set(id, { resolve, reject });
    try {
      host.postMessage({ t: 'oauth', id, kind, args }, transfer ?? []);
    } catch (err) {
      pendingOauth.delete(id);
      reject(err);
    }
    // Safety timeout so a wedged tab can't hang the VM forever.
    setTimeout(() => {
      if (pendingOauth.has(id)) {
        pendingOauth.delete(id);
        reject(new Error(`oauth ${kind} timed out`));
      }
    }, 30_000);
  });
}

async function oauthCreateRecord(collection: string, record: Record<string, unknown>): Promise<{ uri: string; cid: string }> {
  return await callHost('createRecord', { collection, record }) as { uri: string; cid: string };
}

async function oauthGetServiceAuth(lxm: string): Promise<string> {
  return await callHost('getServiceAuth', { lxm }) as string;
}

async function oauthPdsFetch(request: Request): Promise<Response> {
  const buf = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const res = await callHost('pdsFetch', {
    method: request.method,
    url: request.url,
    headers,
    body: buf,
  }, buf ? [buf] : []) as { status: number; statusText: string; headers: Record<string, string>; body: ArrayBuffer | null };
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// ── Hono app (relay request dispatcher) ────────────────────────────────────

function markSshReady(serviceName: string) {
  if (!state.sshReadyServices.includes(serviceName)) {
    state.sshReadyServices = [...state.sshReadyServices, serviceName];
    broadcastState();
  }
}

async function verifyTtydOidc(authHeader?: string): Promise<TtydRequest> {
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

  const match = [...ttydRequests.values()].find((r) =>
    r.didPlc === actx &&
    sub.startsWith('actx:') &&
    (sub.endsWith(`:plc:${r.didPlcKey}:role:get-ttyd-password-${r.vmName}`) ||
     sub.endsWith(`:plc:${r.didPlcKey}:role:${r.vmName}`))
  );
  if (!match) throw new Error('no pending VM request matches token actx/sub');

  const oidcCfg = await fetch(`${iss}/.well-known/openid-configuration`).then((r) => r.json()) as { jwks_uri: string };
  const jwks = jose.createRemoteJWKSet(new URL(oidcCfg.jwks_uri));
  await jose.jwtVerify(token, jwks, { issuer: iss, audience: rawAud });
  return match;
}

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', cors());

  app.get('/.well-known/did.json', (c) => {
    const kp = keypair!;
    const subdomain = kp.did().replaceAll(':', '-').toLowerCase();
    const host = `${subdomain}.${DISPATCHER_HOST}`;
    const did = `did:web:${host}`;
    return c.json({
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: did,
      verificationMethod: [
        { id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: kp.did().replace(/^did:key:/, '') },
      ],
      service: [
        { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: `https://${host}` },
        { id: `#${MARKET_SERVICE_ID}`, type: 'PDRTempMarket', serviceEndpoint: `https://${host}` },
        { id: `#${COMPUTE_EVENT_SERVICE_ID}`, type: 'PDRTempComputeEvent', serviceEndpoint: `https://${host}` },
      ],
    });
  });

  const OIDC_CREATE_NSIDS = ['com.atproto.repo.createRecord'];
  const MARKET_NSIDS = [
    'com.publicdomainrelay.temp.market.submitBid',
    'com.publicdomainrelay.temp.market.submitEvent',
  ];
  app.use('/xrpc/*', async (c, next) => {
    if (!state.subdomain) {
      return c.json({ error: 'Unauthorized', message: 'not yet registered' }, 401);
    }
    const hostname = `${state.subdomain}.${DISPATCHER_HOST}`;
    const nsid = c.req.path.slice('/xrpc/'.length);

    const isGetRecord = nsid === 'com.atproto.repo.getRecord';
    const isListRecords = nsid === 'com.atproto.repo.listRecords';
    const isDescribe = nsid === 'com.atproto.server.describeServer';
    if (isGetRecord || isListRecords || isDescribe) {
      if (isGetRecord && c.req.query('collection') === TTYD_CREDS_NSID) {
        try {
          const ttydReq = await verifyTtydOidc(c.req.header('Authorization'));
          c.set('ttydReq' as never, ttydReq);
        } catch (err) {
          return c.json({ error: 'Unauthorized', message: String(err) }, 401);
        }
      }
      await next();
      return;
    }

    if (OIDC_CREATE_NSIDS.includes(nsid)) {
      try {
        const ttydReq = await verifyTtydOidc(c.req.header('Authorization'));
        c.set('ttydReq' as never, ttydReq);
      } catch (err) {
        return c.json({ error: 'Unauthorized', message: String(err) }, 401);
      }
      await next();
      return;
    }

    if (MARKET_NSIDS.includes(nsid)) {
      try {
        const { verifyServiceAuth } = await import('@publicdomainrelay/market');
        const auth = await verifyServiceAuth({
          authHeader: c.req.header('Authorization'),
          hostname,
          lxm: nsid,
          serviceIds: [MARKET_SERVICE_ID, COMPUTE_EVENT_SERVICE_ID],
          idResolver,
        });
        c.set('callerDid' as never, auth.issuerDid);
        c.req.raw.headers.set('x-caller-did', auth.issuerDid);
      } catch (err) {
        return c.json({ error: 'Unauthorized', message: String(err) }, 401);
      }
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
    // Bids are consumed by the requester flow in the page; stream to all tabs.
    broadcast({ t: 'bid', rfpUri, bid: { did: callerDid, uri: input.uri, cid: input.cid, record: bid } });
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
    broadcast({ t: 'event', callerDid, uri: input.uri });
    return c.json({ ok: true });
  });

  app.get('/xrpc/com.atproto.repo.getRecord', async (c) => {
    const ttydReq = c.get('ttydReq' as never) as TtydRequest | undefined;
    const collection = c.req.query('collection');
    if (ttydReq && (!collection || collection === TTYD_CREDS_NSID)) {
      return c.json({
        uri: `at://${ttydReq.didPlc}/${TTYD_CREDS_NSID}/${ttydReq.vmName}`,
        value: { $type: TTYD_CREDS_NSID, username: TTYD_USERNAME, password: ttydReq.password },
      });
    }
    try {
      const pdsRes = await oauthPdsFetch(c.req.raw);
      return new Response(pdsRes.body, { status: pdsRes.status, statusText: pdsRes.statusText, headers: pdsRes.headers });
    } catch { /* fall through */ }
    return c.json({ error: 'RecordNotFound', message: 'PDS not available' }, 503);
  });

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
    try {
      const out = await oauthCreateRecord(SSH_KEY_NSID, input.record);
      markSshReady(ttydReq.serviceName);
      return c.json(out);
    } catch (err) {
      return c.json({ error: 'HandlerError', message: String(err) }, 500);
    }
  });

  app.all('/xrpc/*', async (c) => {
    try {
      const pdsRes = await oauthPdsFetch(c.req.raw);
      return new Response(pdsRes.body, { status: pdsRes.status, statusText: pdsRes.statusText, headers: pdsRes.headers });
    } catch { /* fall through */ }
    return c.json({ error: 'MethodNotImplemented', nsid: c.req.path.replace(/^\/xrpc\//, '') }, 501);
  });

  return app;
}

// ── relay connection loop ──────────────────────────────────────────────────

async function buildRegistration(): Promise<string> {
  const kp = keypair!;
  const token = await oauthGetServiceAuth(GET_NONCE_NSID);
  const res = await fetch(`https://${DISPATCHER_HOST}/xrpc/${GET_NONCE_NSID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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

async function handleRequest(req: RequestFrame): Promise<{ status: number; body: unknown; contentType: string }> {
  const url = new URL(`http://local${req.path}`);
  for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);
  const hasBody = !['GET', 'HEAD'].includes(req.method) && req.body != null;
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (hasBody) headers['content-type'] = 'application/json';
  const request = new Request(url, { method: req.method, headers, body: hasBody ? JSON.stringify(req.body) : undefined });
  const res = await app!.fetch(request);
  const contentType = res.headers.get('content-type') ?? 'application/json';
  const text = await res.text();
  let body: unknown = text;
  if (contentType.includes('application/json')) {
    try { body = JSON.parse(text); } catch { /* leave as text */ }
  }
  return { status: res.status, body, contentType };
}

async function doConnect() {
  if (stopped) return;
  if (!keypair) {
    // init (keypair hex) not processed yet — retry shortly.
    setTimeout(doConnect, 200);
    return;
  }
  if (!hostPort()) {
    // No signed-in tab to mint service-auth; wait for one.
    state.status = 'disconnected';
    broadcastState();
    return;
  }

  let registration: string;
  try {
    registration = await buildRegistration();
  } catch (err) {
    console.error('[relay-worker] registration failed:', err);
    state.status = 'disconnected';
    broadcastState();
    if (!stopped) setTimeout(doConnect, 5_000);
    return;
  }

  const serviceAuthToken = await oauthGetServiceAuth(SUBSCRIBE_NSID);
  const url = `wss://${DISPATCHER_HOST}/xrpc/${SUBSCRIBE_NSID}?did=${encodeURIComponent(keypair!.did())}&registration=${encodeURIComponent(registration)}&service_auth=${encodeURIComponent(serviceAuthToken)}`;
  const sock = new WebSocket(url);
  ws = sock;

  sock.addEventListener('open', () => {
    state.status = 'connected';
    reconnectDelay = 1_000;
    broadcastState();
  });

  sock.addEventListener('message', async (evt) => {
    let frame: RegisteredFrame | RequestFrame;
    try { frame = JSON.parse(evt.data as string); } catch { return; }

    if (frame.$type === `${SUBSCRIBE_NSID}#registered`) {
      const f = frame as RegisteredFrame;
      state.subdomain = f.subdomain;
      state.proxyRef = f.proxyRef;
      broadcastState();
      return;
    }

    if (frame.$type === `${SUBSCRIBE_NSID}#request`) {
      const req = frame as RequestFrame;
      let result: { status: number; body: unknown; contentType: string };
      try {
        result = await handleRequest(req);
      } catch (err) {
        result = { status: 500, body: { error: 'HandlerError', message: String(err) }, contentType: 'application/json' };
      }
      sock.send(JSON.stringify({
        $type: `${SUBSCRIBE_NSID}#response`,
        requestId: req.requestId,
        status: result.status,
        body: result.body,
        contentType: result.contentType,
      }));
    }
  });

  sock.addEventListener('close', () => {
    state.status = 'disconnected';
    state.subdomain = null;
    state.proxyRef = null;
    broadcastState();
    if (!stopped) {
      setTimeout(doConnect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }
  });

  sock.addEventListener('error', (e) => console.error('[relay-worker] ws error', e));
}

async function start() {
  stopped = false;
  if (state.status !== 'disconnected') return;
  state.status = 'connecting';
  broadcastState();
  if (!app) app = buildApp();
  await doConnect();
}

function stop() {
  stopped = true;
  ws?.close();
  ws = null;
  state.status = 'disconnected';
  state.subdomain = null;
  state.proxyRef = null;
  broadcastState();
}

// ── port (tab) wiring ──────────────────────────────────────────────────────

async function ensureKeypair(privateKeyHex: string) {
  if (keypair) return;
  keypair = await Secp256k1Keypair.import(hexToBytes(privateKeyHex));
  state.keypairDid = keypair.did();
  broadcastState();
}

function onPortMessage(port: MessagePort, data: any) {
  switch (data?.t) {
    case 'init':
      ensureKeypair(data.privateKeyHex).catch((e) => console.error('[relay-worker] keypair init', e));
      break;
    case 'minter':
      if (data.available) minterPorts.add(port); else minterPorts.delete(port);
      // A freshly signed-in tab may unblock a stalled registration.
      if (data.available && !stopped && state.status === 'disconnected') start();
      break;
    case 'start':
      start();
      break;
    case 'stop':
      stop();
      break;
    case 'registerTtyd':
      ttydRequests.set(data.req.vmName, data.req as TtydRequest);
      break;
    case 'oauthResult': {
      const pending = pendingOauth.get(data.id);
      if (pending) {
        pendingOauth.delete(data.id);
        if (data.ok) pending.resolve(data.value);
        else pending.reject(new Error(data.err ?? 'oauth error'));
      }
      break;
    }
    case 'bye':
      removePort(port);
      break;
  }
}

function removePort(port: MessagePort) {
  ports.delete(port);
  minterPorts.delete(port);
  // Fail any in-flight oauth calls that were waiting on a now-gone host.
  if (!hostPort()) {
    for (const [id, p] of pendingOauth) { p.reject(new Error('host tab closed')); pendingOauth.delete(id); }
  }
}

// SharedWorker entry: one connection per tab.
(self as unknown as SharedWorkerGlobalScope).onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  ports.add(port);
  port.onmessage = (ev) => onPortMessage(port, ev.data);
  port.start();
  // Send current state immediately so a newly-attached tab is in sync.
  port.postMessage({ t: 'state', ...state });
};
