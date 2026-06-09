// Seller side of the free (no-cost) settlement leg.
//
// The mirror of market-x402's seller, with the payment removed: there is no
// middleware gate and no facilitator. The bidder still mints a receipt so it
// keeps a verifiable, self-authored record that it granted the resource — the
// same evidence shape submitAccept already knows how to check.
//   - mintGrantForAccepts: resolve the buyer's accepts.free and mint a
//     receipts.free proof-of-grant pointing back at it.
//   - verifyFreeGrant: when settling a market.accept, confirm its payload is a
//     receipts.free that THIS bidder authored.

import type { Agent } from "@atproto/api";
import {
  atUriAuthority,
  createRecord,
  nsidFromUri,
  type RecordResolver,
  type Resolved,
  strongRef,
  type StrongRef,
} from "../market/mod.ts";
import { ACCEPTS_FREE_NSID, RECEIPTS_FREE_NSID } from "../lexicons/mod.ts";
import type { Main as AcceptsFree } from "../lexicons/com/publicdomainrelay/temp/market/accepts/free.defs.ts";
import type { Main as ReceiptsFree } from "../lexicons/com/publicdomainrelay/temp/market/receipts/free.defs.ts";

/** Error carrying an HTTP status, so callers can map it to their framework. */
export class FreeGrantError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "FreeGrantError";
  }
}

/**
 * Parse an `…/<accepts.free-at-uri>/<cid>` request path into its parts. Pass the
 * route prefix to strip (e.g. `"free/receipt/"`); leading slashes are ignored.
 * The AT-URI itself contains slashes, so the cid is taken as the last segment.
 */
export function parseGrantPath(path: string, prefix = ""): { acceptsUri: string; acceptsCid: string } {
  let p = path.replace(/^\/+/, "");
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
  const lastSlash = p.lastIndexOf("/");
  if (lastSlash <= 0) throw new FreeGrantError(400, "missing cid");
  return { acceptsUri: p.slice(0, lastSlash), acceptsCid: p.slice(lastSlash + 1) };
}

/**
 * Mint a receipts.free proof-of-grant for an accepts.free. Unlike the x402
 * counterpart there is nothing to gate on — the offer is free — so call this as
 * soon as the request arrives. Validates the referenced record is an
 * accepts.free, then writes the receipt to the bidder's repo.
 */
export async function mintGrantForAccepts(opts: {
  agent: Agent;
  resolve: RecordResolver;
  acceptsUri: string;
  acceptsCid: string;
}): Promise<StrongRef> {
  const { agent, resolve, acceptsUri, acceptsCid } = opts;
  const acceptsFree = await resolve.resolve<AcceptsFree>({ uri: acceptsUri, cid: acceptsCid });
  if (acceptsFree.$type && acceptsFree.$type !== ACCEPTS_FREE_NSID) {
    throw new FreeGrantError(400, `expected ${ACCEPTS_FREE_NSID}, got ${acceptsFree.$type}`);
  }
  return await createRecord(agent, RECEIPTS_FREE_NSID, {
    $type: RECEIPTS_FREE_NSID,
    accept: strongRef(acceptsUri, acceptsCid),
    createdAt: new Date().toISOString(),
  });
}

/**
 * Verify a market.accept's payload is an acceptable proof of free grant: it must
 * exist, resolve to a receipts.free, and be authored by this bidder (so the
 * grant is one we actually issued). Returns the resolved receipt on success.
 *
 * @throws {FreeGrantError} with status 400 on any failure.
 */
export async function verifyFreeGrant(opts: {
  /** The market.accept's `payload` strongRef. */
  payment: StrongRef | undefined;
  resolve: RecordResolver;
  /** This bidder's DID — the receipt must be authored by it. */
  bidderDid: string;
}): Promise<Resolved<ReceiptsFree>> {
  const { payment, resolve, bidderDid } = opts;
  if (!payment) {
    throw new FreeGrantError(400, "Accept.payload (receipts.free proof-of-grant) is required");
  }
  const receipt = await resolve.resolve<ReceiptsFree & { $type?: string }>(payment);
  const nsid = receipt.$type ?? nsidFromUri(payment.uri);
  if (nsid !== RECEIPTS_FREE_NSID) {
    throw new FreeGrantError(400, `Accept.payload must be a ${RECEIPTS_FREE_NSID}, got ${nsid}`);
  }
  if (atUriAuthority(payment.uri) !== bidderDid) {
    throw new FreeGrantError(400, "Accept.payload proof-of-grant must be authored by this bidder");
  }
  return receipt;
}
