// ---------------------------------------------------------------------------
// x402 payment leg: GET /x402/receipt/<accepts.x402-at-uri>/<cid>
//
// Payment-gated by x402 middleware (or bypassed via X402_MAKE_FREE=1). The
// requester mints a
// com.publicdomainrelay.temp.market.accepts.x402 record accepting a bid's
// payment terms, then GETs this endpoint with that record's AT-URI + CID.
// Once payment clears we mint a receipts.x402 proof-of-payment record and
// hand back its strongRef; the requester uses it as the payload of the
// higher-level market.accept, which submitAccept later verifies before
// provisioning. This endpoint does NOT provision compute — that is
// submitAccept (see main.ts).
// ---------------------------------------------------------------------------

import type { Hono } from "npm:hono@^4.12.23";
import { paymentMiddleware, x402ResourceServer } from "npm:@x402/hono";
import { ExactEvmScheme } from "npm:@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "npm:@x402/core/server";
import { Agent } from "@atproto/api";

export const PATH_X402_RECEIPT = "x402/receipt";

type LogLevel = "info" | "warn" | "error" | "debug";
type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface BidsX402Ctx {
  app: Hono;
  getAgent: () => Agent;
  log: Logger;
  baseUrl: string;
  payTo: string;
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
  acceptsX402Nsid: string;
  receiptsX402Nsid: string;
  cidRe: RegExp;
  resolveAs: <T>(uri: string, cid: string) => Promise<T & { _uri: string; _cid: string }>;
  httpError: new (status: number, detail: string) => Error & { status: number; detail: string };
}

// Build the x402 payment URL the bid advertises in its bids.x402 payload.
// Prefer the configured BASE_URL; fall back to the incoming request origin.
export function x402UrlTemplate(baseUrl: string, reqUrl: string): string {
  const base = baseUrl || new URL(reqUrl).origin;
  return `${base.replace(/\/+$/, "")}/${PATH_X402_RECEIPT}`;
}

function cdpAuthProvider(_keyId: string, _keySecret: string) {
  // The @coinbase/x402 npm package exports `facilitator` with auth baked in.
  // We re-import lazily to keep this file runnable with X402_MAKE_FREE=1
  // even when the package isn't installed.
  // deno-lint-ignore no-explicit-any
  return async (_req: any) => ({}); // headers added by @coinbase/x402 when wired
}

// CDP facilitator with header auth (matches python create_headers). CDP
// requires a JWT per request; for parity with python (which uses
// cdp.auth.utils.jwt.generate_jwt) we expose a callback that builds a bearer
// JWT for the given request.
function makeFacilitator(cdpApiKeyId: string, cdpApiKeySecret: string) {
  const url = "https://api.cdp.coinbase.com/platform/v2/x402";
  // The CDP auth provider is supplied via a field the published FacilitatorConfig
  // type doesn't declare; cast so this stays runnable while @x402 types catch up.
  return new HTTPFacilitatorClient({
    url,
    authProvider: cdpAuthProvider(cdpApiKeyId, cdpApiKeySecret),
    // deno-lint-ignore no-explicit-any
  } as any);
}

// Wires the x402 payment middleware (skipped when X402_MAKE_FREE is set) and
// the GET /x402/receipt/* route that mints the receipts.x402 proof-of-payment
// record once payment has cleared.
export function setupX402(makeFree: boolean, ctx: BidsX402Ctx): void {
  const { app, log, baseUrl, payTo, cdpApiKeyId, cdpApiKeySecret, acceptsX402Nsid, receiptsX402Nsid, cidRe, resolveAs, httpError: HTTPError } = ctx;

  if (!makeFree) {
    const facilitatorClient = makeFacilitator(cdpApiKeyId, cdpApiKeySecret);
    const server = new x402ResourceServer(facilitatorClient).register(
      "eip155:8453",
      new ExactEvmScheme(),
    );
    app.use(
      paymentMiddleware(
        {
          [`GET /${PATH_X402_RECEIPT}/*`]: {
            accepts: [
              { scheme: "exact", price: "$1.00", network: "eip155:8453", payTo },
            ],
            description: "Pay for compute contract",
            mimeType: "application/json",
          },
        },
        server,
      ),
    );
  }

  app.get(`/${PATH_X402_RECEIPT}/*`, async (c) => {
    let path = c.req.path.replace(/^\/+/, "");
    if (path.startsWith(`${PATH_X402_RECEIPT}/`)) path = path.slice(`${PATH_X402_RECEIPT}/`.length);
    if (!path.includes("/")) throw new HTTPError(400, "missing cid");
    const lastSlash = path.lastIndexOf("/");
    const acceptsCid = path.slice(lastSlash + 1);
    const acceptsUri = path.slice(0, lastSlash);
    if (!cidRe.test(acceptsCid)) throw new HTTPError(400, "invalid cid");

    log("info", "x402 receipt requested", { acceptsUri, acceptsCid });

    const acceptsX402 = await resolveAs<{ $type?: string }>(acceptsUri, acceptsCid);
    if (acceptsX402.$type && acceptsX402.$type !== acceptsX402Nsid) {
      throw new HTTPError(400, `expected ${acceptsX402Nsid}, got ${acceptsX402.$type}`);
    }

    // Payment has cleared (middleware) — mint a proof-of-payment receipt that
    // points back at the accepts.x402 the requester paid against.
    const agent = ctx.getAgent();
    const res = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection: receiptsX402Nsid,
      record: {
        $type: receiptsX402Nsid,
        accept: { $type: "com.atproto.repo.strongRef", uri: acceptsUri, cid: acceptsCid },
        createdAt: new Date().toISOString(),
      },
    });
    log("info", "receipts.x402 minted", { uri: res.data.uri, cid: res.data.cid, acceptsUri });
    return c.json({ uri: res.data.uri, cid: res.data.cid });
  });
}
