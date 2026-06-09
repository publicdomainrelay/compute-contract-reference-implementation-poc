// TypeScript types for the com.publicdomainrelay.temp.market.* lexicons.
// Shapes mirror the lexicon JSON files in ./lexicons/; strict validation is
// left to the caller or the XrpcClient's embedded lexicon docs.

/** com.atproto.repo.strongRef */
export type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

/** A record resolved from a repo, annotated with the uri/cid it was fetched by. */
export type Resolved<T> = T & { _uri: string; _cid: string };

/** com.publicdomainrelay.temp.market.rfp */
export type RFP = {
  payload: StrongRef;
  submitBid?: string;
};

/** com.publicdomainrelay.temp.market.bid */
export type Bid = {
  rfp: StrongRef;
  payload: StrongRef;
  config?: StrongRef;
  submitAccept?: string;
};

/** com.publicdomainrelay.temp.market.accept */
export type Accept = {
  rfp: StrongRef;
  bid: StrongRef;
  payload?: StrongRef;
  submitEvent?: string;
};

/** com.publicdomainrelay.temp.market.event */
export type MarketEvent = {
  receipt: StrongRef;
  payload: StrongRef;
};

/** com.publicdomainrelay.temp.market.receipt */
export type Receipt = {
  rfp: StrongRef;
  bid: StrongRef;
  accept: StrongRef;
  payload?: StrongRef;
  submitEvent?: string;
};

/** com.publicdomainrelay.temp.market.offering */
export type Offering = {
  endpointUrl: string;
  appliesTo: string[];
  createdAt: string;
};

/** Build a com.atproto.repo.strongRef literal from a uri/cid pair. */
export function strongRef(uri: string, cid: string): StrongRef {
  return { $type: "com.atproto.repo.strongRef", uri, cid };
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export const noopLogger: Logger = () => {};
