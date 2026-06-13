// Handler factories for the registry XRPC procedures (registerBidder,
// listBidders). Follows the same pattern as server.ts: framework-agnostic
// `(req: Request) => Promise<Response>` handlers using only web-standard
// types, with the same MarketServerDeps, HandlerResult, and helper functions.
//
// Unlike the market submit handlers (server.ts), registry handlers:
//   - Do NOT resolve strongRefs (registrations are managed server-side)
//   - Do NOT verify inline badge.blue signatures
//   - Check `issuerDid === body.bidderDid` (caller IS the bidder)
//
// Liveness is determined by the registry polling each bidder's own
// bidderDiscovery record — there is no separate heartbeat XRPC.

import { REGISTER_BIDDER_NSID, LIST_BIDDERS_NSID } from "@publicdomainrelay/lexicons";
import { verifyMarketServiceAuth } from "./auth.ts";
import { noopLogger } from "./types.ts";
import type { Logger } from "./types.ts";
import type { MarketServerDeps, HandlerResult } from "./server.ts";

// ---------------------------------------------------------------------------
// response + parsing helpers (copied from server.ts)
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

// ---------------------------------------------------------------------------
// createRegisterBidderHandler
// ---------------------------------------------------------------------------

export interface RegisterBidderContext {
  bidderDid: string;
  appliesTo: string[];
  issuerDid: string;
  log: Logger;
}

export type RegisterBidderCallback = (ctx: RegisterBidderContext) => Promise<HandlerResult> | HandlerResult;

export interface RegisterBidderHandlerConfig {
  deps: MarketServerDeps;
  onRegister: RegisterBidderCallback;
}

/**
 * Handler for com.publicdomainrelay.temp.market.registerBidder. Verifies
 * service-auth JWT, checks the token issuer matches bidderDid, then calls
 * `onRegister(ctx)` for the domain logic (e.g. create an index entry).
 */
export function createRegisterBidderHandler(
  cfg: RegisterBidderHandlerConfig,
): (req: Request) => Promise<Response> {
  const { deps, onRegister } = cfg;
  const log = deps.log ?? noopLogger;

  return async (req) => {
    const body = await readJson<{
      bidderDid?: string;
      appliesTo?: string[];
    }>(req);
    if (!body) return xrpcError("InvalidRequest", "invalid JSON", 400);
    const { bidderDid, appliesTo } = body;
    if (!bidderDid || !appliesTo) {
      return xrpcError(
        "InvalidRequest",
        "missing required fields: bidderDid, appliesTo",
        400,
      );
    }

    let auth;
    try {
      auth = await verifyMarketServiceAuth({
        authHeader: req.headers.get("authorization"),
        hostname:
          typeof deps.hostname === "function" ? deps.hostname(req) : deps.hostname,
        lxm: REGISTER_BIDDER_NSID,
        serviceIds: ["pdr_temp_market"],
        idResolver: deps.idResolver,
      });
    } catch (err) {
      log("warn", "registerBidder rejected: invalid service-auth token", { err: String(err) });
      return xrpcError("Unauthorized", `invalid service-auth token: ${String(err)}`, 401);
    }

    if (auth.issuerDid !== bidderDid) {
      log("warn", "registerBidder rejected: token issuer does not match bidderDid", {
        iss: auth.issuerDid,
        bidderDid,
      });
      return xrpcError("Forbidden", "service-auth token issuer must match bidderDid", 403);
    }

    log("info", "registerBidder received", { bidderDid, appliesTo });

    return finish(
      await onRegister({
        bidderDid,
        appliesTo,
        issuerDid: auth.issuerDid,
        log,
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// createListBiddersHandler
// ---------------------------------------------------------------------------

export interface ListBiddersContext {
  payloadNsid?: string;
  maxResults?: number;
  cursor?: string;
  log: Logger;
}

export type ListBiddersCallback = (ctx: ListBiddersContext) => Promise<HandlerResult> | HandlerResult;

export interface ListBiddersHandlerConfig {
  deps: MarketServerDeps;
  onList: ListBiddersCallback;
}

/**
 * Handler for com.publicdomainrelay.temp.market.listBidders. A GET query
 * handler that verifies service-auth JWT (any issuer OK) then calls
 * `onList(ctx)` to return paginated bidder entries.
 */
export function createListBiddersHandler(
  cfg: ListBiddersHandlerConfig,
): (req: Request) => Promise<Response> {
  const { deps, onList } = cfg;
  const log = deps.log ?? noopLogger;

  return async (req) => {
    const url = new URL(req.url);
    const payloadNsid = url.searchParams.get("payloadNsid") ?? undefined;
    const maxResultsStr = url.searchParams.get("maxResults") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const maxResults = maxResultsStr ? parseInt(maxResultsStr, 10) : undefined;

    let auth;
    try {
      auth = await verifyMarketServiceAuth({
        authHeader: req.headers.get("authorization"),
        hostname:
          typeof deps.hostname === "function" ? deps.hostname(req) : deps.hostname,
        lxm: LIST_BIDDERS_NSID,
        serviceIds: ["pdr_temp_market"],
        idResolver: deps.idResolver,
      });
    } catch (err) {
      log("warn", "listBidders rejected: invalid service-auth token", { err: String(err) });
      return xrpcError("Unauthorized", `invalid service-auth token: ${String(err)}`, 401);
    }

    log("info", "listBidders received", { payloadNsid, maxResults, cursor });

    return finish(
      await onList({
        payloadNsid,
        maxResults,
        cursor,
        log,
      }),
    );
  };
}
