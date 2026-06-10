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

// A unique-symbol phantom brand. It exists only in the type system — nothing
// outside this module can name it, so nothing outside can synthesise a
// Signed<T>. The real runtime guarantee is the `signatures` array (only
// signRecord attaches it); the brand makes that origin a compile-time fact.
declare const signedBrand: unique symbol;

/**
 * A record that provably carries a badge.blue inline attestation by its author.
 * Obtainable only from {@link signRecord} / {@link createSignedRecord}. Passing
 * an unsigned record where a `Signed<T>` is required is a *compile* error — this
 * is what turns "you can't submit what you didn't sign" into a type-level
 * invariant instead of a convention the receiver enforces a network hop later.
 */
export type Signed<T extends Record<string, unknown> = Record<string, unknown>> =
  & T
  & { readonly signatures: InlineAttestation[] }
  & { readonly [signedBrand]: true };

/**
 * The single currency of the market.* submit flow: the exact signed body that
 * was written to the repo, paired with its `StrongRef`. The `cid` is the CID of
 * *these* bytes and `record` carries the matching `signatures`; they cannot
 * drift apart because one call produces both. Hand this straight to
 * {@link MarketClient.submitBid} / `submitEvent` — never re-assemble a
 * `{ uri, cid, record }` triple by hand from a separately-held record, which is
 * exactly how the unsigned body used to leak onto the wire.
 */
export interface SignedRecord<T extends Record<string, unknown> = Record<string, unknown>> extends StrongRef {
  record: Signed<T>;
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
 * own repo), create it, and return the {@link SignedRecord} envelope: the ref
 * plus the *exact signed bytes* that were written. The drop-in replacement for
 * {@link createRecord} wherever the lexicon requires `signatures`.
 */
export async function createSignedRecord<T extends Record<string, unknown>>(
  agent: Agent,
  collection: string,
  record: T,
  signer: RecordSigner,
): Promise<SignedRecord<T>> {
  const signed = await signRecord({
    record,
    metadata: inlineMetadata(signer),
    repositoryDid: agent.assertDid,
    keypair: signer.keypair,
  });
  const ref = await createRecord(agent, collection, signed);
  // The envelope binds the ref to the very bytes we signed and wrote, so any
  // caller that forwards `record` transmits the attested copy by construction.
  return { uri: ref.uri, cid: ref.cid, record: signed as unknown as Signed<T> };
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
