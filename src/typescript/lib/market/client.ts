// Client helpers for calling the market.* submit procedures.
//
// Each call is routed to a counterparty's service via PDS service-proxying: the
// caller's own PDS mints the inter-service auth JWT when it sees the
// `atproto-proxy` header naming the target service DID ref. So a MarketClient is
// just an authenticated XrpcClient (built on the caller's session/agent) plus
// the embedded market lexicons; the `target` argument on each method is the
// `did:web:HOST#<service-id>` ref to proxy to.

import { XrpcClient } from "@atproto/xrpc";
import {
  SUBMIT_ACCEPT_NSID,
  SUBMIT_BID_NSID,
  SUBMIT_EVENT_NSID,
  SUBMIT_RFP_NSID,
} from "@publicdomainrelay/lexicons";
import type { StrongRef } from "./types.ts";
import type { SignedRecord } from "./signing.ts";

// Minimal LexiconDoc stubs for the four market submit procedures.
// XrpcClient.call() requires a registered lexicon to determine HTTP method
// and build the request URL; without these it throws "Lexicon not found".
const MARKET_PROCEDURE_LEXICONS = [
  SUBMIT_RFP_NSID,
  SUBMIT_BID_NSID,
  SUBMIT_ACCEPT_NSID,
  SUBMIT_EVENT_NSID,
].map((id) => ({
  lexicon: 1 as const,
  id,
  defs: { main: { type: "procedure" as const } },
}));

/**
 * What @atproto/xrpc accepts as its first constructor argument: a service URL,
 * a CredentialSession, an Agent, or any fetch handler. Kept loose so callers
 * can pass an authenticated Agent/session per the project convention.
 */
// deno-lint-ignore no-explicit-any
export type XrpcService = any;

export interface SubmitRfpResult {
  ok: boolean;
  bidUri?: string;
  bidCid?: string;
}

export interface SubmitAcceptResult {
  /** rkey of the newly minted receipt. */
  id: string;
  /** AT-URI of the receipt. */
  uri: string;
  /** CID of the receipt. */
  cid: string;
  /** Service DID ref to call submitEvent against for this receipt. */
  submitEvent: string;
}

export interface SubmitBidResult {
  ok: boolean;
}

export interface SubmitEventResult {
  ok: boolean;
}

function proxyHeaders(target: string): Record<string, string> {
  return { "atproto-proxy": target };
}

/**
 * Thin wrapper over an authenticated XrpcClient for the four market submit
 * procedures. Construct via {@link createMarketClient}.
 */
export class MarketClient {
  readonly xrpc: XrpcClient;

  constructor(service: XrpcService) {
    this.xrpc = new XrpcClient(service, MARKET_PROCEDURE_LEXICONS);
  }

  /**
   * Submit an RFP to a bidder's market service (the offering's `endpointUrl`).
   * @param target service DID ref to proxy to, e.g. `did:web:HOST#pdr_temp_market`.
   */
  async submitRfp(target: string, input: { rfpUri: string; rfpCid: string }): Promise<SubmitRfpResult> {
    const res = await this.xrpc.call(SUBMIT_RFP_NSID, {}, input, { headers: proxyHeaders(target) });
    return res.data as SubmitRfpResult;
  }

  /**
   * Submit a bid record back to the RFP issuer (RFP's `submitBid` ref). Takes a
   * {@link SignedRecord} — the signed envelope from `createSignedRecord` — so an
   * unsigned body cannot be sent; that is a compile error, not a runtime reject.
   * @param target service DID ref to proxy to.
   */
  async submitBid(target: string, bid: SignedRecord): Promise<SubmitBidResult> {
    const res = await this.xrpc.call(SUBMIT_BID_NSID, {}, bid, { headers: proxyHeaders(target) });
    return res.data as SubmitBidResult;
  }

  /**
   * Settle a contract by submitting an accept record to the bidder's market
   * service (the winning bid's `submitAccept` ref).
   * @param target service DID ref to proxy to.
   */
  async submitAccept(target: string, input: { acceptUri: string; acceptCid: string }): Promise<SubmitAcceptResult> {
    const res = await this.xrpc.call(SUBMIT_ACCEPT_NSID, {}, input, { headers: proxyHeaders(target) });
    return res.data as SubmitAcceptResult;
  }

  /**
   * Report a lifecycle event to the counterparty's compute-event service (the
   * accept/receipt's `submitEvent` ref).
   * @param target service DID ref to proxy to, e.g. `did:web:HOST#pdr_temp_compute_event`.
   */
  async submitEvent(target: string, event: SignedRecord): Promise<SubmitEventResult> {
    const res = await this.xrpc.call(SUBMIT_EVENT_NSID, {}, event, { headers: proxyHeaders(target) });
    return res.data as SubmitEventResult;
  }
}

/**
 * Build a {@link MarketClient} over an authenticated atproto handler. Pass an
 * Agent's session (`new CredentialSession(...)` after login), an Agent, or any
 * value @atproto/xrpc's XrpcClient accepts as a fetch handler.
 */
export function createMarketClient(service: XrpcService): MarketClient {
  return new MarketClient(service);
}

export type { StrongRef };
