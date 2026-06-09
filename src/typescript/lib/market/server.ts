// Server-side handler factories for the market.* submit procedures.
//
// Each factory returns a framework-agnostic handler — `(req: Request) =>
// Promise<Response>` using only web-standard types — so it runs unchanged on
// Deno.serve, Node (node:http via a tiny adapter), Hono, or anything else. The
// factory owns the boilerplate every receiver shares (parse the JSON body,
// verify the inter-service auth JWT, require the token issuer to be the author
// of the referenced record, resolve the strongRef'd record), and hands control
// to a caller-supplied callback for the domain logic.
//
// submitEvent additionally dispatches by `serviceId -> payload NSID`, so a
// single endpoint can route, say, a compute.events.vm.delete payload to one
// handler and other event types to others, the way the reference bidder does.

import {
  EVENT_NSID,
  SUBMIT_ACCEPT_LXM,
  SUBMIT_BID_LXM,
  SUBMIT_EVENT_LXM,
  SUBMIT_RFP_LXM,
} from "../lexicons/mod.ts";
import { verifyMarketServiceAuth } from "./auth.ts";
import { atUriAuthority, nsidFromUri, type RecordResolver } from "./resolve.ts";
import { noopLogger } from "./types.ts";
import type { IdResolver } from "@atproto/identity";
import type { Accept, Bid, Logger, MarketEvent, Resolved, RFP } from "./types.ts";

/** Shared dependencies every market server handler needs. */
export interface MarketServerDeps {
  /**
   * This service's public hostname (host of its did:web), used to build the
   * acceptable `aud` values for inbound service-auth tokens. Pass a string when
   * the service answers for a single did:web (the reference bidder). Pass a
   * function when the host varies per request — e.g. a multi-tenant spindle that
   * derives `did:web:<owner-subdomain>` from the inbound `Host` header.
   */
  hostname: string | ((req: Request) => string);
  /** Identity resolver used to look up issuer signing keys for JWT verification. */
  idResolver: IdResolver;
  /** Strong-ref resolver used to fetch referenced records. */
  resolve: RecordResolver;
  /** Optional structured logger. Defaults to a no-op. */
  log?: Logger;
}

/**
 * What a callback may return to shape the HTTP response. Returning nothing (or
 * neither field) yields `200 { ok: true }`. Throwing propagates to the host
 * framework's error handler unchanged.
 */
export type HandlerResult = { status?: number; body?: unknown } | void;

type Handler = (req: Request) => Promise<Response>;

// ---------------------------------------------------------------------------
// response + parsing helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function xrpcError(error: string, message: string, status: number): Response {
  return json({ error, message }, status);
}

async function readJson<T>(req: Request): Promise<T | undefined> {
  try {
    return (await req.json()) as T;
  } catch {
    return undefined;
  }
}

function finish(result: HandlerResult): Response {
  if (result && (result.body !== undefined || result.status !== undefined)) {
    return json(result.body ?? { ok: true }, result.status ?? 200);
  }
  return json({ ok: true });
}

/**
 * Verify the service-auth token and require its issuer to author `recordUri`.
 * Returns the auth result, or a ready-to-send error Response on failure.
 */
async function authorize(
  req: Request,
  deps: MarketServerDeps,
  lxm: string,
  serviceIds: string[],
  recordUri: string,
  log: Logger,
  label: string,
): Promise<{ issuerDid: string; serviceId?: string } | Response> {
  let auth;
  try {
    auth = await verifyMarketServiceAuth({
      authHeader: req.headers.get("authorization"),
      hostname: typeof deps.hostname === "function" ? deps.hostname(req) : deps.hostname,
      lxm,
      serviceIds,
      idResolver: deps.idResolver,
    });
  } catch (err) {
    log("warn", `${label} rejected: invalid service-auth token`, { err: String(err) });
    return xrpcError("Unauthorized", `invalid service-auth token: ${String(err)}`, 401);
  }
  if (auth.issuerDid !== atUriAuthority(recordUri)) {
    log("warn", `${label} rejected: token issuer does not match record author`, { iss: auth.issuerDid, uri: recordUri });
    return xrpcError("Forbidden", "service-auth token issuer must author the referenced record", 403);
  }
  return { issuerDid: auth.issuerDid, serviceId: auth.serviceId };
}

// ---------------------------------------------------------------------------
// submitRfp
// ---------------------------------------------------------------------------

export interface SubmitRfpContext {
  rfpUri: string;
  rfpCid: string;
  rfp: Resolved<RFP & { $type?: string }>;
  /** NSID of the RFP's payload record (its collection). */
  payloadNsid: string;
  issuerDid: string;
  resolve: RecordResolver;
  log: Logger;
  /** The original inbound request, for callbacks that need its url/headers. */
  req: Request;
}

export type SubmitRfpCallback = (ctx: SubmitRfpContext) => Promise<HandlerResult> | HandlerResult;

/** callbacks[serviceId][payloadNsid] -> handler for that RFP type. */
export type RfpCallbacks = Record<string, Record<string, SubmitRfpCallback>>;

export interface SubmitRfpHandlerConfig {
  deps: MarketServerDeps;
  /** Routing table: outer key = service id, inner key = payload NSID. */
  callbacks: RfpCallbacks;
}

/**
 * Handler for com.publicdomainrelay.temp.market.submitRfp. Resolves the RFP and
 * routes it to `callbacks[serviceId][payloadNsid]`. Unknown pairs are ignored
 * with `200 { ok: true }`.
 */
export function createSubmitRfpHandler(cfg: SubmitRfpHandlerConfig): Handler {
  const { deps, callbacks } = cfg;
  const log = deps.log ?? noopLogger;
  const serviceIds = Object.keys(callbacks);

  return async (req) => {
    const body = await readJson<{ rfpUri?: string; rfpCid?: string }>(req);
    if (!body) return xrpcError("InvalidRequest", "invalid JSON", 400);
    const { rfpUri, rfpCid } = body;
    if (!rfpUri || !rfpCid) return xrpcError("InvalidRequest", "missing rfpUri or rfpCid", 400);

    const auth = await authorize(req, deps, SUBMIT_RFP_LXM, serviceIds, rfpUri, log, "submitRfp");
    if (auth instanceof Response) return auth;

    log("info", "submitRfp received", { rfpUri, rfpCid });

    const rfp = await deps.resolve.resolve<RFP & { $type?: string }>({ uri: rfpUri, cid: rfpCid });
    const payloadNsid = rfp.payload ? nsidFromUri(rfp.payload.uri) : "";

    const bucketId = auth.serviceId ?? (serviceIds.length === 1 ? serviceIds[0] : undefined);
    const cb = bucketId ? callbacks[bucketId]?.[payloadNsid] : undefined;
    if (!cb) {
      log("info", "submitRfp: ignoring unknown rfp", { serviceId: bucketId, payloadNsid });
      return json({ ok: true });
    }

    return finish(await cb({
      rfpUri,
      rfpCid,
      rfp,
      payloadNsid,
      issuerDid: auth.issuerDid,
      resolve: deps.resolve,
      log,
      req,
    }));
  };
}

// ---------------------------------------------------------------------------
// submitBid
// ---------------------------------------------------------------------------

export interface SubmitBidContext {
  uri: string;
  cid: string;
  /** The bid record as sent inline in the request body. */
  record: Bid & { $type?: string };
  issuerDid: string;
  resolve: RecordResolver;
  log: Logger;
  /** The original inbound request, for callbacks that need its url/headers. */
  req: Request;
}

export type SubmitBidCallback = (ctx: SubmitBidContext) => Promise<HandlerResult> | HandlerResult;

export interface SubmitBidHandlerConfig {
  deps: MarketServerDeps;
  serviceIds: string[];
  onBid: SubmitBidCallback;
}

/**
 * Handler for com.publicdomainrelay.temp.market.submitBid. The bid record is
 * sent inline; `onBid` typically records or queues it.
 */
export function createSubmitBidHandler(cfg: SubmitBidHandlerConfig): Handler {
  const { deps, serviceIds, onBid } = cfg;
  const log = deps.log ?? noopLogger;
  return async (req) => {
    const body = await readJson<{ uri?: string; cid?: string; record?: Bid & { $type?: string } }>(req);
    if (!body) return xrpcError("InvalidRequest", "invalid JSON", 400);
    const { uri, cid, record } = body;
    if (!uri || !cid || !record) return xrpcError("InvalidRequest", "missing uri, cid, or record", 400);

    const auth = await authorize(req, deps, SUBMIT_BID_LXM, serviceIds, uri, log, "submitBid");
    if (auth instanceof Response) return auth;

    log("info", "submitBid received", { uri, cid });

    return finish(await onBid({
      uri,
      cid,
      record,
      issuerDid: auth.issuerDid,
      resolve: deps.resolve,
      log,
      req,
    }));
  };
}

// ---------------------------------------------------------------------------
// submitAccept
// ---------------------------------------------------------------------------

export interface SubmitAcceptContext {
  acceptUri: string;
  acceptCid: string;
  accept: Resolved<Accept & { $type?: string }>;
  issuerDid: string;
  resolve: RecordResolver;
  log: Logger;
  /** The original inbound request, for callbacks that need its url/headers. */
  req: Request;
}

export type SubmitAcceptCallback = (ctx: SubmitAcceptContext) => Promise<HandlerResult> | HandlerResult;

export interface SubmitAcceptHandlerConfig {
  deps: MarketServerDeps;
  serviceIds: string[];
  onAccept: SubmitAcceptCallback;
}

/**
 * Handler for com.publicdomainrelay.temp.market.submitAccept. Resolves the
 * accept record and invokes `onAccept`, which settles the contract and returns
 * `{ body: { id, uri, cid, submitEvent } }`.
 */
export function createSubmitAcceptHandler(cfg: SubmitAcceptHandlerConfig): Handler {
  const { deps, serviceIds, onAccept } = cfg;
  const log = deps.log ?? noopLogger;
  return async (req) => {
    const body = await readJson<{ acceptUri?: string; acceptCid?: string }>(req);
    if (!body) return xrpcError("InvalidRequest", "invalid JSON", 400);
    const { acceptUri, acceptCid } = body;
    if (!acceptUri || !acceptCid) return xrpcError("InvalidRequest", "missing acceptUri or acceptCid", 400);

    const auth = await authorize(req, deps, SUBMIT_ACCEPT_LXM, serviceIds, acceptUri, log, "submitAccept");
    if (auth instanceof Response) return auth;

    log("info", "submitAccept received", { acceptUri, acceptCid });

    const accept = await deps.resolve.resolve<Accept & { $type?: string }>({ uri: acceptUri, cid: acceptCid });

    return finish(await onAccept({
      acceptUri,
      acceptCid,
      accept,
      issuerDid: auth.issuerDid,
      resolve: deps.resolve,
      log,
      req,
    }));
  };
}

// ---------------------------------------------------------------------------
// submitEvent — dispatches by serviceId -> payload NSID
// ---------------------------------------------------------------------------

export interface EventDispatchContext {
  uri: string;
  cid: string;
  event: Resolved<MarketEvent & { $type?: string }>;
  /** NSID of the event's payload record (its collection). */
  payloadNsid: string;
  issuerDid: string;
  /** Which configured service-id the token's `aud` matched (if any). */
  serviceId?: string;
  resolve: RecordResolver;
  log: Logger;
  /** The original inbound request, for callbacks that need its url/headers. */
  req: Request;
}

export type EventCallback = (ctx: EventDispatchContext) => Promise<HandlerResult> | HandlerResult;

/** callbacks[serviceId][payloadNsid] -> handler for that event type. */
export type EventCallbacks = Record<string, Record<string, EventCallback>>;

export interface SubmitEventHandlerConfig {
  deps: MarketServerDeps;
  /** Routing table: outer key = service id, inner key = payload NSID. */
  callbacks: EventCallbacks;
  /**
   * When true, dispatch the matched callback without awaiting it and respond
   * `200 { ok: true }` immediately, logging on dispatch and on completion.
   * Useful when the callback does slow provider work (e.g. tearing down a VM).
   */
  background?: boolean;
}

/**
 * Handler for com.publicdomainrelay.temp.market.submitEvent. Verifies auth,
 * resolves the event record, then routes it to
 * `callbacks[serviceId][payloadNsid]`. Unknown (serviceId, payloadNsid) pairs
 * are ignored with `200 { ok: true }`, matching the reference bidder.
 */
export function createSubmitEventHandler(cfg: SubmitEventHandlerConfig): Handler {
  const { deps, callbacks } = cfg;
  const log = deps.log ?? noopLogger;
  const serviceIds = Object.keys(callbacks);

  return async (req) => {
    const body = await readJson<{ uri?: string; cid?: string; record?: { receipt?: unknown; payload?: unknown } }>(req);
    if (!body) return xrpcError("InvalidRequest", "invalid JSON", 400);
    const { uri, cid, record } = body;
    if (!uri || !cid || !record?.receipt || !record?.payload) {
      return xrpcError("InvalidRequest", "missing uri, cid, or record", 400);
    }

    const auth = await authorize(req, deps, SUBMIT_EVENT_LXM, serviceIds, uri, log, "submitEvent");
    if (auth instanceof Response) return auth;

    log("info", "submitEvent received", { uri, cid, receipt: record.receipt, payload: record.payload });

    const event = await deps.resolve.resolve<MarketEvent & { $type?: string }>({ uri, cid });
    if (event.$type && event.$type !== EVENT_NSID) {
      return xrpcError("InvalidRequest", `expected ${EVENT_NSID}`, 400);
    }
    const payloadNsid = nsidFromUri(event.payload.uri);

    // Pick the callbacks bucket: prefer the service id the token's aud matched;
    // fall back to the sole configured bucket when the token used the bare DID.
    const bucketId = auth.serviceId ?? (serviceIds.length === 1 ? serviceIds[0] : undefined);
    const cb = bucketId ? callbacks[bucketId]?.[payloadNsid] : undefined;
    if (!cb) {
      log("info", "submitEvent: ignoring unknown event", { serviceId: bucketId, payloadNsid });
      return json({ ok: true });
    }

    const ctx: EventDispatchContext = {
      uri,
      cid,
      event,
      payloadNsid,
      issuerDid: auth.issuerDid,
      serviceId: bucketId,
      resolve: deps.resolve,
      log,
      req,
    };

    if (cfg.background) {
      log("info", "submitEvent: dispatching in background", { serviceId: bucketId, payloadNsid, uri });
      void (async () => {
        try {
          await cb(ctx);
          log("info", "submitEvent: background dispatch complete", { serviceId: bucketId, payloadNsid, uri });
        } catch (err) {
          log("error", "submitEvent: background dispatch failed", { serviceId: bucketId, payloadNsid, uri, err: String(err) });
        }
      })();
      return json({ ok: true });
    }

    return finish(await cb(ctx));
  };
}
