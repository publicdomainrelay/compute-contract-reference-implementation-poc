// Client helpers for calling the market.* submit procedures.
//
// Each call is routed to a counterparty's service via PDS service-proxying: the
// caller's own PDS mints the inter-service auth JWT when it sees the
// `atproto-proxy` header naming the target service DID ref. So a MarketClient is
// an authenticated XrpcClient (built on the caller's session/agent) plus the
// embedded market lexicons; the `target` argument on each method is the
// `did:web:HOST#<service-id>` ref to proxy to.
//
// A client may also be given an `agent` + `signer` (see {@link createMarketClient}).
// When it is, `submitBid`/`submitEvent` take the *unsigned* record body and the
// client signs it, writes it to the agent's repo, and forwards the attested copy
// — the producer never touches the badge.blue machinery and can never forward an
// unsigned body, because there is no longer an API that accepts one.

import { XrpcClient } from "@atproto/xrpc";
import type { Agent } from "@atproto/api";
import {
  BID_NSID,
  EVENT_NSID,
  SUBMIT_ACCEPT_NSID,
  SUBMIT_BID_NSID,
  SUBMIT_EVENT_NSID,
  SUBMIT_RFP_NSID,
} from "@publicdomainrelay/lexicons";
import type { StrongRef } from "./types.ts";
import { createSignedRecord, type RecordSigner, type SignedRecord } from "./signing.ts";

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

/**
 * The result of a `submitBid`/`submitEvent` call. The record is *always* created
 * in the producer's repo (the call throws only if that durable write fails), so
 * `ref` is the attested record you can rely on; `ok` reports whether the
 * best-effort proxied notification to the counterparty also succeeded.
 */
export interface Submission<T extends Record<string, unknown> = Record<string, unknown>> {
  /** The signed record that was minted and written to the producer's repo. */
  ref: SignedRecord<T>;
  /** True when the proxied submit reached the counterparty without error. */
  ok: boolean;
  /** Present when `ok` is false: the stringified forward error. */
  error?: string;
}

/** A MarketClient given an `agent` + `signer` can sign records on the caller's behalf. */
export interface MarketClientOptions {
  /** Agent whose repo signed records are written to (its DID is the author). */
  agent?: Agent;
  /** badge.blue signer for the records this client mints. */
  signer?: RecordSigner;
}

function proxyHeaders(target: string): Record<string, string> {
  return { "atproto-proxy": target };
}

/**
 * Wrapper over an authenticated XrpcClient for the market submit procedures.
 * Construct via {@link createMarketClient}. When built with an `agent` + `signer`,
 * `submitBid`/`submitEvent`/`create` sign on your behalf.
 */
export class MarketClient {
  readonly xrpc: XrpcClient;
  readonly #agent?: Agent;
  readonly #signer?: RecordSigner;

  constructor(service: XrpcService, opts: MarketClientOptions = {}) {
    this.xrpc = new XrpcClient(service, MARKET_PROCEDURE_LEXICONS);
    this.#agent = opts.agent;
    this.#signer = opts.signer;
  }

  /**
   * Inline-sign `record` with this client's signer and write it to the agent's
   * repo, returning the {@link SignedRecord} envelope. Use this when you need to
   * mint a signed record without immediately forwarding it (e.g. a bid for an RFP
   * that carries no `submitBid` ref).
   */
  create<T extends Record<string, unknown>>(collection: string, record: T): Promise<SignedRecord<T>> {
    const { agent, signer } = this.#requireSigning();
    return createSignedRecord(agent, collection, record, signer);
  }

  #requireSigning(): { agent: Agent; signer: RecordSigner } {
    if (!this.#agent || !this.#signer) {
      throw new Error(
        "MarketClient was created without an agent+signer; pass them to " +
          "createMarketClient(service, { agent, signer }) to sign records.",
      );
    }
    return { agent: this.#agent, signer: this.#signer };
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
   * Submit a bid back to the RFP issuer (RFP's `submitBid` ref). Takes the
   * *unsigned* bid record: the client signs it, writes it to the agent's repo,
   * and forwards the attested copy. There is no way to forward an unsigned body.
   * The bid is always created (throws only if that write fails); the proxied
   * notification is best-effort — check {@link Submission.ok}.
   * @param target service DID ref to proxy to.
   */
  async submitBid<T extends Record<string, unknown>>(target: string, bid: T): Promise<Submission<T>> {
    const ref = await this.create(BID_NSID, bid);
    return this.#forward(SUBMIT_BID_NSID, target, ref);
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
   * accept/receipt's `submitEvent` ref). Takes the *unsigned* event record; the
   * client signs, creates, and forwards it exactly like {@link submitBid}.
   * @param target service DID ref to proxy to, e.g. `did:web:HOST#pdr_temp_compute_event`.
   */
  async submitEvent<T extends Record<string, unknown>>(target: string, event: T): Promise<Submission<T>> {
    const ref = await this.create(EVENT_NSID, event);
    return this.#forward(SUBMIT_EVENT_NSID, target, ref);
  }

  /** Proxy a freshly-minted signed record to a counterparty; never throws. */
  async #forward<T extends Record<string, unknown>>(
    nsid: string,
    target: string,
    ref: SignedRecord<T>,
  ): Promise<Submission<T>> {
    try {
      await this.xrpc.call(nsid, {}, ref, { headers: proxyHeaders(target) });
      return { ref, ok: true };
    } catch (err) {
      return { ref, ok: false, error: String(err) };
    }
  }
}

/**
 * Build a {@link MarketClient} over an authenticated atproto handler. Pass an
 * Agent's session (`new CredentialSession(...)` after login), an Agent, or any
 * value @atproto/xrpc's XrpcClient accepts as a fetch handler.
 *
 * Supply `{ agent, signer }` to make the client sign on your behalf: then
 * `submitBid`/`submitEvent`/`create` take unsigned record bodies and the client
 * mints the badge.blue attestation. Omit them for a transport-only client that
 * can still call the ref-based `submitRfp`/`submitAccept`.
 */
export function createMarketClient(service: XrpcService, opts: MarketClientOptions = {}): MarketClient {
  return new MarketClient(service, opts);
}

export type { StrongRef };
