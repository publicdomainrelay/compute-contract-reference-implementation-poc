// badge.blue remote attestations (https://badge.blue §6, §8).
//
// A remote attestation is a separate proof record in the attestor's repository:
// the attestation metadata plus the computed attestation CID. The subject
// record references the proof via com.atproto.repo.strongRef (or, as with the
// market receipts.*, the proof record references the subject and is itself
// handed back by strongRef). Verification recomputes the CID from the subject
// record + the proof's metadata + the subject's repository DID and requires it
// to match the proof's `cid` — so a proof cannot be replayed against a copy of
// the subject in another repository.

import { computeAttestationCid, type CID } from "./cid.ts";

export interface CreateRemoteProofOptions {
  /** The record being attested (its `signatures` array is ignored). */
  subjectRecord: Record<string, unknown>;
  /** DID of the repository the subject record lives in (its author). */
  subjectRepositoryDid: string;
  /**
   * The proof record's fields: `$type` plus whatever the proof carries
   * (issuer, purpose, subject/accept strongRefs, createdAt, …). All of it is
   * attestation metadata and participates in CID calculation.
   */
  metadata: Record<string, unknown> & { $type: string };
}

/**
 * Build a remote attestation proof record value: the metadata with the
 * computed attestation CID added as `cid`. The caller writes it to the
 * attestor's repository (and may inline-sign it first via signRecord).
 */
export async function createRemoteProof(
  opts: CreateRemoteProofOptions,
): Promise<{ value: Record<string, unknown>; attestationCid: CID }> {
  const attestationCid = await computeAttestationCid({
    record: opts.subjectRecord,
    metadata: opts.metadata,
    repositoryDid: opts.subjectRepositoryDid,
  });
  return {
    value: { ...opts.metadata, cid: attestationCid.toString() },
    attestationCid,
  };
}

export interface VerifyRemoteProofOptions {
  subjectRecord: Record<string, unknown>;
  /** DID of the repository the subject record actually lives in. */
  subjectRepositoryDid: string;
  /** The fetched proof record (e.g. a market.attestation or receipts.*). */
  proofRecord: Record<string, unknown>;
}

/**
 * Verify a remote attestation proof: rebuild the metadata from the proof
 * record (strip `cid`/`signature`/`signatures`), recompute the attestation CID
 * for the subject in its repository, and require it to match the proof's
 * `cid`. Returns false (never throws) on any mismatch.
 */
export async function verifyRemoteProof(
  opts: VerifyRemoteProofOptions,
): Promise<boolean> {
  const declared = opts.proofRecord.cid;
  if (typeof declared !== "string") return false;
  try {
    const cid = await computeAttestationCid({
      record: opts.subjectRecord,
      metadata: opts.proofRecord,
      repositoryDid: opts.subjectRepositoryDid,
    });
    return cid.toString() === declared;
  } catch {
    return false;
  }
}
