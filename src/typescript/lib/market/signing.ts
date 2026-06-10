// badge.blue signing/verification facade for market.* producers and receivers.
//
// The market lexicons require every record to carry a `signatures` array (an
// inline badge.blue attestation by the author), and receipts to additionally be
// remote attestation proofs (a `cid` over their subject record). This module
// wraps @publicdomainrelay/attestation so consumers mint signed records with one
// call and verify them with another, without re-deriving the badge.blue CID
// machinery themselves.

import type { Agent } from "@atproto/api";
import {
  createRemoteProof,
  type InlineAttestation,
  type AttestationKeypair,
  type KeysForDid,
  signRecord,
  verifyInlineAttestation,
} from "@publicdomainrelay/attestation";
import { ATTESTATION_INLINE_TYPE } from "@publicdomainrelay/lexicons";
import { createRecord } from "./records.ts";
import type { StrongRef } from "./types.ts";

/** A producer's attestation identity: the keypair it signs with + its issuer DID. */
export interface RecordSigner {
  keypair: AttestationKeypair;
  /** DID (e.g. a did:web) advertising the keypair's public half, for binding. */
  issuer?: string;
}

function inlineMetadata(signer: RecordSigner): Record<string, unknown> & { $type: string } {
  return {
    $type: ATTESTATION_INLINE_TYPE,
    ...(signer.issuer ? { issuer: signer.issuer } : {}),
    issuedAt: new Date().toISOString(),
  };
}

/**
 * Inline-sign a record (badge.blue attestation over the record in the agent's
 * own repo) and create it. The drop-in replacement for {@link createRecord}
 * wherever the lexicon requires `signatures`.
 */
export async function createSignedRecord(
  agent: Agent,
  collection: string,
  record: Record<string, unknown>,
  signer: RecordSigner,
): Promise<StrongRef & { record: Record<string, unknown> }> {
  const signed = await signRecord({
    record,
    metadata: inlineMetadata(signer),
    repositoryDid: agent.assertDid,
    keypair: signer.keypair,
  });
  const ref = await createRecord(agent, collection, signed);
  // Return the signed body (carrying `signatures`) so callers that forward the
  // record over the wire (e.g. proxied submitBid) transmit the attested copy,
  // not the unsigned input.
  return { ...ref, record: signed };
}

/** The subject a remote attestation proof binds to. */
export interface RemoteProofSubject {
  /** The record being attested (its `signatures` array is ignored). */
  subjectRecord: Record<string, unknown>;
  /** DID of the repository the subject record lives in (its author). */
  subjectRepositoryDid: string;
}

/**
 * Create a remote attestation proof record (e.g. a receipt): compute the
 * badge.blue `cid` over `subject`, add it to `metadata`, inline-sign the proof
 * record itself, and write it to the agent's repo. Returns a strongRef to it.
 */
export async function createRemoteProofRecord(
  agent: Agent,
  collection: string,
  metadata: Record<string, unknown> & { $type: string },
  subject: RemoteProofSubject,
  signer: RecordSigner,
): Promise<StrongRef> {
  const { value } = await createRemoteProof({
    subjectRecord: subject.subjectRecord,
    subjectRepositoryDid: subject.subjectRepositoryDid,
    metadata,
  });
  const signed = await signRecord({
    record: value,
    metadata: inlineMetadata(signer),
    repositoryDid: agent.assertDid,
    keypair: signer.keypair,
  });
  return createRecord(agent, collection, signed);
}

function isInlineAttestation(v: unknown): v is InlineAttestation {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.key === "string" && typeof o.cid === "string" && o.signature != null;
}

export interface VerifyRecordSignaturesOptions {
  /** The record carrying the `signatures` array. */
  record: Record<string, unknown>;
  /** DID of the repository the record actually lives in (its author). */
  repositoryDid: string;
  /**
   * Optional did:key binding: when supplied, an inline entry only counts if its
   * `key` is vouched for by the entry's `issuer` (or the record author) DID
   * document. Build one with createDidKeyResolver(idResolver).
   */
  keysForDid?: KeysForDid;
}

/**
 * Verify a record carries at least one valid inline badge.blue attestation by
 * its author. Recomputes the attestation CID for the record in `repositoryDid`
 * and verifies the ECDSA signature; when `keysForDid` is given, additionally
 * binds the signing did:key to the issuer/author DID. Never throws.
 */
export async function verifyRecordSignatures(
  opts: VerifyRecordSignaturesOptions,
): Promise<boolean> {
  const sigs = Array.isArray(opts.record.signatures) ? opts.record.signatures : [];
  const inlines = sigs.filter(isInlineAttestation);
  for (const entry of inlines) {
    const ok = await verifyInlineAttestation({
      record: opts.record,
      entry,
      repositoryDid: opts.repositoryDid,
    });
    if (!ok) continue;
    if (opts.keysForDid) {
      const allowed = await opts.keysForDid(entry.issuer ?? opts.repositoryDid);
      if (!allowed.includes(entry.key)) continue;
    }
    return true;
  }
  return false;
}
