// Buyer side of the free (no-cost) settlement leg.
//
// The mirror of market-x402's buyer, minus the money: given a winning bid whose
// payload (a bids.free) advertises a grant `url`, settleFreeGrant mints an
// accepts.free, GETs the grant endpoint with that record's AT-URI + CID, and
// returns the receipts.free proof-of-grant strongRef the endpoint hands back.
// That ref becomes the payload of the higher-level market.accept. Because the
// endpoint is free there is no paying fetch to supply.

import type { Agent } from "@atproto/api";
import {
  assertSafeEgressUrl,
  createRecord,
  type EgressOptions,
  type Logger,
  noopLogger,
  strongRef,
  type StrongRef,
} from "../market/mod.ts";
import { ACCEPTS_FREE_NSID } from "./nsids.ts";

export interface SettleFreeOptions {
  /** Authenticated agent for the buyer's repo (mints the accepts.free). */
  agent: Agent;
  /** strongRef to the winning market.bid being settled. */
  bid: StrongRef;
  /** strongRef to the bid's payload (the bids.free record). */
  bidPayload: StrongRef;
  /** The grant endpoint, taken from the bids.free `url` (untrusted). */
  url: string;
  /** SSRF guard options for the egress to `url`. */
  egress?: EgressOptions;
  /** Fetch used for the grant GET. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Timeout for the grant GET in ms (default 30000). */
  timeoutMs?: number;
  log?: Logger;
}

/**
 * Settle a bid's free terms. Returns a strongRef to the bidder's receipts.free
 * proof-of-grant. Throws if the URL is unsafe, the request fails, or the
 * endpoint does not return a `{ uri, cid }` strongRef.
 */
export async function settleFreeGrant(opts: SettleFreeOptions): Promise<StrongRef> {
  const { agent, bid, bidPayload, url } = opts;
  const log = opts.log ?? noopLogger;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;

  assertSafeEgressUrl(url, opts.egress);

  const acceptsFree = await createRecord(agent, ACCEPTS_FREE_NSID, {
    $type: ACCEPTS_FREE_NSID,
    bid,
    payload: bidPayload,
    createdAt: new Date().toISOString(),
  });

  const grantUrl = `${url.replace(/\/+$/, "")}/${acceptsFree.uri}/${acceptsFree.cid}`;
  log("info", "settling free grant", { url: grantUrl, acceptsFree: acceptsFree.uri });

  const res = await doFetch(grantUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`free grant failed ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { uri?: string; cid?: string };
  if (!body.uri || !body.cid) {
    throw new Error(`free grant endpoint returned no receipts.free strongRef: ${JSON.stringify(body)}`);
  }
  log("info", "free grant settled", { receiptsFree: body.uri });
  return strongRef(body.uri, body.cid);
}
