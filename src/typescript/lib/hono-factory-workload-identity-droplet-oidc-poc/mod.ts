// @publicdomainrelay/hono-factory-workload-identity-droplet-oidc-poc
//
// Workload-identity OIDC issuer for droplets/VMs: a Hono app serving OIDC
// discovery + token issue/prove, plus an optional XRPC relay that registers a
// did:web identity with fedproxy and dispatches proxied requests into the app.
//
// Extracted from the inline blob in compute-provider-local/mod.ts setup() (which
// was itself copied from qemu/main.ts + hono-factory-compute-provider-local).
//
// Routes:
//   GET  /.well-known/openid-configuration
//   GET  /.well-known/jwks
//   POST /v1/oidc/issue   (RBAC middleware via rbac-helper, scope droplets.wid)
//   POST /v1/oidc/prove   (SSH challenge → scoped token)
//
// Usage:
//   const poc = createWorkloadIdentityDropletOidcPoc({
//     getIssuerUrl, onIssuerUrl, log, getDroplet,
//   });
//   Deno.serve({ port }, poc.app.fetch);
//   const controller = poc.startRelay();   // optional
//   ...
//   poc.stopRelay();

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  getPublicJwk,
  OIDCToken,
  UnauthorizedException,
  subMatchesActx,
} from "@publicdomainrelay/oidc-helper";
import { raiseIfUnauthorized } from "@publicdomainrelay/rbac-helper";
import type { AuthToken } from "@publicdomainrelay/rbac-helper";
import { validate as provisioningValidate } from "./provisioning.ts";
import { Secp256k1Keypair } from "@atproto/crypto";
import { signServiceAuth } from "@publicdomainrelay/hono-factory-atproto-repo";
import type { Signer } from "@publicdomainrelay/hono-factory-atproto-repo";
import { runSubscriber } from "@publicdomainrelay/xrpc-relay";
import { createSubscriberFactory } from "@publicdomainrelay/hono-factory-xrpc-subscriber";

export type Logger = (
  level: "info" | "warn" | "error" | "debug",
  msg: string,
  extra?: Record<string, unknown>,
) => void;

export interface WorkloadIdentityDropletOidcPocOptions {
  /** Resolve the issuer URL at call time (relay may set it after registration). */
  getIssuerUrl: () => string;
  /** Look up a droplet record by id (for the /v1/oidc/prove SSH challenge). */
  getDroplet: (id: string) => Record<string, unknown> | undefined;
  /** Structured logger. */
  log: Logger;
  /**
   * Called once the relay registers and the external issuer URL is known, so the
   * host can update whatever variable backs getIssuerUrl. Optional.
   */
  onIssuerUrl?: (baseUrl: string) => void | Promise<void>;
  /** fedproxy dispatcher host for the XRPC relay. Default xrpc.fedproxy.com. */
  dispatcherHost?: string;
  /** Hex-encoded secp256k1 private key for the relay identity. Random if absent. */
  relayKeypairHex?: string;
  /** When set, the relay's did:web proxyRef is written here once registered. */
  xrpcRelayIssuerPath?: string;
}

export interface WorkloadIdentityDropletOidcPoc {
  app: Hono<{ Variables: { authToken: AuthToken } }>;
  /** Connect to the fedproxy relay; returns the controller (also stored). */
  startRelay(): ReturnType<typeof runSubscriber>;
  /** Stop the relay if running. */
  stopRelay(): void;
}

function extractBearer(authHeader: string | undefined): string {
  if (!authHeader) throw new UnauthorizedException("Missing Authorization header");
  const parts = authHeader.split(" ");
  const token = parts[parts.length - 1];
  if (!token || token === "0") throw new UnauthorizedException("Missing bearer token");
  return token;
}

export function createWorkloadIdentityDropletOidcPoc(
  opts: WorkloadIdentityDropletOidcPocOptions,
): WorkloadIdentityDropletOidcPoc {
  const { getIssuerUrl, getDroplet, log } = opts;
  const dispatcherHost = opts.dispatcherHost ?? Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";

  const app = new Hono<{ Variables: { authToken: AuthToken } }>();

  app.use("*", cors());

  app.use("*", async (c, next) => {
    log("info", "request", { method: c.req.method, path: c.req.path });
    await next();
  });

  // GET /.well-known/openid-configuration
  app.get("/.well-known/openid-configuration", async (c) => {
    await getPublicJwk();
    const issuerUrl = getIssuerUrl();
    return c.json({
      issuer: issuerUrl,
      jwks_uri: `${issuerUrl}/.well-known/jwks`,
      response_types_supported: ["id_token"],
      claims_supported: ["sub", "aud", "exp", "iat", "iss", "actx"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid"],
    });
  });

  // GET /.well-known/jwks
  app.get("/.well-known/jwks", async (c) => {
    const jwk = await getPublicJwk();
    return c.json({ keys: [jwk] });
  });

  // RBAC middleware for /v1/oidc/issue (scope droplets.wid)
  app.use("/v1/oidc/issue", async (c, next) => {
    try {
      const token = extractBearer(c.req.header("Authorization"));
      const authToken = await raiseIfUnauthorized(getIssuerUrl(), "droplets.wid", token, "/v1/oidc/issue", c.req.method);
      c.set("authToken", authToken);
      await next();
    } catch (err) {
      log("warn", "rbac denied /v1/oidc/issue", { error: String(err) });
      return c.json({ id: "unauthorized", message: String(err) }, 401);
    }
  });

  // POST /v1/oidc/issue — issue an OIDC token for authorized callers
  app.post("/v1/oidc/issue", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const authToken = c.get("authToken") as AuthToken;
      const actx = authToken.actx;

      const sub = (body["sub"] as string | undefined) ?? actx;
      if (!subMatchesActx(sub, actx)) {
        return c.json({ id: "unauthorized", message: `sub must be scoped to actx:${actx}` }, 401);
      }

      const token = await OIDCToken.create(actx, { ...body, sub });
      return c.json({ token: token.asString });
    } catch (err) {
      log("error", "oidc issue failed", { error: String(err) });
      return c.json({ id: "server_error", message: String(err) }, 500);
    }
  });

  // POST /v1/oidc/prove — validate droplet SSH challenge + issue scoped token
  app.post("/v1/oidc/prove", async (c) => {
    log("debug", "/v1/oidc/prove request received");
    try {
      const body = await c.req.json<{ sig: string; port: number }>();
      log("debug", "/v1/oidc/prove body parsed", { port: body.port, sigLen: body.sig?.length });
      const token = extractBearer(c.req.header("Authorization"));
      log("debug", "/v1/oidc/prove bearer extracted", { tokenPresent: !!token, tokenLen: token?.length });

      const provToken = await OIDCToken.validate(token);
      const actx = provToken.actx;
      log("debug", "/v1/oidc/prove token validated", { actx, provTokenSub: provToken.sub });

      const result = await provisioningValidate(token, body.sig, body.port, (id) => {
        const droplet = getDroplet(id);
        log("debug", "/v1/oidc/prove droplet lookup", { id, found: !!droplet });
        return droplet;
      });
      log("debug", "/v1/oidc/prove provisioningValidate result", { valid: !!result });
      if (!result) return c.json({ valid: false });

      const { oidcToken, droplet } = result;
      const dropletTags = ((droplet["tags"] as string[]) ?? []);
      log("debug", "/v1/oidc/prove droplet info", { dropletId: droplet["id"], tags: dropletTags });
      const subject = [
        `actx:${oidcToken.actx}`,
        ...dropletTags
          .filter((t) => t.startsWith("oidc-sub:") && t.split(":").length === 3 && t.split(":")[1] !== "actx")
          .map((t) => t.split(":")[1] + ":" + t.split(":")[2]),
      ].join(":");
      log("debug", "/v1/oidc/prove computed subject", { subject });

      const issued = await OIDCToken.create(oidcToken.actx, {
        sub: subject,
        droplet_id: droplet["id"],
      });
      log("debug", "/v1/oidc/prove token issued", { sub: subject, dropletId: droplet["id"] });
      return c.json({ token: issued.asString });
    } catch (err) {
      log("error", "oidc prove failed", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
      return c.json({ id: "unauthorized", message: String(err) }, 401);
    }
  });

  // ── XRPC relay ─────────────────────────────────────────────────────
  // Connects to the fedproxy relay, registers a did:web identity, and (when
  // xrpcRelayIssuerPath is set) writes the proxyRef once live. Requests proxied
  // through the relay arrive as #request frames and dispatch into `app`.
  let relayController: ReturnType<typeof runSubscriber> | undefined;

  function startRelay(): ReturnType<typeof runSubscriber> {
    if (relayController) return relayController;

    const keypairPromise = opts.relayKeypairHex
      ? Secp256k1Keypair.import(opts.relayKeypairHex)
      : Secp256k1Keypair.create({ exportable: true });

    // runSubscriber needs the keypair synchronously; the qemu original awaited
    // it before calling. We await inside an async IIFE and assign once ready.
    // To keep a synchronous return, build the controller lazily.
    let inner: ReturnType<typeof runSubscriber> | undefined;
    const controller = {
      stop() { inner?.stop(); },
    } as ReturnType<typeof runSubscriber>;

    (async () => {
      const relayKeypair = await keypairPromise;
      const relaySigner: Signer = {
        did: () => relayKeypair.did(),
        sign: (bytes) => relayKeypair.sign(bytes),
      };

      const { handleRequest } = createSubscriberFactory({ app });

      const dispatcherDid = `did:web:${dispatcherHost}`;
      const getServiceAuthToken = async (lxm: string): Promise<string> =>
        await signServiceAuth(relaySigner, { aud: dispatcherDid, lxm });

      inner = runSubscriber({
        label: "workload-identity-droplet-oidc",
        keypair: relayKeypair,
        getServiceAuthToken,
        dispatcherHost,
        handleRequest,
        subscribe: undefined,
        onLog: (e) => log("info", `xrpc-relay: ${e.message}`, { severity: e.severity }),
        onRegistered: async (info) => {
          log("info", "xrpc-relay registered", { subdomain: info.subdomain, proxyRef: info.proxyRef });
          const proxyHost = info.proxyRef.replace(/^did:web:/, "");
          const baseUrl = `https://${proxyHost}`;
          Deno.env.set("ISSUER_URL", baseUrl);
          Deno.env.set("THIS_ENDPOINT", baseUrl);
          await opts.onIssuerUrl?.(baseUrl);
          log("info", "xrpc-relay issuer url updated", { baseUrl });
          if (opts.xrpcRelayIssuerPath) {
            try {
              await Deno.writeTextFile(opts.xrpcRelayIssuerPath, `${info.proxyRef}\n`);
              log("info", "xrpc-relay issuer written", { path: opts.xrpcRelayIssuerPath, proxyRef: info.proxyRef });
            } catch (err) {
              log("error", "xrpc-relay failed to write issuer", { path: opts.xrpcRelayIssuerPath, error: String(err) });
            }
          }
        },
        onSubscriptionOpen: (sub) => log("info", "xrpc-relay subscription open", { subscriptionId: sub.subscriptionId, nsid: sub.nsid }),
        onStatus: (status) => log("info", "xrpc-relay status", { status }),
      });
      relayController = inner;
      log("info", "xrpc-relay connecting", { dispatcherHost });
    })();

    relayController = controller;
    return controller;
  }

  function stopRelay(): void {
    try { relayController?.stop(); } catch { /* ignore */ }
    relayController = undefined;
  }

  return { app, startRelay, stopRelay };
}
