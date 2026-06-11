// network.attested.* signing/verification façade for market.* producers/receivers.
//
// The market lexicons require every record to carry a `signatures` array (an
// inline network.attested.signature by the author), and receipts to additionally
// be remote attestation proofs (a `cid` over their subject record). This module
// wraps @atiproto/atproto-attestation so consumers mint signed records with one
// call and verify them with another, without re-deriving the canonical-CID
// machinery themselves. Low-level primitives live in ./attest.ts.

import type { Agent } from "@atproto/api";
import {
  attestationFor,
  createDidKeyResolver,
  defaultKeyResolver,
  inlineEntries,
  toStorableEntry,
  verifyInlineAttestation,
  type AttestationKeypair,
  type InlineAttestation,
  type KeyResolver,
  type KeysForDid,
} from "./attest.ts";
import { createAttestationCid, type RecordMap } from "@atiproto/atproto-attestation";
import { createRecord } from "./records.ts";
import type { StrongRef } from "./types.ts";

export type { AttestationKeypair, KeysForDid };

/** A producer's attestation identity: the keypair it signs with + its issuer DID. */
export interface RecordSigner {
  keypair: AttestationKeypair;
  /** DID (e.g. a did:web) advertising the keypair's public half, for binding. */
  issuer?: string;
}

// A unique-symbol phantom brand. It exists only in the type system — nothing
// outside this module can name it, so nothing outside can synthesise a
// Signed<T>. The real runtime guarantee is the `signatures` array (only
// createSignedRecord attaches it); the brand makes that origin a compile-time fact.
declare const signedBrand: unique symbol;

/**
 * A record that provably carries a network.attested inline signature by its
 * author. Obtainable only from {@link createSignedRecord}. Passing an unsigned
 * record where a `Signed<T>` is required is a *compile* error — turning "you
 * can't submit what you didn't sign" into a type-level invariant.
 */
export type Signed<T extends Record<string, unknown> = Record<string, unknown>> =
  & T
  & { readonly signatures: Record<string, unknown>[] }
  & { readonly [signedBrand]: true };

/**
 * The single currency of the market.* submit flow: the exact signed body that
 * was written to the repo, paired with its `StrongRef`. The `cid` is the CID of
 * *these* bytes and `record` carries the matching `signatures`; they cannot
 * drift apart because one call produces both. Hand this straight to
 * {@link MarketClient.submitBid} / `submitEvent` — never re-assemble a
 * `{ uri, cid, record }` triple by hand from a separately-held record.
 */
export interface SignedRecord<T extends Record<string, unknown> = Record<string, unknown>> extends StrongRef {
  record: Signed<T>;
}

/** Inline-sign a record value in the agent's repo, returning the storable entry. */
async function signInline(
  record: Record<string, unknown>,
  repositoryDid: string,
  signer: RecordSigner,
): Promise<Record<string, unknown>> {
  const att = attestationFor(signer.keypair, signer.issuer);
  const entry = await att.sign({ record: record as RecordMap, repository: repositoryDid });
  return toStorableEntry(entry as InlineAttestation);
}

/**
 * Inline-sign a record (attestation over the record in the agent's own repo),
 * create it, and return the {@link SignedRecord} envelope: the ref plus the
 * *exact signed bytes* that were written. Drop-in replacement for
 * {@link createRecord} wherever the lexicon requires `signatures`.
 */
export async function createSignedRecord<T extends Record<string, unknown>>(
  agent: Agent,
  collection: string,
  record: T,
  signer: RecordSigner,
): Promise<SignedRecord<T>> {
  const existing = Array.isArray((record as Record<string, unknown>).signatures)
    ? (record as Record<string, unknown>).signatures as Record<string, unknown>[]
    : [];
  const entry = await signInline(record, agent.assertDid, signer);
  const signed = { ...record, signatures: [...existing, entry] };
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
 * canonical `cid` over `subject`, add it to `metadata`, inline-sign the proof
 * record itself, and write it to the agent's repo. Returns a strongRef to it.
 */
export async function createRemoteProofRecord(
  agent: Agent,
  collection: string,
  metadata: Record<string, unknown> & { $type: string },
  subject: RemoteProofSubject,
  signer: RecordSigner,
): Promise<StrongRef> {
  // 1. Bind: canonical CID over the subject (in the subject's repo) + this
  //    proof's metadata. Computed before the proof carries its own signature.
  const bindCid = createAttestationCid(
    subject.subjectRecord as RecordMap,
    metadata as RecordMap,
    subject.subjectRepositoryDid,
  );
  const value: Record<string, unknown> = { ...metadata, cid: bindCid.toString() };
  // 2. Inline-sign the proof record itself in the agent's repo.
  const entry = await signInline(value, agent.assertDid, signer);
  const signed = { ...value, signatures: [entry] };
  return createRecord(agent, collection, signed);
}

export interface VerifyRecordSignaturesOptions {
  /** The bare record carrying the `signatures` array (strip `_uri`/`_cid` first). */
  record: Record<string, unknown>;
  /** DID of the repository the record actually lives in (its author). */
  repositoryDid: string;
  /**
   * Optional DID-document key binding: when supplied, an inline entry only counts
   * if its `key` is published by the entry's `issuer` (or the record author) DID
   * document. Build one with {@link createDidKeyResolver}.
   */
  keysForDid?: KeysForDid;
  /** Override the public-key resolver (did:key/web/plc). Defaults to a cached fetch resolver. */
  keyResolver?: KeyResolver;
}

/**
 * Verify a record carries at least one valid inline network.attested signature
 * by its author. Recomputes the canonical attestation CID for the record in
 * `repositoryDid` and verifies the ECDSA signature; when `keysForDid` is given,
 * additionally binds the signing did:key to the issuer/author DID document.
 * Never throws.
 */
export async function verifyRecordSignatures(
  opts: VerifyRecordSignaturesOptions,
): Promise<boolean> {
  const resolver = opts.keyResolver ?? defaultKeyResolver;
  for (const entry of inlineEntries(opts.record)) {
    const ok = await verifyInlineAttestation({
      record: opts.record,
      entry,
      repositoryDid: opts.repositoryDid,
      keyResolver: resolver,
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
