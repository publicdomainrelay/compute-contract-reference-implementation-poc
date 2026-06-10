// badge.blue inline attestations (https://badge.blue §5, §8).
//
// An inline attestation embeds ECDSA signature bytes directly in the record's
// `signatures` array. The signer computes the attestation CID and signs the CID
// bytes; @atproto/crypto keypairs produce low-S compact signatures and
// verifySignature rejects malleable (high-S) ones, satisfying the spec's
// normalization requirement. Supported curves: P-256 and K-256 did:keys.

import { verifySignature } from "@atproto/crypto";
import { asBytes, bytesToBase64, type BytesJson } from "./bytes.ts";
import { computeAttestationCid } from "./cid.ts";
import type { AttestationKeypair } from "./types.ts";

/** An inline attestation entry as stored in a record's `signatures` array. */
export interface InlineAttestation extends Record<string, unknown> {
  /** Attestation type identifier, e.g. `…market.attestation#inline`. */
  $type: string;
  /** did:key public-key reference used to verify the signature. */
  key: string;
  /** The computed attestation CID (base32 CIDv1 string). */
  cid: string;
  /** Signature over the CID bytes (raw, or atproto JSON `{ $bytes }`). */
  signature: Uint8Array | BytesJson;
  /** DID of the signing party (e.g. a service's did:web). */
  issuer?: string;
  issuedAt?: string;
}

export interface SignInlineOptions {
  /** The record to attest (existing `signatures` are left untouched). */
  record: Record<string, unknown>;
  /**
   * Attestation metadata: `$type` is required; `key` defaults to the keypair's
   * did:key; extra fields (issuer, issuedAt, purpose, …) are preserved and
   * included in CID calculation.
   */
  metadata: Record<string, unknown> & { $type: string };
  /** DID of the repository the record will live in (its author). */
  repositoryDid: string;
  keypair: AttestationKeypair;
}

/** Compute the attestation CID and sign it, returning the inline entry. */
export async function createInlineAttestation(
  opts: SignInlineOptions,
): Promise<InlineAttestation> {
  const key = (opts.metadata.key as string | undefined) ?? opts.keypair.did();
  const metadata = { ...opts.metadata, key };
  const cid = await computeAttestationCid({
    record: opts.record,
    metadata,
    repositoryDid: opts.repositoryDid,
  });
  const sig = await opts.keypair.sign(cid.bytes);
  return {
    ...metadata,
    cid: cid.toString(),
    signature: { $bytes: bytesToBase64(sig) },
  } as InlineAttestation;
}

/** Append an attestation entry to a record's `signatures` array (immutably). */
export function attachSignature<T extends Record<string, unknown>>(
  record: T,
  entry: Record<string, unknown>,
): T {
  const existing = Array.isArray(record.signatures) ? record.signatures : [];
  return { ...record, signatures: [...existing, entry] };
}

/** Sign a record inline and return it with the entry attached. */
export async function signRecord<T extends Record<string, unknown>>(
  opts: SignInlineOptions & { record: T },
): Promise<T> {
  const entry = await createInlineAttestation(opts);
  return attachSignature(opts.record, entry);
}

export interface VerifyInlineOptions {
  /** The record carrying the entry (its `signatures` array is ignored). */
  record: Record<string, unknown>;
  entry: InlineAttestation;
  /** DID of the repository the record actually lives in. */
  repositoryDid: string;
}

/**
 * Verify an inline attestation: rebuild the metadata from the entry, recompute
 * the attestation CID for the record in `repositoryDid`, require it to match
 * the entry's `cid`, then verify the ECDSA signature over the CID bytes with
 * the entry's did:key. Returns false (never throws) on any mismatch.
 */
export async function verifyInlineAttestation(
  opts: VerifyInlineOptions,
): Promise<boolean> {
  try {
    const cid = await computeAttestationCid({
      record: opts.record,
      metadata: opts.entry,
      repositoryDid: opts.repositoryDid,
    });
    if (cid.toString() !== opts.entry.cid) return false;
    return await verifySignature(opts.entry.key, cid.bytes, asBytes(opts.entry.signature));
  } catch {
    return false;
  }
}
