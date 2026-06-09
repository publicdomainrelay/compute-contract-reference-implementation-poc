// @publicdomainrelay/hono-factory-market — Hono factory for the
// com.publicdomainrelay.temp.market.* XRPC procedures.
//
// createMarketFactory() returns a typed Hono factory with an optional initApp
// that auto-mounts whichever of the four procedures (submitRfp, submitBid,
// submitAccept, submitEvent) you supply handlers for.
//
// Usage:
//   const factory = createMarketFactory(deps, { rfp: { ... }, event: { ... } })
//   const app = factory.createApp()
//   // app has /xrpc/…submitRfp and /xrpc/…submitEvent already mounted

import { createFactory } from "hono/factory";
import type {
  EventCallbacks,
  HandlerResult,
  MarketServerDeps,
  RfpCallbacks,
  SubmitAcceptCallback,
  SubmitBidCallback,
} from "@publicdomainrelay/market";
import {
  createSubmitAcceptHandler,
  createSubmitBidHandler,
  createSubmitEventHandler,
  createSubmitRfpHandler,
  SUBMIT_ACCEPT_NSID,
  SUBMIT_BID_NSID,
  SUBMIT_EVENT_NSID,
  SUBMIT_RFP_NSID,
} from "@publicdomainrelay/market";

export type { EventCallbacks, HandlerResult, MarketServerDeps, RfpCallbacks, SubmitAcceptCallback, SubmitBidCallback };

export type MarketEnv = {
  Variables: {
    marketDeps: MarketServerDeps;
  };
};

export interface MarketFactoryHandlers {
  rfp?: RfpCallbacks;
  bid?: { serviceIds: string[]; onBid: SubmitBidCallback };
  accept?: { serviceIds: string[]; onAccept: SubmitAcceptCallback };
  event?: { callbacks: EventCallbacks; background?: boolean };
}

/**
 * Create a typed Hono factory for the market XRPC procedures.
 *
 * `deps` are injected into every request via `c.var.marketDeps`. If `handlers`
 * are provided, the corresponding XRPC routes are mounted automatically in
 * `initApp`; omit a handler to mount it manually on the returned factory's app.
 */
export function createMarketFactory(
  deps: MarketServerDeps,
  handlers?: MarketFactoryHandlers,
) {
  return createFactory<MarketEnv>({
    initApp: (app) => {
      app.use(async (c, next) => {
        c.set("marketDeps", deps);
        await next();
      });

      if (handlers?.rfp) {
        const h = createSubmitRfpHandler({ deps, callbacks: handlers.rfp });
        app.post(`/xrpc/${SUBMIT_RFP_NSID}`, (c) => h(c.req.raw));
      }
      if (handlers?.bid) {
        const h = createSubmitBidHandler({ deps, ...handlers.bid });
        app.post(`/xrpc/${SUBMIT_BID_NSID}`, (c) => h(c.req.raw));
      }
      if (handlers?.accept) {
        const h = createSubmitAcceptHandler({ deps, ...handlers.accept });
        app.post(`/xrpc/${SUBMIT_ACCEPT_NSID}`, (c) => h(c.req.raw));
      }
      if (handlers?.event) {
        const h = createSubmitEventHandler({ deps, ...handlers.event });
        app.post(`/xrpc/${SUBMIT_EVENT_NSID}`, (c) => h(c.req.raw));
      }
    },
  });
}
