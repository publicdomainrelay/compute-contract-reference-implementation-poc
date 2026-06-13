// @publicdomainrelay/hono-factory-atproto-repo — Factory assembly
//
// createRepoFactory({ storage, signer, did?, sequencer? })
//   → { app: Hono, subscribe: SubscribeHandler, api: RepoApi }
//
// Wires storage + crypto + repo + handlers + firehose into a single
// factory object. Plug the result into the existing relay seams:
//
//   - app → createSubscriberFactory({ app: repo.app })
//   - subscribe → runSubscriber({ subscribe: repo.subscribe })

import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import type { Storage, Signer, Did, Sequencer, RepoApi } from "../contracts.ts";
import { XrpcError } from "../contracts.ts";
import { Repo, type RepoStorage } from "../repo/repo.ts";
import { mountRepoRoutes } from "../handlers/repo.ts";
import { mountSyncRoutes } from "../handlers/sync.ts";
import { FirehoseSequencer } from "../firehose/sequencer.ts";
import { createSubscribeHandler } from "../firehose/subscribe.ts";
import { signServiceAuth } from "../crypto/service-auth.ts";
import type { SubscribeHandler } from "@publicdomainrelay/xrpc-relay";

// ── types ─────────────────────────────────────────────────────────

export interface RepoFactoryOptions {
  /** Combined block + repo-head storage. */
  storage: Storage;
  /** Signer for commit signing. */
  signer: Signer;
  /** DID for the repo owner (defaults to signer.did()). */
  did?: Did;
  /** Optional custom sequencer. If omitted, FirehoseSequencer is used. */
  sequencer?: Sequencer;
  /** Base origin for the Hono app (default: https://pds.local). */
  baseOrigin?: string;
  /**
   * Service entries to publish in this repo's did:web document
   * (`GET /.well-known/did.json`). The `serviceEndpoint` is derived per-request
   * from the Host header, so one factory serves the did:web doc for whatever
   * subdomain it is proxied behind (e.g. `<sub>.xrpc.fedproxy.com`).
   *
   * Without this, the did:web identity carries no `did.json` and
   * service-proxying callers (e.g. market `submitBid`, which resolves the RFP's
   * `submitBid` did:web ref to find the POST endpoint) cannot resolve the
   * service and the call silently never lands. Omitted/empty → no route mounted.
   */
  didWebServices?: Array<{ id: string; type: string }>;
}

export interface RepoFactory {
  /** Hono app with all XRPC routes mounted. */
  app: Hono;
  /** SubscribeHandler compatible with createSubscriber({ subscribe }). */
  subscribe: SubscribeHandler;
  /** Direct programmatic access to the RepoApi. */
  api: RepoApi;
  /** The sequencer instance. */
  sequencer: Sequencer;
}

// ── factory ───────────────────────────────────────────────────────

export function createRepoFactory(opts: RepoFactoryOptions): RepoFactory {
  const storage = opts.storage as RepoStorage;
  const signer = opts.signer;
  const did = opts.did ?? signer.did();
  const sequencer = opts.sequencer ?? new FirehoseSequencer();

  // ── core repo ──────────────────────────────────────────────────
  const repo = new Repo(storage, signer, did);

  // ── Hono app ───────────────────────────────────────────────────
  const app = new Hono();

  // CORS
  app.use("*", cors());

  // Set requester DID from configured DID (single-tenant: all requests from this repo owner)
  // biome-ignore lint: Hono typed context — use variable key
  app.use("*", async (c, next) => {
    c.set("requesterDid" as never, did as never);
    await next();
  });

  // ── error middleware ───────────────────────────────────────────
  app.onError((err, _c) => {
    if (err instanceof XrpcError) {
      return new Response(JSON.stringify({ error: err.error, message: err.message }), {
        status: err.status,
        headers: { "content-type": "application/json" },
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: "InternalError", message: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });

  // ── health ─────────────────────────────────────────────────────
  app.get("/xrpc/_health", (c) => {
    return c.json({ status: "ok" });
  });

  // ── describeServer ─────────────────────────────────────────────
  app.get("/xrpc/com.atproto.server.describeServer", (c) => {
    return c.json({
      did,
      version: "0.0.0",
      availableUserDomains: [],
      inviteCodeRequired: false,
    });
  });

  // ── well-known ─────────────────────────────────────────────────
  app.get("/.well-known/atproto-did", (c) => {
    return c.text(did);
  });

  // did:web document — published only when service entries are configured.
  // serviceEndpoint is derived from the Host header so the same factory serves
  // the did:web doc for whatever subdomain it is proxied behind.
  const didWebServices = opts.didWebServices ?? [];
  if (didWebServices.length > 0) {
    app.get("/.well-known/did.json", (c) => {
      const host = (c.req.header("host") ?? "").split(":")[0];
      if (!host) {
        throw new XrpcError("InvalidRequest", "missing Host header");
      }
      return c.json({
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: `did:web:${host}`,
        service: didWebServices.map((s) => ({
          id: s.id.startsWith("#") ? s.id : `#${s.id}`,
          type: s.type,
          serviceEndpoint: `https://${host}`,
        })),
      });
    });
  }

  // ── getServiceAuth ─────────────────────────────────────────────
  // Mint an inter-service auth JWT signed by this repo's signing key.
  app.get("/xrpc/com.atproto.server.getServiceAuth", async (c) => {
    const aud = c.req.query("aud");
    if (!aud) {
      throw new XrpcError("InvalidRequest", 'missing required "aud" param');
    }
    const lxm = c.req.query("lxm") ?? undefined;
    const expQ = c.req.query("exp");
    const token = await signServiceAuth(signer, {
      aud,
      lxm,
      expiresInSec: expQ ? Math.max(0, parseInt(expQ) - Math.floor(Date.now() / 1000)) : undefined,
    });
    return c.json({ token });
  });

  // ── wrap repo API to pipe writes into the sequencer ────────────
  const wiredRepo: RepoApi = {
    describe: (d) => repo.describe(d),
    getRecord: (d, c, r) => repo.getRecord(d, c, r),
    listRecords: (d, c, o) => repo.listRecords(d, c, o),
    async applyWrites(d, writes) {
      const evt = await repo.applyWrites(d, writes);
      sequencer.append(evt);
      return evt;
    },
  };

  // ── repo routes ────────────────────────────────────────────────
  mountRepoRoutes(app, wiredRepo);

  // ── sync routes ────────────────────────────────────────────────
  mountSyncRoutes(app, { repo: wiredRepo, storage });

  // ── subscribe handler ──────────────────────────────────────────
  const subscribe = createSubscribeHandler(sequencer);

  return {
    app,
    subscribe,
    api: wiredRepo,
    sequencer,
  };
}
