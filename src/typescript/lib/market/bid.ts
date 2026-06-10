// Factory for the bidder's createAndSubmitBid flow.
//
// Encapsulates the record-write sequence: mint bid config, mint bid payload via
// the settlement layer, create the market.bid record, then proxy-call submitBid
// back to the RFP issuer if requested. The bidder wires this once at startup.

import type { Agent } from "@atproto/api";
import { BID_NSID } from "@publicdomainrelay/lexicons";
import type { RFP, Logger, StrongRef } from "./types.ts";
import { createSignedRecord, type RecordSigner } from "./signing.ts";
import { MarketClient } from "./client.ts";

export interface BidFactoryDeps {
  getAgent: () => Agent;
  /** Mint the provider-specific bid config record and return its ref. */
  createBidConfig: (nowIso: string) => Promise<StrongRef>;
  getMarketClient: () => MarketClient;
  /** Bidder's `did:web` service DID string (e.g. `did:web:host#pdr_temp_market`). */
  submitAcceptServiceDid: string;
  /** The bidder's badge.blue signer — the bid carries its inline signature. */
  getSigner: () => RecordSigner;
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
  const { getAgent, createBidConfig, getMarketClient, submitAcceptServiceDid, getSigner, log } = deps;

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

    const bidRef = await createSignedRecord(getAgent(), BID_NSID, bid, getSigner());
    log("info", "bidRecord", { bidRecord: bidRef });

    if (rfpRecord.submitBid) {
      try {
        await getMarketClient().submitBid(rfpRecord.submitBid, {
          uri: bidRef.uri,
          cid: bidRef.cid,
          record: bid,
        });
        log("info", "submitBid proxied call", { ref: rfpRecord.submitBid });
      } catch (err) {
        log("warn", "submitBid proxied call failed", { ref: rfpRecord.submitBid, err: String(err) });
      }
    }

    return { bidUri: bidRef.uri, bidCid: bidRef.cid };
  };
}
