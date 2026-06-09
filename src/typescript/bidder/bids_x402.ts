// x402 settlement: settle a market.accept by *paying*.
//
// Implements the bidder's `Settlement` interface (./settlement.ts) on top of
// @publicdomainrelay/market-x402, which owns all the atproto record plumbing
// (minting receipts.x402, verifying the accept payload). The only thing that
// stays here is the bit that is genuinely the consumer's concern: wiring the
// @x402/* payment middleware that gates the receipt endpoint.
//
//   GET /x402/receipt/<accepts.x402-at-uri>/<cid>
//
// The buyer mints an accepts.x402, GETs this (payment-gated) endpoint, and the
// bidder mints + returns a receipts.x402 proof-of-payment used as the
// market.accept payload. This endpoint does NOT provision compute — that is
// submitAccept (see main.ts).

import type { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createRecord, type StrongRef } from "../lib/market/mod.ts";
import {
  BIDS_X402_NSID,
  mintReceiptForAccepts,
  parseReceiptPath,
  verifyX402Payment,
} from "../lib/market-x402/mod.ts";
import { reqEnv } from "./env.ts";
import { receiptUrlFor, type Settlement, type SettlementCtx } from "./settlement.ts";

const PATH = "x402/receipt";

function cdpAuthProvider(_keyId: string, _keySecret: string) {
  // The @coinbase/x402 npm package exports `facilitator` with auth baked in.
  // We re-import lazily to keep the seller runnable even when that package isn't
  // installed; the bidder only mints receipts after payment clears.
  // deno-lint-ignore no-explicit-any
  return async (_req: any) => ({}); // headers added by @coinbase/x402 when wired
}

// CDP facilitator with header auth (matches python create_headers). CDP requires
// a JWT per request; the auth provider builds a bearer JWT for the given request.
function makeFacilitator(cdpApiKeyId: string, cdpApiKeySecret: string) {
  // The CDP auth provider is supplied via a field the published FacilitatorConfig
  // type doesn't declare; cast so this stays runnable while @x402 types catch up.
  return new HTTPFacilitatorClient({
    url: "https://api.cdp.coinbase.com/platform/v2/x402",
    authProvider: cdpAuthProvider(cdpApiKeyId, cdpApiKeySecret),
    // deno-lint-ignore no-explicit-any
  } as any);
}

/** Build the x402 (paying) settlement. Reads its own CDP/payee env. */
export function createX402Settlement(ctx: SettlementCtx): Settlement {
  const { getAgent, resolve, log, baseUrl } = ctx;
  const payTo = reqEnv("RECV_ADDR");
  const cdpApiKeyId = reqEnv("CDP_RECV_API_KEY_ID");
  const cdpApiKeySecret = reqEnv("CDP_RECV_API_KEY_SECRET");

  return {
    mode: "x402",
    bidPayloadNsid: BIDS_X402_NSID,

    receiptUrl: (reqUrl) => receiptUrlFor(baseUrl, reqUrl, PATH),

    createBidPayload: (receiptUrl, nowIso): Promise<StrongRef> =>
      createRecord(getAgent(), BIDS_X402_NSID, {
        $type: BIDS_X402_NSID,
        cost: 1,
        currency: "USDC",
        frequency: "monthly",
        prepay: true,
        url: receiptUrl,
        createdAt: nowIso,
      }),

    verifyAcceptPayload: async (payment) => {
      await verifyX402Payment({ payment, resolve, bidderDid: getAgent().assertDid });
      log("info", "payment verified", { receiptsX402: payment?.uri });
    },

    mount: (app: Hono) => {
      const server = new x402ResourceServer(makeFacilitator(cdpApiKeyId, cdpApiKeySecret))
        .register("eip155:8453", new ExactEvmScheme());
      app.use(
        paymentMiddleware(
          {
            [`GET /${PATH}/*`]: {
              accepts: [{ scheme: "exact", price: "$1.00", network: "eip155:8453", payTo }],
              description: "Pay for compute contract",
              mimeType: "application/json",
            },
          },
          server,
        ),
      );

      app.get(`/${PATH}/*`, async (c) => {
        const { acceptsUri, acceptsCid } = parseReceiptPath(c.req.path, `${PATH}/`);
        log("info", "x402 receipt requested", { acceptsUri, acceptsCid });
        // Payment has cleared (middleware); mint the proof-of-payment receipt.
        const ref = await mintReceiptForAccepts({ agent: getAgent(), resolve, acceptsUri, acceptsCid });
        log("info", "receipts.x402 minted", { uri: ref.uri, cid: ref.cid, acceptsUri });
        return c.json({ uri: ref.uri, cid: ref.cid });
      });
    },
  };
}
