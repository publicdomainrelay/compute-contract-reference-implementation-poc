// Utility types for the market library — not codegen'd by @atproto/lex.
// Record-shaped types (RFP, Bid, Accept, MarketEvent, Receipt, Offering) are
// re-exported here as convenient aliases from the generated lexicon defs.

import type { Main as _Accept } from "../lexicons/com/publicdomainrelay/temp/market/accept.defs.ts";
import type { Main as _Bid } from "../lexicons/com/publicdomainrelay/temp/market/bid.defs.ts";
import type { Main as _Event } from "../lexicons/com/publicdomainrelay/temp/market/event.defs.ts";
import type { Main as _Offering } from "../lexicons/com/publicdomainrelay/temp/market/offering.defs.ts";
import type { Main as _Receipt } from "../lexicons/com/publicdomainrelay/temp/market/receipt.defs.ts";
import type { Main as _RFP } from "../lexicons/com/publicdomainrelay/temp/market/rfp.defs.ts";
import type { Main as _StrongRef } from "../lexicons/com/atproto/repo/strongRef.defs.ts";

export type StrongRef = _StrongRef;
export type RFP = _RFP;
export type Bid = _Bid;
export type Accept = _Accept;
export type MarketEvent = _Event;
export type Receipt = _Receipt;
export type Offering = _Offering;

/** A record resolved from a repo, annotated with the uri/cid it was fetched by. */
export type Resolved<T> = T & { _uri: string; _cid: string };

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export const noopLogger: Logger = () => {};

export function strongRef(uri: string, cid: string): StrongRef {
  return { $type: "com.atproto.repo.strongRef", uri, cid };
}
