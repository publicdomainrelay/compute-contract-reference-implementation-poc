/**
 * relay-client.svelte.ts — page-side bridge to the relay SharedWorker.
 *
 * The actual relay (WebSocket to xrpc.fedproxy.com + Hono dispatcher) lives in
 * relay-worker.ts so it stays subscribed across tab backgrounding/navigation/
 * close as long as one same-origin tab is open (see that file's header).
 *
 * This bridge keeps the exact public surface the SPA already consumes
 * (relayClient.{status,subdomain,proxyRef,isSshReady,start,stop,
 * registerTtydRequest,setCreateRecord,setPdsFetch,setServiceAuthMinter,
 * getAttestationKeypair} + the pendingBids map) so no other file changes.
 *
 * Two responsibilities:
 *   1. Mirror the worker's relay state into Svelte $state for the UI.
 *   2. Serve the worker's OAuth-bound callbacks (createRecord / pdsFetch /
 *      getServiceAuth) using this tab's OAuth session, since the worker has no
 *      session of its own. A tab advertises itself as a "minter" once signed in;
 *      the worker routes those calls to any one live minter tab.
 */

import { Secp256k1Keypair } from '@atproto/crypto';

const KEYPAIR_STORAGE_KEY = 'relay:keypair';

export type CollectedBid = {
  did: string;
  uri: string;
  cid: string;
  record: Record<string, unknown>;
};

/** Populated from the worker's submitBid stream; read by vm-market.ts. */
export const pendingBids: Map<string, CollectedBid[]> = new Map();

export interface TtydRequest {
  vmName: string;
  serviceName: string;
  didPlc: string;
  didPlcKey: string;
  password: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

class RelayClient {
  status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
  subdomain = $state<string | null>(null);
  proxyRef = $state<string | null>(null);
  keypairDid = $state<string | null>(null);
  sshReadyServices = $state<string[]>([]);

  #port: MessagePort | null = null;

  // OAuth-bound callbacks served on behalf of the worker (wired from the SPA).
  #createRecord: ((collection: string, record: Record<string, unknown>) => Promise<{ uri: string; cid: string }>) | null = null;
  #pdsFetch: ((req: Request) => Promise<Response>) | null = null;
  #getServiceAuth: ((lxm: string) => Promise<string>) | null = null;

  #ensurePort(): MessagePort {
    if (this.#port) return this.#port;
    const worker = new SharedWorker(new URL('./relay-worker.ts', import.meta.url), {
      type: 'module',
      name: 'fedproxy-relay',
    });
    const port = worker.port;
    port.onmessage = (e) => this.#onWorkerMessage(e.data);
    port.start();
    this.#port = port;
    // Let the worker re-elect a host promptly when this tab goes away.
    addEventListener('pagehide', () => { try { port.postMessage({ t: 'bye' }); } catch { /* */ } });
    return port;
  }

  #post(msg: unknown) {
    try { this.#ensurePort().postMessage(msg); } catch (err) { console.error('[relay] post failed', err); }
  }

  /** True once every OAuth-bound callback is wired (i.e. user is signed in). */
  #minterReady(): boolean {
    return !!(this.#createRecord && this.#pdsFetch && this.#getServiceAuth);
  }

  #announceMinter() {
    if (this.#minterReady()) this.#post({ t: 'minter', available: true });
  }

  async #onWorkerMessage(data: any) {
    switch (data?.t) {
      case 'state':
        this.status = data.status;
        this.subdomain = data.subdomain;
        this.proxyRef = data.proxyRef;
        this.keypairDid = data.keypairDid;
        this.sshReadyServices = data.sshReadyServices ?? [];
        break;
      case 'bid': {
        const queue = pendingBids.get(data.rfpUri) ?? [];
        queue.push(data.bid as CollectedBid);
        pendingBids.set(data.rfpUri, queue);
        break;
      }
      case 'oauth':
        await this.#serveOauth(data.id, data.kind, data.args);
        break;
    }
  }

  async #serveOauth(id: string, kind: string, args: any) {
    const reply = (ok: boolean, value?: unknown, err?: string, transfer?: Transferable[]) =>
      this.#ensurePort().postMessage({ t: 'oauthResult', id, ok, value, err }, transfer ?? []);
    try {
      if (kind === 'createRecord') {
        if (!this.#createRecord) throw new Error('createRecord not wired');
        reply(true, await this.#createRecord(args.collection, args.record));
      } else if (kind === 'getServiceAuth') {
        if (!this.#getServiceAuth) throw new Error('service auth minter not wired');
        reply(true, await this.#getServiceAuth(args.lxm));
      } else if (kind === 'pdsFetch') {
        if (!this.#pdsFetch) throw new Error('pdsFetch not wired');
        const req = new Request(args.url, {
          method: args.method,
          headers: args.headers,
          body: args.body ?? undefined,
        });
        const res = await this.#pdsFetch(req);
        const buf = await res.arrayBuffer();
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        reply(true, { status: res.status, statusText: res.statusText, headers, body: buf }, undefined, [buf]);
      } else {
        reply(false, undefined, `unknown oauth kind ${kind}`);
      }
    } catch (err) {
      reply(false, undefined, String(err));
    }
  }

  /**
   * Return this origin's relay private key hex, generating + persisting one on
   * first use. We keep the hex in localStorage (the worker can't read it) and
   * never call keypair.export() on an imported key — @atproto/crypto imports are
   * non-exportable, so export() throws.
   */
  async #relayPrivateKeyHex(): Promise<{ privateKeyHex: string; did: string }> {
    const stored = localStorage.getItem(KEYPAIR_STORAGE_KEY);
    if (stored) {
      try {
        const st = JSON.parse(stored);
        if (st.privateKeyHex && st.did) return { privateKeyHex: st.privateKeyHex, did: st.did };
      } catch { /* corrupt — regenerate */ }
    }
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const privateKeyHex = bytesToHex(await kp.export());
    const did = kp.did();
    localStorage.setItem(
      KEYPAIR_STORAGE_KEY,
      JSON.stringify({ privateKeyHex, did, createdAt: new Date().toISOString() }),
    );
    return { privateKeyHex, did };
  }

  // ── public API (unchanged surface) ─────────────────────────────────────────

  async start() {
    const { privateKeyHex, did } = await this.#relayPrivateKeyHex();
    this.keypairDid = did;
    this.#post({ t: 'init', privateKeyHex });
    this.#post({ t: 'start' });
    this.#announceMinter();
  }

  stop() {
    this.#post({ t: 'stop' });
  }

  isSshReady(serviceName: string): boolean {
    return this.sshReadyServices.includes(serviceName);
  }

  registerTtydRequest(req: TtydRequest) {
    this.#post({ t: 'registerTtyd', req });
  }

  setCreateRecord(fn: (collection: string, record: Record<string, unknown>) => Promise<{ uri: string; cid: string }>) {
    this.#createRecord = fn;
    this.#announceMinter();
  }

  setPdsFetch(fn: (req: Request) => Promise<Response>) {
    this.#pdsFetch = fn;
    this.#announceMinter();
  }

  setServiceAuthMinter(fn: (lxm: string) => Promise<string>) {
    this.#getServiceAuth = fn;
    this.#announceMinter();
  }

  /** k256 private key + did for local attestation signing (stays in the page). */
  getAttestationKeypair(): { did: () => string; privateKey: { type: 'k256'; bytes: Uint8Array } } | null {
    const stored = localStorage.getItem(KEYPAIR_STORAGE_KEY);
    if (!stored) return null;
    try {
      const st = JSON.parse(stored);
      const bytes = hexToBytes(st.privateKeyHex);
      const did = st.did as string;
      return { did: () => did, privateKey: { type: 'k256', bytes } };
    } catch { return null; }
  }
}

export const relayClient = new RelayClient();
