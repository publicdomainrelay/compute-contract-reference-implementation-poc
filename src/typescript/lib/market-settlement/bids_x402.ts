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

import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createRecord, type StrongRef } from "@publicdomainrelay/market";
import {
  BIDS_X402_NSID,
  mintReceiptForAccepts,
  parseReceiptPath,
  verifyX402Payment,
} from "@publicdomainrelay/market-x402";
import { receiptUrlFor, type Settlement, type SettlementCtx } from "./settlement.ts";

const PATH = "x402/receipt";

function cdpAuthProvider(_keyId: string, _keySecret: string) {
  // deno-lint-ignore no-explicit-any
  return async (_req: any) => ({});
}

function makeFacilitator(cdpApiKeyId: string, cdpApiKeySecret: string) {
  return new HTTPFacilitatorClient({
    url: "https://api.cdp.coinbase.com/platform/v2/x402",
    authProvider: cdpAuthProvider(cdpApiKeyId, cdpApiKeySecret),
    // deno-lint-ignore no-explicit-any
  } as any);
}

/** Build the x402 (paying) settlement. Reads its own CDP/payee env. */
export function createX402Settlement(ctx: SettlementCtx): Settlement {
  const { getAgent, resolve, log, baseUrl } = ctx;
  const payTo = Deno.env.get("RECV_ADDR") ?? (() => { throw new Error("RECV_ADDR is required"); })();
  const cdpApiKeyId = Deno.env.get("CDP_RECV_API_KEY_ID") ?? (() => { throw new Error("CDP_RECV_API_KEY_ID is required"); })();
  const cdpApiKeySecret = Deno.env.get("CDP_RECV_API_KEY_SECRET") ?? (() => { throw new Error("CDP_RECV_API_KEY_SECRET is required"); })();

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

    bidsFactoryOptions: () => {
      const server = new x402ResourceServer(makeFacilitator(cdpApiKeyId, cdpApiKeySecret))
        .register("eip155:8453", new ExactEvmScheme());
      const mw = paymentMiddleware(
        {
          [`GET /${PATH}/*`]: {
            accepts: [{ scheme: "exact", price: "$1.00", network: "eip155:8453", payTo }],
            description: "Pay for compute contract",
            mimeType: "application/json",
          },
        },
        server,
      );
      return {
        x402: {
          getAgent,
          resolve,
          log,
          path: PATH,
          paymentMiddleware: mw,
        },
      };
    },
  };
}
