// local-pds.ts — mount the atproto repo PDS factory *in the browser* with a
// did:plc issuer.
//
// Flow on page load:
//   1. generate a secp256k1 keypair (rotation + signing key)
//   2. build + sign a did:plc genesis ("create") op and submit it to a PLC
//      directory (local ./did-plc-directory by default; configurable)
//   3. mount the repo PDS factory with a signer whose did() is the did:plc but
//      whose sign() uses the keypair
//   4. mint a service-auth token from the in-page PDS — iss is now the did:plc
//   5. verify the token by resolving the did:plc from the directory back to its
//      verificationMethod did:key
//
// Heavy console logging throughout so the flow is visible in devtools.

import { Secp256k1Keypair } from '@atproto/crypto';
import {
  createRepoFactory,
  createVerifier,
  MemoryStorage,
  type Signer,
} from '../../../lib/hono-factory-atproto-repo/mod.ts';
import {
  createGenesisOp,
  keysFromDidDocument,
  PlcClient,
} from '../../../lib/did-plc/mod.ts';

const TAG = '%c[local-pds]';
const STYLE = 'color:#7c3aed;font-weight:bold';
const log = (msg: string, ...rest: unknown[]) => console.log(`${TAG} ${msg}`, STYLE, ...rest);
const group = (msg: string) => console.group(`${TAG} ${msg}`, STYLE);

// PLC directory: local ./did-plc-directory by default. Point at the public
// directory (https://plc.directory) or any custom host via env.
const PLC_DIRECTORY_URL =
  import.meta.env.VITE_PLC_DIRECTORY_URL ?? 'https://plc.directory';

// Dispatcher host — override at build time with VITE_DISPATCHER_HOST.
const DISPATCHER_HOST =
  import.meta.env.VITE_DISPATCHER_HOST ?? 'xrpc.fedproxy.com';

export interface LocalPds {
  did: string;
  plcDirectoryUrl: string;
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
  getServiceAuth(aud: string, lxm?: string): Promise<string>;
}

const b64urlDecode = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const b64urlJson = (s: string): any =>
  JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

/** Build the in-browser PDS with a did:plc issuer and wire console logging. */
export async function startLocalPds(): Promise<LocalPds> {
  group('boot');
  log('PLC directory:', PLC_DIRECTORY_URL);
  const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });

  log('generating secp256k1 keypair (exportable)…');
  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const signingKeyDid = keypair.did();
  log('signing key did:key:', signingKeyDid);

  // ── did:plc genesis ("create") op ────────────────────────────────
  group('did:plc create op');
  log('building + signing genesis op (rotationKeys + atproto VM = signing key)…');
  const { did, op } = await createGenesisOp({
    rotationKeys: [signingKeyDid],
    verificationMethods: { atproto: signingKeyDid },
    services: {
      atproto_pds: {
        type: "AtprotoPersonalDataServer",
        endpoint: `https://${signingKeyDid.replace(/:/g, "-")}.${DISPATCHER_HOST}`,
      },
    },
    sign: (bytes) => keypair.sign(bytes),
  });
  log('derived did:plc:', did);
  log('genesis op:', op);
  log(`→ POST ${PLC_DIRECTORY_URL}/${did} (submit create op)…`);
  await plc.submitOp(did, op);
  log('✅ create op accepted by directory');
  // Read it back to confirm the directory resolves it.
  const doc = await plc.resolve(did);
  log('resolved DID document:', doc);
  console.groupEnd();

  // ── signer whose did() is the did:plc, signing with the keypair ──
  const signer: Signer = {
    did: () => did,
    sign: (bytes) => keypair.sign(bytes),
  };

  log('assembling repo factory (MemoryStorage + did:plc signer)…');
  const { app } = createRepoFactory({ storage: new MemoryStorage(), signer });
  log('factory ready — Hono PDS mounted in-page, issuer =', did);
  console.groupEnd();

  const ORIGIN = 'http://local-pds';
  const pdsFetch = (input: Request | string, init?: RequestInit): Promise<Response> => {
    const req = typeof input === 'string' ? new Request(ORIGIN + input, init) : input;
    return app.fetch(req);
  };

  const getServiceAuth = async (aud: string, lxm?: string): Promise<string> => {
    group(`getServiceAuth aud=${aud} lxm=${lxm ?? '(none)'}`);
    const qs = new URLSearchParams({ aud });
    if (lxm) qs.set('lxm', lxm);
    const url = `/xrpc/com.atproto.server.getServiceAuth?${qs}`;
    log('→ GET', url);
    const res = await pdsFetch(url);
    log('← status', res.status);
    const body = await res.json();
    if (!res.ok) {
      console.error(`${TAG} getServiceAuth failed:`, STYLE, body);
      console.groupEnd();
      throw new Error(`getServiceAuth ${res.status}: ${JSON.stringify(body)}`);
    }
    const token: string = body.token;
    log('token received:', token);

    const [hp, pp, sp] = token.split('.');
    log('decoded header:', b64urlJson(hp));
    const payload = b64urlJson(pp);
    log('decoded payload:', payload);
    log('issuer (iss) is did:plc:', payload.iss.startsWith('did:plc:'), payload.iss);

    // Verify: resolve the did:plc → its verificationMethod did:key → check sig.
    log('resolving issuer did:plc from directory to fetch signing key…');
    const issuerDoc = await plc.resolve(payload.iss);
    const keys = keysFromDidDocument(issuerDoc);
    log('issuer verificationMethod keys:', keys);

    const msgBytes = new TextEncoder().encode(`${hp}.${pp}`);
    const sigBytes = b64urlDecode(sp);
    const verifier = createVerifier();
    let valid = false;
    for (const key of keys) {
      if (await verifier.verify(key, msgBytes, sigBytes)) {
        valid = true;
        log('signature verified against', key);
        break;
      }
    }
    log(
      valid
        ? '✅ signature VALID (verified via did:plc → verificationMethod key)'
        : '❌ signature INVALID',
      valid,
    );

    console.groupEnd();
    return token;
  };

  return { did, plcDirectoryUrl: PLC_DIRECTORY_URL, fetch: pdsFetch, getServiceAuth };
}

/** Page-load entry: create the did:plc, boot the PDS, mint a service-auth token. */
export async function runOnLoad(): Promise<LocalPds> {
  group('page load');
  log('booting in-browser atproto PDS with did:plc issuer…');
  const pds = await startLocalPds();

  const health = await pds.fetch('/xrpc/_health');
  log('health:', health.status, await health.json());

  const desc = await (await pds.fetch('/xrpc/com.atproto.server.describeServer')).json();
  log('describeServer:', desc);

  await pds.getServiceAuth(pds.did, 'com.example.doThing');

  log('✅ page-load flow complete — issuer DID:', pds.did);
  console.groupEnd();
  return pds;
}
