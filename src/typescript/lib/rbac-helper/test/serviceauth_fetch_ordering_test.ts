import { assert, assertEquals } from "@std/assert";
// Inline npm specifier: @atproto/crypto is a test-only need, and adding it to
// lib/rbac-helper/deno.json would ship a runtime dependency this lib never uses.
import {
  bytesToMultibase,
  Secp256k1Keypair,
} from "npm:@atproto/crypto@^0.5.0";
import { UnauthorizedException } from "@publicdomainrelay/oidc-helper";
import { raiseIfUnauthorizedServiceAuth } from "../mod.ts";

const SERVICE = "https://wid.example";
const SCOPE = "account.auth";
const PATH = "/v2/account";
const METHOD = "GET";
const AUD = "did:web:wid.example";
const OPERATOR_HANDLE = "did:plc:operator-0000-0000-0000-000000000001";
const RBAC_COLLECTION = "com.fedproxy.rbac";
const ALLOWLIST_COLLECTION =
  "com.publicdomainrelay.temp.auth.allowlist.rbacDid";

interface Mock {
  port: number;
  url: string;
  received: string[];
}

async function listen(
  handler: (url: URL) => Response | Promise<Response>,
): Promise<Mock> {
  const port = Promise.withResolvers<number>();
  const received: string[] = [];
  const server = Deno.serve(
    {
      port: 0,
      hostname: "127.0.0.1",
      onListen: (addr) => port.resolve(addr.port),
    },
    (req) => {
      const url = new URL(req.url);
      received.push(`${req.method} ${url.pathname}${url.search}`);
      return handler(url);
    },
  );
  // unref, not shutdown: these listeners must outlive module evaluation and must
  // not hold the test process open.
  server.unref();
  const bound = await port.promise;
  return { port: bound, url: `http://127.0.0.1:${bound}`, received };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Mocks. Every request that lands on one is counted server-side, so the
// "servers reached" numbers do not rest on the fetch patch below.
// ---------------------------------------------------------------------------

const records = new Map<string, unknown>();
function putRecord(repo: string, collection: string, value: unknown): void {
  records.set(`${collection}|${repo}`, value);
}

const probes: { name: string; mock: Mock }[] = [];
function track(name: string, mock: Mock): Mock {
  probes.push({ name, mock });
  return mock;
}

async function makePds(name: string): Promise<Mock> {
  return track(
    name,
    await listen((url) => {
      const repo = url.searchParams.get("repo") ?? "";
      const collection = url.searchParams.get("collection") ?? "";
      const value = records.get(`${collection}|${repo}`);
      if (!value) return new Response("no such repo", { status: 404 });
      return json({
        records: [{ uri: `at://${repo}/${collection}/1`, value }],
      });
    }),
  );
}

// The pinned directory. Every did:plc resolution in this file goes through it.
const plcDocs = new Map<string, unknown>();
const plc = track(
  "plc",
  await listen((url) => {
    const did = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const doc = plcDocs.get(did);
    return doc ? json(doc) : new Response("not found", { status: 404 });
  }),
);

const docServers = new Map<string, Mock>();

// EcdsaSecp256k1VerificationKey2019 carries the bare compressed key, not the
// multicodec-prefixed did:key multibase — so decode through bytesToMultibase,
// not through key.did().slice(8).
function verificationMethod(did: string, key: Secp256k1Keypair) {
  return {
    id: "#atproto",
    type: "EcdsaSecp256k1VerificationKey2019",
    controller: did,
    publicKeyMultibase: bytesToMultibase(key.publicKeyBytes(), "base58btc"),
  };
}

interface WebIdentity {
  host: string;
  did: string;
  key: Secp256k1Keypair;
  pds: Mock;
  doc: Mock;
}

// A did:web identity whose DID document is served by its own host, naming the
// PDS it points at. `endpoint` exists so a case can choose hop 3's scheme.
async function webIdentity(
  host: string,
  endpoint?: (pds: Mock) => string,
): Promise<WebIdentity> {
  const did = `did:web:${host}`;
  const key = await Secp256k1Keypair.create();
  const pds = await makePds(`${host}.pds`);
  const doc = await listen((url) =>
    url.pathname === "/.well-known/did.json"
      ? json({
        id: did,
        verificationMethod: [verificationMethod(did, key)],
        service: [{
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: endpoint ? endpoint(pds) : pds.url,
        }],
      })
      : new Response("not found", { status: 404 })
  );
  docServers.set(host, doc);
  track(`${host}.doc`, doc);
  return { host, did, key, pds, doc };
}

const outbound: string[] = [];
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : input.url;
  let target = raw;
  if (raw.startsWith("https://plc.directory/")) {
    target = `${plc.url}/${raw.slice("https://plc.directory/".length)}`;
  } else {
    const m = raw.match(/^https:\/\/([a-z0-9.\-]+)\/\.well-known\/did\.json$/);
    if (m && docServers.has(m[1])) {
      target = `${docServers.get(m[1])!.url}/.well-known/did.json`;
    }
  }
  outbound.push(raw);
  return realFetch(target, init);
}) as typeof fetch;

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// com.atproto.server.getServiceAuth-shaped JWT, built by hand rather than with
// jose so the alg is unambiguously ES256K.
async function serviceAuthToken(
  key: Secp256k1Keypair,
  iss: string,
  sub: string,
  aud = AUD,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256K", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss,
    aud,
    sub,
    iat: now,
    exp: now + 3600,
  }));
  const sig = b64url(
    await key.sign(new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${sig}`;
}

function rbacRecord(sub: string) {
  return {
    protects: { account: { service: SERVICE, scope: SCOPE } },
    policies: {
      account: {
        meta: { policy: "account" },
        schemas: {
          [PATH]: { properties: { capability: { enum: ["read"] }, body: {} } },
        },
      },
    },
    roles: {
      account: {
        role_name: "account",
        definition: { sub, policies: ["account"] },
      },
    },
  };
}

// The operator writes this on its OWN PDS. It is the only thing that decides
// which caller DIDs may reach the fetch under measurement.
function allowOnly(allowedDids: string[]): void {
  putRecord(OPERATOR_HANDLE, ALLOWLIST_COLLECTION, {
    protects: { account: { service: SERVICE, scope: SCOPE } },
    allowed: { partners: allowedDids },
  });
}

function reached(): string {
  return probes.map((p) => `${p.name}=${p.mock.received.length}`).join(" ");
}

function resetProbe(): void {
  outbound.length = 0;
  for (const p of probes) p.mock.received.length = 0;
}

function report(label: string, detail: string): void {
  console.log(
    `${label}\n    ${detail}\n    outbound=${JSON.stringify(outbound)}\n` +
      `    servers reached: ${reached()}`,
  );
}

async function expectRejected(
  token: string,
): Promise<UnauthorizedException> {
  try {
    await raiseIfUnauthorizedServiceAuth(
      SERVICE,
      SCOPE,
      OPERATOR_HANDLE,
      token,
      PATH,
      METHOD,
    );
  } catch (err) {
    assert(err instanceof UnauthorizedException, String(err));
    return err;
  }
  throw new Error("expected rejection");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The operator's own PDS, named by the pinned directory. Nothing about it is
// caller-supplied: it is reached through operatorHandle.
const operatorPds = await makePds("operator.pds");
plcDocs.set(OPERATOR_HANDLE, {
  id: OPERATOR_HANDLE,
  service: [{
    id: "#atproto_pds",
    type: "AtprotoPersonalDataServer",
    serviceEndpoint: operatorPds.url,
  }],
});

// S1/S2: a validly-signed did:web caller the operator has NOT allowed.
const stranger = await webIdentity("stranger.localhost");
// S3: a validly-signed did:web caller the operator HAS allowed.
const partner = await webIdentity("partner.localhost");
// S4: a did:plc caller, so the other method can be measured for symmetry.
const PLC_KEY = "10bf95d8-1d56-44ff-9bd3-7133aeb6db1c";
const PLC_DID = `did:plc:${PLC_KEY}`;
const plcPds = await makePds("plc.pds");
const plcDocKey = await Secp256k1Keypair.create();
plcDocs.set(PLC_DID, {
  id: PLC_DID,
  verificationMethod: [verificationMethod(PLC_DID, plcDocKey)],
  service: [{
    id: "#atproto_pds",
    type: "AtprotoPersonalDataServer",
    serviceEndpoint: plcPds.url,
  }],
});
// S5: whose scheme is hop 3? The caller's document picks it.
const schemePds = await makePds("scheme.pds");
const permitted = await webIdentity("permitted.localhost", () => schemePds.url);

for (const id of [stranger, partner, permitted]) {
  putRecord(id.did, RBAC_COLLECTION, rbacRecord(id.did));
}
putRecord(PLC_DID, RBAC_COLLECTION, rbacRecord(PLC_DID));

// ---------------------------------------------------------------------------
// S1: forged signature. Nothing past the trust-anchor fetch may happen.
// ---------------------------------------------------------------------------

Deno.test("S1 forged signature: nothing past the trust anchor is fetched", async () => {
  allowOnly([]);
  resetProbe();
  const forger = await Secp256k1Keypair.create();
  const token = await serviceAuthToken(forger, stranger.did, stranger.did);
  const err = await expectRejected(token);
  report(
    `S1 forged signature (iss=${stranger.did})`,
    `rejected: ${err.message}`,
  );
  assertEquals(stranger.pds.received.length, 0);
  assertEquals(operatorPds.received.length, 0);
  assert(
    outbound.every((u) =>
      u === `https://${stranger.host}/.well-known/did.json`
    ),
    `only the trust anchor may be fetched; saw ${JSON.stringify(outbound)}`,
  );
});

// ---------------------------------------------------------------------------
// S2: valid signature, caller is NOT on the operator's allowlist. This is the
// ordering measurement: does resolvePDS(iss) at mod.ts:521 fire?
// ---------------------------------------------------------------------------

Deno.test("S2 valid signature, not allowlisted: resolvePDS(iss) never fires", async () => {
  allowOnly([]);
  resetProbe();
  const token = await serviceAuthToken(stranger.key, stranger.did, stranger.did);
  const err = await expectRejected(token);
  report(
    `S2 valid signature, not allowlisted (iss=${stranger.did})`,
    `rejected: ${err.message}`,
  );
  assert(
    err.message.includes("not on the operator's service allowlist"),
    `S2 must be denied by the allowlist gate, not by signature: ${err.message}`,
  );
  assertEquals(stranger.doc.received.length, 1);
  assertEquals(stranger.pds.received.length, 0);
  assertEquals(operatorPds.received.length, 1);
  assertEquals(schemePds.received.length, 0);
});

// ---------------------------------------------------------------------------
// S3: the positive control. Valid signature, caller IS allowlisted.
// ---------------------------------------------------------------------------

Deno.test("S3 allowlisted caller: resolvePDS(iss) and getRBACRecord still fire", async () => {
  allowOnly([partner.did]);
  resetProbe();
  const token = await serviceAuthToken(partner.key, partner.did, partner.did);
  const auth = await raiseIfUnauthorizedServiceAuth(
    SERVICE,
    SCOPE,
    OPERATOR_HANDLE,
    token,
    PATH,
    METHOD,
  );
  report(
    `S3 allowlisted caller (iss=${partner.did})`,
    `admitted: sub=${auth.sub}`,
  );
  assertEquals(auth.sub, partner.did);
  assertEquals(operatorPds.received.length, 1);
  assertEquals(partner.pds.received.length, 1);
  assert(
    outbound.includes(`https://${partner.host}/.well-known/did.json`),
    "hop 1 of resolvePDS must still be fetched for a legitimate caller",
  );
});

// ---------------------------------------------------------------------------
// S4: did:plc. Every request goes to the pinned directory or the PDS it named.
// ---------------------------------------------------------------------------

Deno.test("S4 did:plc: every request goes to the pinned directory or its PDS", async () => {
  allowOnly([]);
  resetProbe();
  const signer = await Secp256k1Keypair.create();
  const token = await serviceAuthToken(signer, PLC_DID, PLC_DID);
  const err = await expectRejected(token);
  report(`S4 did:plc (iss=${PLC_DID})`, `rejected: ${err.message}`);
  // `outbound` holds the URL the provider constructed, so the pinned directory
  // appears as plc.directory under whichever host plays it in this run.
  const pinned = new Set(["plc.directory", new URL(plcPds.url).host]);
  assert(
    outbound.every((u) => pinned.has(new URL(u).host)),
    "a did:plc case may only reach the pinned directory or its PDS; saw " +
      JSON.stringify(outbound),
  );
  assert(plc.received.length >= 1, "the pinned directory must be the first hop");
  assertEquals(stranger.doc.received.length, 0);
  assertEquals(operatorPds.received.length, 0);
});

// ---------------------------------------------------------------------------
// S6: the trust-anchor fetch, with no credential at all, over plain http. The
// did:web resolver forces https EXCEPT for hostname localhost, which is the one
// place a caller picks the scheme as well as the host and port.
// ---------------------------------------------------------------------------

Deno.test("S6 unauthenticated: did:web:localhost%3A<port> is fetched over plain http", async () => {
  allowOnly([]);
  const local = track(
    "localhost.mock",
    await listen(() => new Response("not a did document", { status: 404 })),
  );
  resetProbe();
  const iss = `did:web:localhost%3A${local.port}`;
  const forger = await Secp256k1Keypair.create();
  const token = await serviceAuthToken(forger, iss, iss);
  const err = await expectRejected(token);
  report(`S6 unauthenticated (iss=${iss})`, `rejected: ${err.message}`);
  assertEquals(local.received.length, 1);
  assert(
    local.received[0].startsWith("GET /.well-known/did.json"),
    `expected the trust-anchor path; saw ${local.received[0]}`,
  );
  assert(
    outbound.includes(`http://localhost:${local.port}/.well-known/did.json`),
    `the scheme must be the resolver's http-for-localhost; saw ${
      JSON.stringify(outbound)
    }`,
  );
});

// ---------------------------------------------------------------------------
// S5: whose scheme is hop 3? The document's, for whoever the operator allowed.
// ---------------------------------------------------------------------------

Deno.test("S5 allowlisted caller: hop 3 follows the endpoint in the caller's document", async () => {
  allowOnly([permitted.did]);
  resetProbe();
  const token = await serviceAuthToken(
    permitted.key,
    permitted.did,
    permitted.did,
  );
  const auth = await raiseIfUnauthorizedServiceAuth(
    SERVICE,
    SCOPE,
    OPERATOR_HANDLE,
    token,
    PATH,
    METHOD,
  );
  report(
    `S5 allowlisted caller, document-named endpoint (iss=${permitted.did})`,
    `admitted: sub=${auth.sub}`,
  );
  assertEquals(auth.sub, permitted.did);
  assertEquals(permitted.pds.received.length, 0);
  assertEquals(schemePds.received.length, 1);
  assert(
    outbound.some((u) => u.startsWith(`${schemePds.url}/xrpc/`)),
    `hop 3 must be the caller's document's endpoint; saw ${
      JSON.stringify(outbound)
    }`,
  );
  assert(
    schemePds.received[0].startsWith("GET /xrpc/com.atproto.repo.listRecords"),
    `hop 3 must land on the document-named host; saw ${schemePds.received[0]}`,
  );
});
