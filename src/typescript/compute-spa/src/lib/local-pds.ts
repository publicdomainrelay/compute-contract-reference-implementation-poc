// local-pds.ts — in-browser atproto PDS with did:plc identity.
// No OAuth sign-in required. Boots a repo factory, registers a did:plc,
// and exposes an Agent-compatible interface for record ops + service auth.
//
// Adapted from web-client-example/src/lib/local-pds.ts

import { Secp256k1Keypair } from '@atproto/crypto';
import {
  createRepoFactory,
  MemoryStorage,
  signServiceAuth,
  nextTid,
  type Signer,
  type WriteOp,
  type CommitEvent,
} from '@publicdomainrelay/hono-factory-atproto-repo';
import { createGenesisOp, PlcClient, PlcNotFoundError } from '@publicdomainrelay/did-plc';

const KEYPAIR_STORAGE_KEY = 'relay:keypair';  // share keypair with relay-client

const TAG = '%c[local-pds]';
const STYLE = 'color:#7c3aed;font-weight:bold';
const log = (msg: string, ...rest: unknown[]) => console.log(`${TAG} ${msg}`, STYLE, ...rest);

// PLC directory — default to production; override at build time.
// deno-lint-ignore no-explicit-any
const PLC_DIRECTORY_URL =
  (import.meta as any).env?.VITE_PLC_DIRECTORY_URL ?? 'https://plc.directory';

// deno-lint-ignore no-explicit-any
const DISPATCHER_HOST =
  (import.meta as any).env?.VITE_DISPATCHER_HOST ?? 'xrpc.fedproxy.com';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface LocalPds {
  did: string;
  plcDirectoryUrl: string;
  /** Fetch handler routing XRPC calls through the in-browser PDS. */
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
  /** Mint a service-auth JWT for the given audience + lxm. */
  getServiceAuth: (lxm: string) => Promise<string>;
  /** Create a record in the local repo. */
  createRecord: (collection: string, record: Record<string, unknown>) => Promise<{ uri: string; cid: string }>;
  /** Agent-compatible object for createMarketClient / createRecord helpers. */
  agent: {
    did: string;
    assertDid: string;
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
    /** Base URL XrpcClient uses to resolve XRPC paths. */
    service: string;
    com: {
      atproto: {
        repo: {
          createRecord(args: { repo?: string; collection: string; record: Record<string, unknown> }): Promise<{ success: boolean; data: { uri: string; cid: string } }>;
          getRecord(args: { repo?: string; collection: string; rkey: string }): Promise<{ success: boolean; data: { uri: string; value: unknown } }>;
          listRecords(args: { repo?: string; collection: string; limit?: number; cursor?: string }): Promise<{ success: boolean; data: { records: Array<{ uri: string; cid: string; value: unknown }>; cursor?: string } }>;
          deleteRecord(args: { repo?: string; collection: string; rkey: string }): Promise<{ success: boolean }>;
        };
        server: {
          getServiceAuth(args: { aud: string; lxm?: string }): Promise<{ success: boolean; data: { token: string } }>;
        };
      };
    };
  };
}

async function loadOrGenerateKeypair(): Promise<Secp256k1Keypair> {
  // The relay-client generates the keypair first (relay:keypair). The PDS
  // shares it so the did:plc PDS endpoint matches the relay subdomain.
  // Retry briefly in case of boot race.
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = localStorage.getItem(KEYPAIR_STORAGE_KEY);
    if (stored) {
      try {
        const state = JSON.parse(stored);
        return await Secp256k1Keypair.import(hexToBytes(state.privateKeyHex));
      } catch { /* corrupt — regenerate */ }
    }
    if (attempt < 9) await new Promise(r => setTimeout(r, 200));
  }
  // Fallback: generate one ourselves (relay will overwrite; PLC endpoint may drift).
  const kp = await Secp256k1Keypair.create({ exportable: true });
  const privateKeyHex = bytesToHex(await kp.export());
  localStorage.setItem(KEYPAIR_STORAGE_KEY, JSON.stringify({ privateKeyHex, did: kp.did(), createdAt: new Date().toISOString() }));
  return kp;
}

export async function startLocalPds(): Promise<LocalPds> {
  log('booting in-browser PDS…');
  const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });

  // ── keypair ─────────────────────────────────────────────────────
  log('loading/generating keypair…');
  const keypair = await loadOrGenerateKeypair();
  const signingKeyDid = keypair.did();
  log('signing key:', signingKeyDid);

  // ── attestation keypair (for badge.blue signing) ────────────────
  // Re-use or generate a second keypair for market attestation signing.
  const attestationKp = await (async () => {
    const stored = localStorage.getItem('local-pds:attestation-keypair');
    if (stored) {
      try {
        return await Secp256k1Keypair.import(hexToBytes(JSON.parse(stored).privateKeyHex));
      } catch { /* regenerate */ }
    }
    const kp = await Secp256k1Keypair.create({ exportable: true });
    localStorage.setItem('local-pds:attestation-keypair', JSON.stringify({
      privateKeyHex: bytesToHex(await kp.export()),
      did: kp.did(),
      createdAt: new Date().toISOString(),
    }));
    return kp;
  })();

  // ── did:plc registration ────────────────────────────────────────
  log('building did:plc genesis op…');
  const { did, op } = await createGenesisOp({
    rotationKeys: [signingKeyDid],
    verificationMethods: {
      atproto: signingKeyDid,
      attestation: attestationKp.did(),
    },
    services: {
      atproto_pds: {
        type: "AtprotoPersonalDataServer",
        endpoint: `https://${signingKeyDid.replace(/:/g, "-").toLowerCase()}.${DISPATCHER_HOST}`,
      },
    },
    sign: (bytes) => keypair.sign(bytes),
  });
  log('did:plc:', did);

  const alreadyExists = await plc.resolve(did).then(() => true).catch((e) => {
    if (e instanceof PlcNotFoundError) return false;
    throw e;
  });
  if (!alreadyExists) {
    await plc.submitOp(did, op);
    log('did:plc registered');
  } else {
    log('did:plc already exists');
  }

  // ── repo factory ────────────────────────────────────────────────
  const signer: Signer = {
    did: () => did,
    sign: (bytes) => keypair.sign(bytes),
  };

  const { app, api } = createRepoFactory({
    storage: new MemoryStorage(),
    signer,
  });
  log('PDS mounted');

  // ── request/response logging ────────────────────────────────────
  app.use('*', async (c, next) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const start = Date.now();
    log(`→ ${method} ${path}`);
    await next();
    const status = c.res.status;
    const durationMs = Date.now() - start;
    let responseBody: unknown;
    try {
      const text = await c.res.clone().text();
      try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    } catch { responseBody = null; }
    const prefix = status >= 400 ? '✗' : '←';
    console.log(`${TAG} ${prefix} ${method} ${path}`, STYLE, { status, durationMs, responseBody });
  });

  // ── atproto-proxy forwarding ───────────────────────────────────
  // When the XrpcClient sets the atproto-proxy header (PDS service proxying),
  // resolve the DID ref to an HTTP endpoint and forward the request directly.
  // This lets the in-browser PDS talk to bidders/registries behind fedproxy tunnels.

  app.use('*', async (c, next) => {
    const proxyTarget = c.req.header('atproto-proxy');
    if (!proxyTarget) return next();

    // Parse did:web:HOST#serviceId → fetch DID doc, extract serviceEndpoint.
    const match = proxyTarget.match(/^did:web:([^#]+)(?:#(.+))?$/);
    if (!match) {
      return c.json({ error: 'InvalidRequest', message: `Cannot resolve proxy target: ${proxyTarget}` }, 400);
    }
    const host = match[1];
    const serviceId = match[2] ?? 'atproto_pds';

    let endpoint: string;
    try {
      // Try fetching the DID doc (may fail due to CORS when the tunnel
      // doesn't return Access-Control-Allow-Origin). Fall back to assuming
      // the service endpoint is the base of the DID web host itself — this
      // is the standard pattern for fedproxy tunnel DIDs.
      let didDoc: { service?: Array<{ id: string; type: string; serviceEndpoint: string }> } | null = null;
      try {
        didDoc = await fetch(`https://${host}/.well-known/did.json`).then(r => r.ok ? r.json() : null);
      } catch { /* CORS or network error — fall through */ }
      const svc = (didDoc?.service ?? []).find(s => s.id === `#${serviceId}`);
      if (svc?.serviceEndpoint) {
        endpoint = svc.serviceEndpoint;
      } else if (didDoc) {
        // DID doc fetched but service not found.
        return c.json({ error: 'InvalidRequest', message: `Service #${serviceId} not found in DID doc for ${host}` }, 400);
      } else {
        // DID doc unreachable (CORS most likely) — assume endpoint is the host itself.
        endpoint = `https://${host}`;
      }
    } catch (err) {
      return c.json({ error: 'InvalidRequest', message: `Failed to resolve proxy target ${proxyTarget}: ${err}` }, 502);
    }

    // Forward: build URL, copy method/body/headers (except host + proxy).
    const url = new URL(c.req.path, endpoint);
    // Preserve query string from original request.
    url.search = new URL(c.req.url).search;

    const fwdHeaders = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'atproto-proxy') return;
      fwdHeaders.set(k, v);
    });

    // Add service-auth JWT so the bidder verifies the caller.
    // Extract lxm from the request path (e.g. /xrpc/com.publicdomainrelay.temp.market.submitRfp).
    const lxm = c.req.path.startsWith('/xrpc/') ? c.req.path.slice('/xrpc/'.length).split('?')[0] : undefined;
    if (lxm) {
      const token = await signServiceAuth(signer, { aud: proxyTarget, lxm });
      fwdHeaders.set('authorization', `Bearer ${token}`);
    }

    let body: BodyInit | null = null;
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      body = await c.req.raw.clone().text();
      if (!fwdHeaders.has('content-type')) fwdHeaders.set('content-type', 'application/json');
    }

    try {
      const fwdRes = await fetch(url.toString(), {
        method: c.req.method,
        headers: fwdHeaders,
        body,
      });
      return new Response(fwdRes.body, {
        status: fwdRes.status,
        statusText: fwdRes.statusText,
        headers: fwdRes.headers,
      });
    } catch (err) {
      return c.json({ error: 'InvalidRequest', message: `Proxy forward failed: ${err}` }, 502);
    }
  });

  // ── build the LocalPds object ───────────────────────────────────
  const origin = 'http://local-pds';
  const pdsFetch = (input: Request | string, init?: RequestInit): Promise<Response> => {
    // XrpcClient.buildFetchHandler constructs a full URL (new URL(path, service))
    // and passes it as the first arg. Handle string, URL, and Request.
    let req: Request;
    if (input instanceof Request) {
      req = input;
    } else if (typeof input === 'string') {
      req = new Request(input.startsWith('/') ? origin + input : input, init);
    } else {
      // URL object — already has full origin from buildFetchHandler
      req = new Request(String(input), init);
    }
    return app.fetch(req);
  };

  const getServiceAuth = async (lxm: string): Promise<string> => {
    return await signServiceAuth(signer, { aud: `did:web:${DISPATCHER_HOST}`, lxm });
  };

  const repoDid = did; // local repo owner

  // Helper: commit a single create via applyWrites, return uri + cid.
  async function createRecord(
    collection: string,
    record: Record<string, unknown>,
  ): Promise<{ uri: string; cid: string }> {
    const rkey = nextTid().toString();
    const write: WriteOp = { action: "create", collection, rkey, record };
    const commit: CommitEvent = await api.applyWrites(repoDid, [write]);
    const opCid = commit.ops[0]?.cid;
    const cid = opCid ? opCid.toString() : commit.commit.toString();
    return { uri: `at://${repoDid}/${collection}/${rkey}`, cid };
  }

  const agent = {
    get did() { return repoDid; },
    get assertDid() { return repoDid; },
    fetch: pdsFetch,
    /** XrpcClient.buildFetchHandler resolves this as base URL for XRPC calls. */
    service: origin,
    com: {
      atproto: {
        repo: {
          async createRecord(args: { repo?: string; collection: string; record: Record<string, unknown> }) {
            const data = await createRecord(args.collection, args.record);
            return { success: true as const, data };
          },
          async getRecord(args: { repo?: string; collection: string; rkey: string }) {
            const result = await api.getRecord(args.repo ?? repoDid, args.collection, args.rkey);
            if (!result) throw new Error('RecordNotFound');
            return { success: true as const, data: { uri: result.uri, value: result.value } };
          },
          async listRecords(args: { repo?: string; collection: string; limit?: number; cursor?: string }) {
            const result = await api.listRecords(args.repo ?? repoDid, args.collection, { limit: args.limit, cursor: args.cursor });
            return { success: true as const, data: { records: result.records, cursor: result.cursor } };
          },
          async deleteRecord(args: { repo?: string; collection: string; rkey: string }) {
            const write: WriteOp = { action: "delete", collection: args.collection, rkey: args.rkey };
            await api.applyWrites(args.repo ?? repoDid, [write]);
            return { success: true as const };
          },
        },
        server: {
          async getServiceAuth(args: { aud: string; lxm?: string }) {
            const token = await signServiceAuth(signer, { aud: args.aud, lxm: args.lxm });
            return { success: true as const, data: { token } };
          },
        },
      },
    },
  };

  return {
    did,
    plcDirectoryUrl: PLC_DIRECTORY_URL,
    fetch: pdsFetch,
    getServiceAuth,
    createRecord,
    agent,
  };
}
