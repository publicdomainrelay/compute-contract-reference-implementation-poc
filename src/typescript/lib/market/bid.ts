// Factory for the bidder's createAndSubmitBid flow.
//
// Encapsulates the record-write sequence: mint bid config, mint bid payload via
// the settlement layer, create the market.bid record, then proxy-call submitBid
// back to the RFP issuer if requested. The bidder wires this once at startup.

import { BID_NSID } from "@publicdomainrelay/lexicons";
import type { RFP, Logger, StrongRef } from "./types.ts";
import { MarketClient } from "./client.ts";

export interface BidFactoryDeps {
  /** Mint the provider-specific bid config record and return its ref. */
  createBidConfig: (nowIso: string) => Promise<StrongRef>;
  /**
   * A signer-bound MarketClient (built with `{ agent, signer }`): it signs and
   * writes the bid record itself, so the factory never handles the keypair.
   */
  getMarketClient: () => MarketClient;
  /** Bidder's `did:web` service DID string (e.g. `did:web:host#pdr_temp_market`). */
  submitAcceptServiceDid: string;
  log: Logger;
}

export interface BidSettlementDeps {
  receiptUrl(reqUrl: string): string;
  createBidPayload(receiptUrl: string, nowIso: string): Promise<StrongRef>;
}

/**
 * Create a `createAndSubmitBid` function bound to the given deps.
 *
 * Returns a function that, given an RFP, mints all required records and
 * optionally proxies a `submitBid` call back to the RFP issuer.
 */
export function createBidFactory(deps: BidFactoryDeps) {
  const { createBidConfig, getMarketClient, submitAcceptServiceDid, log } = deps;

  return async function createAndSubmitBid(
    rfpUri: string,
    rfpCid: string,
    rfpRecord: RFP,
    settlement: BidSettlementDeps,
    reqUrl: string,
  ): Promise<{ bidUri: string; bidCid: string }> {
    const nowIso = new Date().toISOString();
    const configRef = await createBidConfig(nowIso);
    const payloadRef = await settlement.createBidPayload(settlement.receiptUrl(reqUrl), nowIso);

    const bid = {
      $type: BID_NSID,
      rfp: { $type: "com.atproto.repo.strongRef", uri: rfpUri, cid: rfpCid },
      config: { $type: "com.atproto.repo.strongRef", uri: configRef.uri, cid: configRef.cid },
      payload: { $type: "com.atproto.repo.strongRef", uri: payloadRef.uri, cid: payloadRef.cid },
      submitAccept: submitAcceptServiceDid,
      createdAt: nowIso,
    };

    // The signer-bound client signs the bid, writes it to our repo, and (when
    // the RFP carries a submitBid ref) forwards the attested copy. We hand it the
    // unsigned body — there is no API here that could send an unsigned record.
    const market = getMarketClient();
    const submitBidRef = rfpRecord.submitBid;
    let bidRef;
    if (submitBidRef) {
      const sub = await market.submitBid(submitBidRef, bid);
      bidRef = sub.ref;
      if (sub.ok) log("info", "submitBid proxied call", { ref: submitBidRef });
      else log("warn", "submitBid proxied call failed", { ref: submitBidRef, err: sub.error });
    } else {
      bidRef = await market.create(BID_NSID, bid);
    }
    log("info", "bidRecord", { bidRecord: { uri: bidRef.uri, cid: bidRef.cid } });

    return { bidUri: bidRef.uri, bidCid: bidRef.cid };
  };
}
