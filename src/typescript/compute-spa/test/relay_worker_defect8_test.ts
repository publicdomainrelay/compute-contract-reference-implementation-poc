/**
 * Defect 8: the ttyd-credential gate trusted whatever issuer the token named.
 *
 * Drives the real dispatcher (`buildApp`) over its HTTP surface against a real
 * OIDC issuer the test stands up, so the forged and the legitimate tokens differ
 * only in who signed them.
 *
 * The gate is fail-closed, so the second half is the WIRING half: the page must
 * name the issuers it trusts. That set is per-VM, from the winning bid's
 * `issuer_uri`, and reaches the worker the production way -- a `{t:'trust'}`
 * port message carrying `trustedIssuers(savedVMs)`. The wired steps below build
 * that value from the same `SavedVM` list `requestVM` populates, so a lockout
 * (CONTROL_U 401) and an admission (CONTROL 200) are both visible in one run.
 *
 * Run from this directory: `deno test -A relay_worker_defect8_test.ts`
 * (the sibling deno.json pins the SPA's own dependency versions).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as jose from "jose";
import { buildApp, configureRelayTrust, state } from "../src/lib/relay-worker.ts";
import { trustedIssuers, type SavedVM } from "../src/lib/vm-storage.ts";

const VM_NAME = "wootty-vm1";
const DID_PLC = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const DID_PLC_KEY = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TTYD_CREDS_NSID = "com.fedproxy.ttydCredentials";
const SSH_KEY_NSID = "com.fedproxy.sshPublicKey";
const PASSWORD = "victim-wootty-auth-token";

interface Issuer {
  url: string;
  sign(claims: Record<string, unknown>): Promise<string>;
}

async function startIssuers(): Promise<{
  attacker: Issuer;
  provider: Issuer;
  close: () => Promise<void>;
}> {
  const keys = new Map<string, { jwk: jose.JWK; privateKey: CryptoKey }>();
  for (const name of ["attacker", "provider"]) {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await jose.exportJWK(pair.publicKey);
    jwk.alg = "RS256";
    jwk.use = "sig";
    jwk.kid = name;
    keys.set(name, { jwk, privateKey: pair.privateKey });
  }

  let base = "";
  const { promise: listening, resolve } = Promise.withResolvers<number>();
  const server = Deno.serve({
    port: 0,
    onListen: (addr) => resolve((addr as Deno.NetAddr).port),
  }, (req) => {
    const path = new URL(req.url).pathname;
    const name = path.split("/")[1];
    const key = keys.get(name);
    if (!key) return new Response("not found", { status: 404 });
    if (path.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer: `${base}/${name}`, jwks_uri: `${base}/${name}/jwks` });
    }
    if (path.endsWith("/jwks")) return Response.json({ keys: [key.jwk] });
    return new Response("not found", { status: 404 });
  });
  base = `http://127.0.0.1:${await listening}`;

  const issuer = (name: string): Issuer => ({
    url: `${base}/${name}`,
    sign: (claims) =>
      new jose.SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: name })
        .setIssuer(`${base}/${name}`)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.get(name)!.privateKey),
  });

  return {
    attacker: issuer("attacker"),
    provider: issuer("provider"),
    close: () => server.shutdown(),
  };
}

/** The guest's own claim shape: it asks for the ttyd password of one VM. */
function ttydClaims() {
  return {
    aud: `api://ATProto?actx=${DID_PLC}`,
    sub: `actx:team-uuid:plc:${DID_PLC_KEY}:role:get-ttyd-password-${VM_NAME}`,
    ttl: 300,
  };
}

/** The VM as the SPA persists it after `requestVM` resolves. */
function savedVm(issuerUri?: string): SavedVM {
  return {
    name: VM_NAME,
    vmUri: `at://${DID_PLC}/com.publicdomainrelay.temp.compute.vm/${VM_NAME}`,
    rfpUri: `at://${DID_PLC}/com.publicdomainrelay.temp.market.rfp/${VM_NAME}`,
    acceptUri: `at://${DID_PLC}/com.publicdomainrelay.temp.market.accept/${VM_NAME}`,
    bidUri: `at://${DID_PLC}/com.publicdomainrelay.temp.compute.bid/${VM_NAME}`,
    createdAt: new Date().toISOString(),
    serviceName: `wootty--${DID_PLC_KEY}`,
    ttydPassword: PASSWORD,
    issuerUri,
  };
}

/** Drive the worker's port protocol, so registration goes the production route. */
function connectPort(): (data: unknown) => void {
  const port = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage: () => {},
    start: () => {},
  };
  (self as unknown as { onconnect(e: { ports: unknown[] }): void }).onconnect({ ports: [port] });
  return (data) => port.onmessage?.({ data });
}

Deno.test("defect 8: the ttyd gate trusts only issuers configuration names", async (t) => {
  const issuers = await startIssuers();
  try {
    const post = connectPort();
    state.subdomain = `${VM_NAME}--${DID_PLC_KEY}`;
    post({
      t: "registerTtyd",
      req: {
        vmName: VM_NAME,
        serviceName: `wootty--${DID_PLC_KEY}`,
        didPlc: DID_PLC,
        didPlcKey: DID_PLC_KEY,
        password: PASSWORD,
      },
    });

    const app = buildApp();
    const readCreds = (token: string) =>
      app.fetch(new Request(
        `http://local/xrpc/com.atproto.repo.getRecord?collection=${TTYD_CREDS_NSID}&rkey=${VM_NAME}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ));
    const writeSshKey = (token: string) =>
      app.fetch(new Request("http://local/xrpc/com.atproto.repo.createRecord", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          collection: SSH_KEY_NSID,
          record: { service: `wootty--${DID_PLC_KEY}`, key: "ssh-ed25519 AAAA attacker-held-key" },
        }),
      }));

    const forged = await issuers.attacker.sign(ttydClaims());
    const legitimate = await issuers.provider.sign(ttydClaims());

    // A token whose signature verification fails against the pinned issuer: the
    // attacker's key, but claiming to have been minted by the trusted provider.
    const spoofed = await new jose.SignJWT(ttydClaims())
      .setProtectedHeader({ alg: "RS256", kid: "attacker" })
      .setIssuer(issuers.provider.url)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign((await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )).privateKey);

    const report = async (label: string, res: Response) => {
      const text = await res.text();
      console.log(`${label.padEnd(9)} ${res.status} ${text.slice(0, 160)}`);
      return { status: res.status, text };
    };

    await t.step("ATTACK_UNCONFIGURED", async () => {
      configureRelayTrust({ trustedIssuerUrls: [] });
      const { status, text } = await report("ATTACK-U", await readCreds(forged));
      assertEquals(status, 401);
      assert(!text.includes(PASSWORD), "unconfigured relay leaked the password");
    });

    await t.step("CONTROL_UNCONFIGURED", async () => {
      const { status } = await report("CONTROL-U", await readCreds(legitimate));
      assertEquals(status, 401, "an unconfigured relay must trust no one, not even the provider");
    });

    await t.step("PAGE_WIRES", async () => {
      // What the page sends: `relayClient.setTrustedIssuers(trustedIssuers(savedVMs))`
      // with this VM's winning-bid issuer on it. Configuration owns the set -- it
      // is never read off the token under test.
      const vms = [savedVm(issuers.provider.url)];
      const wired = trustedIssuers(vms);
      assertEquals(
        wired,
        [issuers.provider.url],
        "the page must derive exactly the VM's own issuer, from the winner's config",
      );
      assert(!wired.includes(issuers.attacker.url), "the page named the attacker as trusted");
      post({ t: "trust", trustedIssuerUrls: wired });
    });

    await t.step("ATTACK", async () => {
      const { status, text } = await report("ATTACK", await readCreds(forged));
      assertEquals(status, 401);
      assert(!text.includes(PASSWORD), "the gate still served the victim's password");
    });

    await t.step("SPOOF", async () => {
      const { status, text } = await report("SPOOF", await readCreds(spoofed));
      assertEquals(status, 401);
      assert(!text.includes(PASSWORD), "a pinned-issuer NAME with the wrong key was admitted");
    });

    await t.step("CONTROL", async () => {
      const { status, text } = await report("CONTROL", await readCreds(legitimate));
      assertEquals(status, 200);
      assertStringIncludes(text, PASSWORD);
    });

    await t.step("CONTROL_WRITE", async () => {
      const { status, text } = await report("CONTROL-W", await writeSshKey(legitimate));
      // No host tab is attached in this test, so the write reaches oauthCreateRecord
      // and fails there. Reaching it at all is the assertion.
      assertEquals(status, 500);
      assertStringIncludes(text, "no host tab available");
    });

    await t.step("ATTACK_WRITE", async () => {
      const { status, text } = await report("ATTACK-W", await writeSshKey(forged));
      assertEquals(status, 401, "a forged match still reached oauthCreateRecord");
      assertStringIncludes(text, "Unauthorized");
    });
  } finally {
    await issuers.close();
  }
});
