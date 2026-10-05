import { assert, assertEquals, assertRejects } from "@std/assert";
import * as jose from "jose";
import {
  configureOidc,
  OIDCToken,
  UnauthorizedException,
} from "@publicdomainrelay/oidc-helper";
import { raiseIfUnauthorized } from "../mod.ts";

const SERVICE = "https://wid.example";
const SCOPE = "droplets.wid";
const PATH = "/v1/oidc/issue";
const METHOD = "POST";

const OWN_ISSUER = "https://own.example";
const WEB_ACTX = "attacker.localhost";
const PLC_KEY = "10bf95d8-1d56-44ff-9bd3-7133aeb6db1c";
const INTERNAL_LOOKING = "metadata-google-internal";
const CONTROL_KEY = "a65ba364-aa05-405a-8be8-9903020a48f9";
const CONTROL_DID = "did:plc:" + CONTROL_KEY;
const WEB_SUB = `actx:did:web:${WEB_ACTX}:role:attacker`;
const PLC_SUB = `actx:did:plc:${PLC_KEY}:role:attacker`;

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
  // not hold the test process open. A top-level `await server.shutdown()` would
  // run before the first test body and every fetch would fail.
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

function rbacRecord(sub: string, iss?: string) {
  return {
    protects: { wid: { service: SERVICE, scope: SCOPE } },
    policies: {
      wid: {
        meta: { policy: "wid" },
        schemas: {
          [PATH]: {
            properties: { capability: { enum: ["create"] }, body: {} },
          },
        },
      },
    },
    roles: {
      wid: {
        role_name: "wid",
        definition: {
          aud: `api://DigitalOcean?actx=${sub.slice("actx:".length)}`,
          ...(iss ? { iss } : {}),
          sub,
          policies: ["wid"],
        },
      },
    },
  };
}

const attackerKeyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const attackerPublicJwk = await jose.exportJWK(attackerKeyPair.publicKey);

const pdsPlc = await listen((url) => {
  const repo = url.searchParams.get("repo");
  if (repo === `did:plc:${PLC_KEY}`) {
    return json({ records: [{ uri: `at://${repo}/com.fedproxy.rbac/1`, value: plcRecord }] });
  }
  if (repo === CONTROL_DID) {
    return json({ records: [{ uri: `at://${repo}/com.fedproxy.rbac/1`, value: controlRecord }] });
  }
  return new Response("no such repo", { status: 404 });
});

const plc = await listen((url) => {
  const did = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (did === `did:plc:${PLC_KEY}` || did === CONTROL_DID) {
    return json({
      service: [{
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: pdsPlc.url,
      }],
    });
  }
  return new Response("not found", { status: 404 });
});

const pdsWeb = await listen((url) => {
  if (url.searchParams.get("repo") === `did:web:${WEB_ACTX}`) {
    return json({
      records: [{
        uri: `at://did:web:${WEB_ACTX}/com.fedproxy.rbac/1`,
        value: webRecord,
      }],
    });
  }
  return new Response("no such repo", { status: 404 });
});

const didDoc = await listen((url) =>
  url.pathname === "/.well-known/did.json"
    ? json({
      service: [{
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: pdsWeb.url,
      }],
    })
    : new Response("not found", { status: 404 })
);

const attackerIssuerServer = await listen((url) => {
  if (url.pathname === "/issuer/.well-known/openid-configuration") {
    return json({ jwks_uri: `${attackerIssuerServer.url}/jwks` });
  }
  if (url.pathname === "/jwks") return json({ keys: [attackerPublicJwk] });
  return new Response("not found", { status: 404 });
});
const ATTACKER_ISSUER = `${attackerIssuerServer.url}/issuer`;

const webRecord = rbacRecord(WEB_SUB, ATTACKER_ISSUER);
const plcRecord = rbacRecord(PLC_SUB, ATTACKER_ISSUER);
const controlRecord = rbacRecord(`actx:${CONTROL_DID}`);

const outbound: { url: string; host: string }[] = [];

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : input.url;
  const url = raw
    .replace(/^https:\/\/plc\.directory\//, `${plc.url}/`)
    .replace(/^https:\/\/attacker\.localhost\//, `${didDoc.url}/`);
  outbound.push({ url: raw, host: new URL(url).host });
  return realFetch(url, init);
}) as typeof fetch;

async function attackerToken(actx: string, iss: string, sub: string): Promise<string> {
  return await new jose.SignJWT({ sub })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(iss)
    .setAudience(`api://DigitalOcean?actx=${actx}`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(attackerKeyPair.privateKey);
}

function reached(): string {
  return `didDoc=${didDoc.received.length} pdsWeb=${pdsWeb.received.length} ` +
    `plc=${plc.received.length} pdsPlc=${pdsPlc.received.length}`;
}

function resetProbe(): void {
  outbound.length = 0;
  didDoc.received.length = 0;
  pdsWeb.received.length = 0;
  plc.received.length = 0;
  pdsPlc.received.length = 0;
}

function config(trusted: string[]): void {
  configureOidc({ getIssuerUrl: () => OWN_ISSUER, trustedIssuerUrls: trusted });
}

Deno.test("M1 did:web: an unverified aud naming a host must not be fetched", async () => {
  resetProbe();
  config([]);
  const token = await attackerToken(WEB_ACTX, ATTACKER_ISSUER, WEB_SUB);
  try {
    await raiseIfUnauthorized(SERVICE, SCOPE, token, PATH, METHOD);
    throw new Error("expected rejection");
  } catch (err) {
    assert(err instanceof UnauthorizedException, String(err));
    console.log(`M1 did:web\n    actx=${WEB_ACTX}\n    rejected: ${err.message}\n` +
      `    outbound=${JSON.stringify(outbound)}\n    servers reached: ${reached()}`);
  }
  assertEquals(didDoc.received.length + pdsWeb.received.length, 0);
});

Deno.test("M2 did:plc: every request goes to the pinned directory or the PDS it named", async () => {
  resetProbe();
  config([]);
  const token = await attackerToken(PLC_KEY, ATTACKER_ISSUER, PLC_SUB);
  try {
    await raiseIfUnauthorized(SERVICE, SCOPE, token, PATH, METHOD);
    throw new Error("expected rejection");
  } catch (err) {
    assert(err instanceof UnauthorizedException, String(err));
    console.log(`M2 did:plc\n    actx=${PLC_KEY}\n    rejected: ${err.message}\n` +
      `    outbound=${JSON.stringify(outbound)}\n    servers reached: ${reached()}`);
  }
  const pinned = new Set([new URL(plc.url).host, new URL(pdsPlc.url).host]);
  assert(
    outbound.every((o) => pinned.has(o.host)),
    `every request in a did:plc case must go to the pinned directory or the PDS it named; ` +
      `saw ${JSON.stringify(outbound)}`,
  );
  assertEquals(didDoc.received.length, 0);
  assertEquals(pdsWeb.received.length, 0);
});

Deno.test("M3 did:plc: an internal-looking name with no dot still goes to the pinned directory", async () => {
  resetProbe();
  config([]);
  const token = await attackerToken(INTERNAL_LOOKING, ATTACKER_ISSUER, PLC_SUB);
  try {
    await raiseIfUnauthorized(SERVICE, SCOPE, token, PATH, METHOD);
    throw new Error("expected rejection");
  } catch (err) {
    assert(err instanceof UnauthorizedException, String(err));
    console.log(`M3 did:plc (internal-looking)\n    actx=${INTERNAL_LOOKING}\n` +
      `    rejected: ${err.message}\n    outbound=${JSON.stringify(outbound)}\n` +
      `    servers reached: ${reached()}`);
  }
  const pinned = new Set([new URL(plc.url).host, new URL(pdsPlc.url).host]);
  assert(
    outbound.every((o) => pinned.has(o.host)),
    `M3 must reach only the pinned directory; saw ${JSON.stringify(outbound)}`,
  );
  assertEquals(didDoc.received.length, 0);
  assertEquals(pdsWeb.received.length, 0);
});

Deno.test("CONTROL: provider-minted token keeps BOTH fetches", async () => {
  resetProbe();
  config([]);
  const token = await OIDCToken.create(CONTROL_DID, { sub: `actx:${CONTROL_DID}` });
  const auth = await raiseIfUnauthorized(SERVICE, SCOPE, token.asString, PATH, METHOD);
  console.log(`CONTROL (provider-minted, did:plc under the pinned directory)\n` +
    `    actx=${CONTROL_DID}\n    admitted: sub=${auth.sub}\n` +
    `    outbound=${JSON.stringify(outbound)}\n    servers reached: ${reached()}`);
  assertEquals(auth.actx, CONTROL_DID);
  assertEquals(auth.sub, `actx:${CONTROL_DID}`);
  assertEquals(plc.received.length, 1);
  assertEquals(pdsPlc.received.length, 1);
});

Deno.test("ALLOWLIST: a configured issuer's token is still admitted", async () => {
  resetProbe();
  config([ATTACKER_ISSUER]);
  const token = await attackerToken(WEB_ACTX, ATTACKER_ISSUER, WEB_SUB);
  const auth = await raiseIfUnauthorized(SERVICE, SCOPE, token, PATH, METHOD);
  console.log(`ALLOWLIST (issuer named in configuration)\n    actx=${auth.actx}\n` +
    `    admitted: sub=${auth.sub}\n    outbound=${JSON.stringify(outbound)}\n` +
    `    servers reached: ${reached()}`);
  assertEquals(auth.actx, WEB_ACTX);
  assertEquals(auth.sub, WEB_SUB);
});
