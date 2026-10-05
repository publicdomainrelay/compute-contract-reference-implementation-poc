import { assertEquals, assertRejects } from "@std/assert";
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
const OWN_DID = "did:plc:ownownerownownerownowner";
const OWN_PDS = "https://own-pds.example";

const ATTACKER_ISSUER = "https://attacker.example";
const ATTACKER_DID = "did:plc:attackerattackerattacker";
const ATTACKER_PDS = "https://attacker-pds.example";
const ATTACKER_SUB = `actx:${ATTACKER_DID}:role:attacker`;

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

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
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

let attackerJwksUri = "";

async function startAttackerJwksServer(): Promise<() => Promise<void>> {
  const port = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      port: 0,
      hostname: "127.0.0.1",
      onListen: (addr) => port.resolve(addr.port),
    },
    (req) =>
      new URL(req.url).pathname === "/jwks"
        ? json({ keys: [attackerPublicJwk] })
        : new Response("not found", { status: 404 }),
  );
  attackerJwksUri = `http://127.0.0.1:${await port.promise}/jwks`;
  return async () => {
    await server.shutdown();
  };
}

const attackerRecord = rbacRecord(ATTACKER_SUB, ATTACKER_ISSUER);
const ownRecord = rbacRecord(`actx:${OWN_DID}`);

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : input.url;

  if (url.startsWith("https://plc.directory/")) {
    const did = url.slice("https://plc.directory/".length);
    return json({
      service: [{
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: did === ATTACKER_DID ? ATTACKER_PDS : OWN_PDS,
      }],
    });
  }
  if (url.startsWith(`${ATTACKER_PDS}/xrpc/com.atproto.repo.listRecords`)) {
    return json({
      records: [{
        uri: `at://${ATTACKER_DID}/com.fedproxy.rbac/1`,
        value: attackerRecord,
      }],
    });
  }
  if (url.startsWith(`${OWN_PDS}/xrpc/com.atproto.repo.listRecords`)) {
    return json({
      records: [{
        uri: `at://${OWN_DID}/com.fedproxy.rbac/1`,
        value: ownRecord,
      }],
    });
  }
  if (url === `${ATTACKER_ISSUER}/.well-known/openid-configuration`) {
    return json({ jwks_uri: attackerJwksUri });
  }
  return realFetch(input as never, init);
}) as typeof fetch;

async function attackerToken(): Promise<string> {
  return await new jose.SignJWT({ sub: ATTACKER_SUB })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(ATTACKER_ISSUER)
    .setAudience(`api://DigitalOcean?actx=${ATTACKER_DID}`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(attackerKeyPair.privateKey);
}

function resetTrust(): void {
  configureOidc({ getIssuerUrl: () => OWN_ISSUER, trustedIssuerUrls: [] });
}

Deno.test("ATTACK: self-signed token naming a caller-controlled actx + PDS + issuer is rejected", async () => {
  resetTrust();
  const stop = await startAttackerJwksServer();
  try {
    const token = await attackerToken();
    await assertRejects(
      () => raiseIfUnauthorized(SERVICE, SCOPE, token, PATH, METHOD),
      UnauthorizedException,
      "OIDC token failed validation",
    );
  } finally {
    await stop();
  }
});

Deno.test("CONTROL: provider-minted token against the provider's own RBAC record is admitted", async () => {
  resetTrust();
  const token = await OIDCToken.create(OWN_DID, { sub: `actx:${OWN_DID}` });
  const auth = await raiseIfUnauthorized(
    SERVICE,
    SCOPE,
    token.asString,
    PATH,
    METHOD,
  );
  assertEquals(auth.actx, OWN_DID);
  assertEquals(auth.sub, `actx:${OWN_DID}`);
});

Deno.test("ALLOWLIST: the same self-signed token is admitted once its issuer is named in configuration", async () => {
  configureOidc({
    getIssuerUrl: () => OWN_ISSUER,
    trustedIssuerUrls: [ATTACKER_ISSUER],
  });
  const stop = await startAttackerJwksServer();
  try {
    const token = await attackerToken();
    const auth = await raiseIfUnauthorized(SERVICE, SCOPE, token, PATH, METHOD);
    assertEquals(auth.actx, ATTACKER_DID);
    assertEquals(auth.sub, ATTACKER_SUB);
  } finally {
    await stop();
  }
});
