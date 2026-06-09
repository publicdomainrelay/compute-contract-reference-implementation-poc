// Buyer side of the x402 payment leg.
//
// Given a winning bid whose payload (a bids.x402) advertises a payment `url`,
// settleX402Payment mints an accepts.x402 accepting those terms, GETs the
// payment endpoint with that record's AT-URI + CID (the x402 payment itself is
// handled by the HTTP layer / a paying fetch the caller may supply), and returns
// the receipts.x402 proof-of-payment strongRef the endpoint hands back. That ref
// becomes the payload of the higher-level market.accept.

import type { Agent } from "@atproto/api";
import { createRecord, type Logger, noopLogger, strongRef, type StrongRef } from "../market/mod.ts";
import { ACCEPTS_X402_NSID } from "./nsids.ts";
import { assertSafeEgressUrl, type EgressOptions } from "./egress.ts";

export interface SettleX402Options {
  /** Authenticated agent for the buyer's repo (mints the accepts.x402). */
  agent: Agent;
  /** strongRef to the winning market.bid being paid against. */
  bid: StrongRef;
  /** strongRef to the bid's payload (the bids.x402 record). */
  bidPayload: StrongRef;
  /** The x402 payment endpoint, taken from the bids.x402 `url` (untrusted). */
  url: string;
  /** SSRF guard options for the egress to `url`. */
  egress?: EgressOptions;
  /**
   * Fetch used for the payment GET. Defaults to global `fetch`. Supply an
   * x402-paying fetch (e.g. from `@x402/fetch`) here to actually settle payment;
   * the default assumes the endpoint is free / already paid (X402_MAKE_FREE).
   */
  fetch?: typeof fetch;
  /** Timeout for the payment GET in ms (default 30000). */
  timeoutMs?: number;
  log?: Logger;
}

/**
 * Settle a bid's x402 payment terms. Returns a strongRef to the bidder's
 * receipts.x402 proof-of-payment. Throws if the URL is unsafe, the request
 * fails, or the endpoint does not return a `{ uri, cid }` strongRef.
 */
export async function settleX402Payment(opts: SettleX402Options): Promise<StrongRef> {
  const { agent, bid, bidPayload, url } = opts;
  const log = opts.log ?? noopLogger;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;

  assertSafeEgressUrl(url, opts.egress);

  const acceptsX402 = await createRecord(agent, ACCEPTS_X402_NSID, {
    $type: ACCEPTS_X402_NSID,
    bid,
    payload: bidPayload,
    createdAt: new Date().toISOString(),
  });

  const receiptUrl = `${url.replace(/\/+$/, "")}/${acceptsX402.uri}/${acceptsX402.cid}`;
  log("info", "settling x402 payment", { url: receiptUrl, acceptsX402: acceptsX402.uri });

  const res = await doFetch(receiptUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`x402 payment failed ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { uri?: string; cid?: string };
  if (!body.uri || !body.cid) {
    throw new Error(`x402 payment endpoint returned no receipts.x402 strongRef: ${JSON.stringify(body)}`);
  }
  log("info", "x402 payment settled", { receiptsX402: body.uri });
  return strongRef(body.uri, body.cid);
}
