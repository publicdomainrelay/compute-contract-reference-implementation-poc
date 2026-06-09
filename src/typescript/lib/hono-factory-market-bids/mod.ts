// @publicdomainrelay/hono-factory-market-bids — Hono factory for the
// market bids receipt endpoints (free grant and x402 payment).
//
// "market-bids" is the former "settlement" layer: this factory mounts the
// receipt GET endpoints that a buyer calls to obtain the accept payload
// (proof-of-grant for free bids, proof-of-payment for x402 bids).
//
// Usage:
//   const factory = createMarketBidsFactory({
//     free: { getAgent, resolve, log },
//     x402: { getAgent, resolve, log, paymentMiddleware },
//   })
//   const app = factory.createApp()
//   // GET /free/receipt/* and GET /x402/receipt/* are mounted

import { createFactory } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { Agent } from "@atproto/api";
import type { Logger, RecordResolver } from "@publicdomainrelay/market";
import {
  mintGrantForAccepts,
  parseGrantPath,
} from "@publicdomainrelay/market-free";
import {
  mintReceiptForAccepts,
  parseReceiptPath,
} from "@publicdomainrelay/market-x402";

export type MarketBidsEnv = {
  Variables: {
    agent: Agent;
    resolve: RecordResolver;
  };
};

export interface FreeGrantConfig {
  getAgent: () => Agent;
  resolve: RecordResolver;
  log?: Logger;
  /** Route prefix for the grant endpoint. Default: `"free/receipt"`. */
  path?: string;
}

export interface X402ReceiptConfig {
  getAgent: () => Agent;
  resolve: RecordResolver;
  log?: Logger;
  /** Route prefix for the receipt endpoint. Default: `"x402/receipt"`. */
  path?: string;
  /**
   * Optional Hono middleware applied before the receipt handler — use this to
   * wire your x402 payment gate (e.g. `paymentMiddleware(...)` from @x402/hono).
   * The middleware runs only on `GET /<path>/*`.
   */
  paymentMiddleware?: MiddlewareHandler;
}

export interface MarketBidsFactoryOptions {
  free?: FreeGrantConfig;
  x402?: X402ReceiptConfig;
}

const noopLog: Logger = () => {};

/**
 * Create a typed Hono factory for the market-bids receipt endpoints.
 *
 * Supply `free` to mount the free grant endpoint, `x402` to mount the x402
 * payment receipt endpoint, or both. The caller is responsible for wiring
 * any payment middleware into `x402.paymentMiddleware`.
 */
export function createMarketBidsFactory(opts: MarketBidsFactoryOptions) {
  return createFactory<MarketBidsEnv>({
    initApp: (app) => {
      if (opts.free) {
        const { getAgent, resolve, log = noopLog, path = "free/receipt" } = opts.free;
        app.get(`/${path}/*`, async (c) => {
          const { acceptsUri, acceptsCid } = parseGrantPath(c.req.path, `${path}/`);
          log("info", "free grant receipt requested", { acceptsUri, acceptsCid });
          const ref = await mintGrantForAccepts({ agent: getAgent(), resolve, acceptsUri, acceptsCid });
          log("info", "receipts.free minted", { uri: ref.uri, cid: ref.cid });
          return c.json({ uri: ref.uri, cid: ref.cid });
        });
      }

      if (opts.x402) {
        const {
          getAgent,
          resolve,
          log = noopLog,
          path = "x402/receipt",
          paymentMiddleware,
        } = opts.x402;
        if (paymentMiddleware) {
          app.use(`/${path}/*`, paymentMiddleware);
        }
        app.get(`/${path}/*`, async (c) => {
          const { acceptsUri, acceptsCid } = parseReceiptPath(c.req.path, `${path}/`);
          log("info", "x402 receipt requested", { acceptsUri, acceptsCid });
          const ref = await mintReceiptForAccepts({ agent: getAgent(), resolve, acceptsUri, acceptsCid });
          log("info", "receipts.x402 minted", { uri: ref.uri, cid: ref.cid });
          return c.json({ uri: ref.uri, cid: ref.cid });
        });
      }
    },
  });
}
