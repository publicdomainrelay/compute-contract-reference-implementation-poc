// Resolving the full record graph behind a market.accept.
//
// Settling an accept means fetching every record it transitively references —
// the bid, the rfp, their payloads and config — and confirming they are mutually
// consistent before any resource is provisioned. `resolveContractGraph` is that
// traversal: it mirrors the relationships in the market.* lexicons
//   accept -> bid,  accept -> rfp -> payload,  bid -> payload,  bid -> config?
// and enforces the one cross-record invariant a receiver must not skip: the bid
// and the accept name the same RFP.

import type { RecordResolver } from "./resolve.ts";
import { refsEqual } from "./resolve.ts";
import type { Accept, Bid, Resolved, RFP } from "./types.ts";

/**
 * Thrown when an accept's referenced records are mutually inconsistent. Carries
 * a `status` of 400 so HTTP hosts (e.g. the reference bidder's error middleware)
 * map it to a client error rather than a generic 500.
 */
export class ContractGraphError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ContractGraphError";
  }
}

/** The fully resolved record graph behind an accepted bid. */
export interface ContractGraph {
  bid: Resolved<Bid>;
  rfp: Resolved<RFP>;
  /** The RFP's domain payload (e.g. a compute.vm record). */
  rfpPayload: Resolved<Record<string, unknown>>;
  /** The bid's payload (e.g. a bids.x402 / bids.free record). */
  bidPayload: Resolved<Record<string, unknown>>;
  /** The bid's optional config (e.g. compute.config.wif.simple), or null when absent. */
  bidConfig: Resolved<Record<string, unknown>> | null;
}

/**
 * Resolve every record an accept references and verify their consistency.
 *
 * Fetches the bid named by `accept.bid`, asserts it names the same RFP as the
 * accept (`bid.rfp === accept.rfp`), then resolves the RFP, the RFP's payload,
 * the bid's payload, and the bid's optional config. Throws
 * {@link ContractGraphError} (HTTP 400) on a bid/accept RFP mismatch.
 */
export async function resolveContractGraph(
  accept: Accept,
  resolve: RecordResolver,
): Promise<ContractGraph> {
  const bid = await resolve.resolve<Bid>({ uri: accept.bid.uri, cid: accept.bid.cid });
  if (!refsEqual(bid.rfp, accept.rfp)) {
    throw new ContractGraphError("Accept.rfp does not match Bid.rfp");
  }
  const rfp = await resolve.resolve<RFP>({ uri: accept.rfp.uri, cid: accept.rfp.cid });
  const rfpPayload = await resolve.resolve<Record<string, unknown>>({ uri: rfp.payload.uri, cid: rfp.payload.cid });
  const bidPayload = await resolve.resolve<Record<string, unknown>>({ uri: bid.payload.uri, cid: bid.payload.cid });
  const bidConfig = bid.config
    ? await resolve.resolve<Record<string, unknown>>({ uri: bid.config.uri, cid: bid.config.cid })
    : null;
  return { bid, rfp, rfpPayload, bidPayload, bidConfig };
}
