// Wire-shape types for the com.publicdomainrelay.temp.market.* lexicons.
//
// These are intentionally loose (structural, not strict validators): they
// mirror the shapes the PDS stores and returns, the same way the reference
// bidder treats them. Strict validation, when wanted, is left to the atproto
// XrpcClient (which uses the embedded lexicons in ./lexicons.ts) or to the
// caller's own checks inside a handler callback.

/** com.atproto.repo.strongRef — a content-addressed pointer to a record. */
export type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

/**
 * A record resolved out of a repo, annotated with the `uri`/`cid` it was
 * fetched by so downstream code can re-reference it without threading the
 * strongRef separately. The `_uri`/`_cid` convention matches the reference
 * bidder's `resolveAs` helper.
 */
export type Resolved<T> = T & { _uri: string; _cid: string };

/** com.publicdomainrelay.temp.market.rfp */
export type RFP = {
  /** strongRef to the domain-specific payload (e.g. compute.vm). */
  payload: StrongRef;
  /** optional service DID ref (did:web:HOST#id) for submitBid bypass. */
  submitBid?: string;
};

/** com.publicdomainrelay.temp.market.bid */
export type Bid = {
  rfp: StrongRef;
  payload: StrongRef;
  config?: StrongRef;
  /** optional service DID ref for the submitAccept settlement leg. */
  submitAccept?: string;
};

/** com.publicdomainrelay.temp.market.accept */
export type Accept = {
  rfp: StrongRef;
  bid: StrongRef;
  /** strongRef to the proof-of-payment record (e.g. receipts.x402). */
  payload?: StrongRef;
  /** optional service DID ref for the submitEvent bypass. */
  submitEvent?: string;
};

/** com.publicdomainrelay.temp.market.event */
export type MarketEvent = {
  /** strongRef to the receipt this event pertains to. */
  receipt: StrongRef;
  /** strongRef to the domain-specific event payload (e.g. compute.events.vm.delete). */
  payload: StrongRef;
};

/** com.publicdomainrelay.temp.market.receipt */
export type Receipt = {
  rfp: StrongRef;
  bid: StrongRef;
  accept: StrongRef;
  payload?: StrongRef;
  /** service DID ref scoped to this receipt for submitEvent. */
  submitEvent?: string;
};

/** com.publicdomainrelay.temp.market.offering */
export type Offering = {
  /** service DID ref (did:web:HOST#id) RFP issuers call submitRfp against. */
  endpointUrl: string;
  /** payload NSIDs this bidder handles. */
  appliesTo: string[];
  createdAt: string;
};

/** Build a com.atproto.repo.strongRef literal from a uri/cid pair. */
export function strongRef(uri: string, cid: string): StrongRef {
  return { $type: "com.atproto.repo.strongRef", uri, cid };
}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Pluggable structured logger; matches the reference bidder's `log` shape. */
export type Logger = (
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

/** Default logger that discards everything. */
export const noopLogger: Logger = () => {};
