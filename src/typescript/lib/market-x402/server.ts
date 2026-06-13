// Seller side of the x402 payment leg.
//
// Two pieces the bidder needs, kept framework- and payment-provider-agnostic:
//   - mintReceiptForAccepts: once payment has cleared (the bidder gates this
//     behind whatever x402 middleware it uses), resolve the buyer's accepts.x402
//     and mint a receipts.x402 proof-of-payment pointing back at it.
//   - verifyX402Payment: when settling a market.accept, confirm its payload is a
//     receipts.x402 that THIS bidder authored — the evidence the buyer paid.
// The actual payment gating (@x402/* middleware, facilitator, scheme) stays the
// caller's concern; this library only handles the atproto record plumbing.

import type { Agent } from "@atproto/api";
import {
  atUriAuthority,
  createRemoteProofRecord,
  nsidFromUri,
  type RecordResolver,
  type RecordSigner,
  type Resolved,
  strongRef,
  stripResolved,
  type StrongRef,
  verifyRemoteProof,
} from "@publicdomainrelay/market";
import { ACCEPTS_X402_NSID, RECEIPTS_X402_NSID } from "@publicdomainrelay/lexicons";
import type { Main as AcceptsX402 } from "@publicdomainrelay/lexicons/com/publicdomainrelay/temp/market/accepts/x402.defs.ts";
import type { Main as ReceiptsX402 } from "@publicdomainrelay/lexicons/com/publicdomainrelay/temp/market/receipts/x402.defs.ts";

/** Error carrying an HTTP status, so callers can map it to their framework. */
export class X402PaymentError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "X402PaymentError";
  }
}

/**
 * Parse an `…/<accepts.x402-at-uri>/<cid>` request path into its parts. Pass the
 * route prefix to strip (e.g. `"x402/receipt/"`); leading slashes are ignored.
 * The AT-URI itself contains slashes, so the cid is taken as the last segment.
 */
export function parseReceiptPath(path: string, prefix = ""): { acceptsUri: string; acceptsCid: string } {
  let p = path.replace(/^\/+/, "");
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
  const lastSlash = p.lastIndexOf("/");
  if (lastSlash <= 0) throw new X402PaymentError(400, "missing cid");
  return { acceptsUri: p.slice(0, lastSlash), acceptsCid: p.slice(lastSlash + 1) };
}

/**
 * Mint a receipts.x402 proof-of-payment for a paid-against accepts.x402. Call
 * this only after the x402 payment has cleared. Validates the referenced record
 * is an accepts.x402, then writes the receipt to the bidder's repo. The receipt
 * is a badge.blue remote attestation proof over the accepts.x402 (its `cid`) and
 * carries the bidder's inline signature.
 */
export async function mintReceiptForAccepts(opts: {
  agent: Agent;
  resolve: RecordResolver;
  acceptsUri: string;
  acceptsCid: string;
  /** The bidder's badge.blue signer. */
  signer: RecordSigner;
}): Promise<StrongRef> {
  const { agent, resolve, acceptsUri, acceptsCid, signer } = opts;
  const acceptsX402 = await resolve.resolve<AcceptsX402>({ uri: acceptsUri, cid: acceptsCid });
  if (acceptsX402.$type && acceptsX402.$type !== ACCEPTS_X402_NSID) {
    throw new X402PaymentError(400, `expected ${ACCEPTS_X402_NSID}, got ${acceptsX402.$type}`);
  }
  return await createRemoteProofRecord(
    agent,
    RECEIPTS_X402_NSID,
    {
      $type: RECEIPTS_X402_NSID,
      accept: strongRef(acceptsUri, acceptsCid),
      createdAt: new Date().toISOString(),
    },
    {
      subjectRecord: stripResolved(acceptsX402) as Record<string, unknown>,
      subjectRepositoryDid: atUriAuthority(acceptsUri),
    },
    signer,
  );
}

/**
 * Verify a market.accept's payload is acceptable proof of x402 payment: it must
 * exist, resolve to a receipts.x402, and be authored by this bidder (so the
 * proof is one we actually minted). Returns the resolved receipt on success.
 *
 * @throws {X402PaymentError} with status 402 on any failure.
 */
export async function verifyX402Payment(opts: {
  /** The market.accept's `payload` strongRef. */
  payment: StrongRef | undefined;
  resolve: RecordResolver;
  /** This bidder's DID — the receipt must be authored by it. */
  bidderDid: string;
}): Promise<Resolved<ReceiptsX402>> {
  const { payment, resolve, bidderDid } = opts;
  if (!payment) {
    throw new X402PaymentError(402, "Accept.payload (receipts.x402 proof-of-payment) is required");
  }
  const receipt = await resolve.resolve<ReceiptsX402 & { $type?: string }>(payment);
  const nsid = receipt.$type ?? nsidFromUri(payment.uri);
  if (nsid !== RECEIPTS_X402_NSID) {
    throw new X402PaymentError(402, `Accept.payload must be a ${RECEIPTS_X402_NSID}, got ${nsid}`);
  }
  if (atUriAuthority(payment.uri) !== bidderDid) {
    throw new X402PaymentError(402, "Accept.payload proof-of-payment must be authored by this bidder");
  }
  // The receipt is a badge.blue remote attestation over the accepts.x402 it
  // references; recompute its `cid` and require it to match, so the proof can't
  // be replayed against a different (or copied) accepts.x402.
  if (receipt.accept?.uri && receipt.accept?.cid) {
    const acceptsX402 = await resolve.resolve<AcceptsX402>({ uri: receipt.accept.uri, cid: receipt.accept.cid });
    const bound = await verifyRemoteProof({
      subjectRecord: stripResolved(acceptsX402) as Record<string, unknown>,
      subjectRepositoryDid: atUriAuthority(receipt.accept.uri),
      proofRecord: stripResolved(receipt) as Record<string, unknown>,
    });
    if (!bound) {
      throw new X402PaymentError(402, "Accept.payload proof-of-payment CID does not bind to its accepts.x402");
    }
  }
  return receipt;
}
