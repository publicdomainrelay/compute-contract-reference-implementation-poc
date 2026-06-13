// Low-level attestation primitives for market.* records, on @atiproto/*.
//
// This is the network.attested.* vocabulary implemented by the maintained
// @atiproto/atproto-attestation (sign/verify over a canonical DAG-CBOR CID) and
// @atiproto/key-resolver (did:key / did:web / did:plc public-key resolution).
// It replaces the repo's former hand-rolled @publicdomainrelay/attestation and
// the write-only badgeBlueKey PDS registry: a signer's public key is discovered
// by fetching its DID document (the createFetchKeyResolver way), not a side record.
//
// The market signing façade (./signing.ts) builds on these; consumers keep using
// the façade unchanged.

import { Secp256k1Keypair } from "@atproto/crypto";
import {
  Attestation,
  createAttestationCid,
  verifyBytes,
  type InlineAttestation,
  type KeyData,
  type RecordMap,
} from "@atiproto/atproto-attestation";
import {
  createCachedKeyResolver,
  createDidDocumentFetcher,
  type KeyResolver,
} from "@atiproto/key-resolver";

export type { InlineAttestation, KeyData, KeyResolver };

// ---------------------------------------------------------------------------
// bytes helpers — atproto stores `bytes` lexicon fields as { "$bytes": base64 };
// @atiproto signs/verifies over raw Uint8Array. These bridge the two forms.
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Accept a signature as raw bytes, atproto JSON `{ $bytes }`, or base64. */
export function normalizeSignature(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object" && typeof (value as { $bytes?: unknown }).$bytes === "string") {
    return base64ToBytes((value as { $bytes: string }).$bytes);
  }
  if (typeof value === "string") return base64ToBytes(value);
  return undefined;
}

/**
 * Normalize an inline attestation entry for storage: @atiproto returns the
 * signature as a `Uint8Array`; atproto record JSON wants `{ $bytes }`.
 */
export function toStorableEntry(entry: InlineAttestation): Record<string, unknown> {
  const sig = entry.signature instanceof Uint8Array ? entry.signature : normalizeSignature(entry.signature);
  return { ...entry, signature: sig ? { $bytes: bytesToBase64(sig) } : entry.signature };
}

// ---------------------------------------------------------------------------
// keypairs + signer identity
// ---------------------------------------------------------------------------

/**
 * A signing identity: a secp256k1 (k256) private key plus the did:key that
 * verifies it. Constructed from a hex private key (stable identity) or freshly
 * generated (ephemeral — does not survive restarts and is not in any DID doc).
 */
export interface AttestationKeypair {
  /** did:key public-key reference for the verification side. */
  did(): string;
  /** Private key material handed to @atiproto's Attestation. */
  privateKey: KeyData;
}

/**
 * Load a k256 keypair from a hex-encoded private key (e.g.
 * `Deno.env.get("ATTESTATION_PRIVATE_KEY_HEX")`), or generate a fresh one when
 * absent. Generated keys do not survive restarts, so persist the hex for a
 * stable, bindable identity.
 */
export async function loadOrGenerateKeypair(privKeyHex?: string): Promise<AttestationKeypair> {
  let bytes: Uint8Array;
  if (privKeyHex) {
    bytes = hexToBytes(privKeyHex);
  } else {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    bytes = await kp.export();
  }
  // KeyData from @atiproto/key-resolver doesn't declare toBytes, but the
  // attestation library's signBytes calls keyBytes.toBytes() on the unwrapped
  // key. Without it, @noble/curves >=1.8 fails with "sig.toBytes is not a
  // function" because the internal key wrapper tries to call .toBytes() on the
  // raw KeyData object.
  const privateKey = { type: "k256" as const, bytes, toBytes: () => bytes };
  // Attestation derives + validates the public did:key from the private key.
  const did = new Attestation({ privateKey }).publicKey;
  return { did: () => did, privateKey };
}

/** Build an @atiproto Attestation signer from a keypair (+ optional issuer DID). */
export function attestationFor(keypair: AttestationKeypair, issuer?: string): Attestation {
  return new Attestation({ privateKey: keypair.privateKey, issuer });
}

/**
 * The Multikey verificationMethod a service publishes in its did:web document so
 * verifiers can bind its attestation did:key to that DID (the createFetchKeyResolver
 * resolution path). `publicKeyMultibase` is the did:key without its `did:key:` prefix.
 */
export function attestationVerificationMethod(
  controller: string,
  keypairDid: string,
  fragment = "attestation",
): { id: string; type: "Multikey"; controller: string; publicKeyMultibase: string } {
  return {
    id: `${controller}#${fragment}`,
    type: "Multikey",
    controller,
    publicKeyMultibase: keypairDid.replace(/^did:key:/, ""),
  };
}

// ---------------------------------------------------------------------------
// key resolution + DID-document key binding
// ---------------------------------------------------------------------------

/** A reusable resolver: did:key parsed locally; did:web/did:plc fetched + cached. */
export const defaultKeyResolver: KeyResolver = createCachedKeyResolver();

/** Resolve the did:keys a DID's document vouches for (for author/issuer binding). */
export type KeysForDid = (did: string) => Promise<string[]>;

/**
 * Build a {@link KeysForDid} backed by @atiproto/key-resolver's DID-document
 * fetcher (did:web `/.well-known/did.json`, did:plc via the PLC directory). It
 * lists every verificationMethod's key as a did:key, so a verifier can require
 * an inline signature's `key` to be published by the signing party's DID — the
 * createFetchKeyResolver way, with no PDS-side key registry record.
 */
export function createDidKeyResolver(opts?: { plcUrl?: string; timeout?: number }): KeysForDid {
  const fetchDoc = createDidDocumentFetcher(opts);
  const cache = new Map<string, string[]>();
  return async (did: string): Promise<string[]> => {
    const cached = cache.get(did);
    if (cached) return cached;
    let keys: string[] = [];
    try {
      const doc = await fetchDoc(did);
      keys = (doc.verificationMethod ?? [])
        .map((vm) => (typeof vm.publicKeyMultibase === "string" ? `did:key:${vm.publicKeyMultibase}` : null))
        .filter((k): k is string => k !== null);
    } catch {
      keys = [];
    }
    cache.set(did, keys);
    return keys;
  };
}

// ---------------------------------------------------------------------------
// inline + remote verification
// ---------------------------------------------------------------------------

function isInlineEntry(v: unknown): v is InlineAttestation {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.key === "string" && o.signature != null && (o as { uri?: unknown }).uri === undefined;
}

/** The inline entries in a record's `signatures` array. */
export function inlineEntries(record: Record<string, unknown>): InlineAttestation[] {
  const sigs = Array.isArray(record.signatures) ? record.signatures : [];
  return sigs.filter(isInlineEntry);
}

export interface VerifyInlineOptions {
  /** The bare record carrying the entry (strip `_uri`/`_cid` first). */
  record: Record<string, unknown>;
  entry: InlineAttestation;
  /** DID of the repository the record lives in (its author). */
  repositoryDid: string;
  keyResolver?: KeyResolver;
}

/**
 * Verify one inline attestation: recompute the canonical attestation CID for the
 * record in `repositoryDid`, require it to match the entry's `cid`, then verify
 * the ECDSA signature over the CID bytes with the key resolved from the entry's
 * `key`. Never throws.
 */
export async function verifyInlineAttestation(opts: VerifyInlineOptions): Promise<boolean> {
  try {
    const sig = normalizeSignature(opts.entry.signature);
    if (!sig || typeof opts.entry.key !== "string") return false;
    const cid = createAttestationCid(opts.record as RecordMap, opts.entry as RecordMap, opts.repositoryDid);
    if (typeof opts.entry.cid === "string" && opts.entry.cid !== cid.toString()) return false;
    const resolver = opts.keyResolver ?? defaultKeyResolver;
    const keyData = await resolver(opts.entry.key);
    return verifyBytes(cid.bytes, sig, keyData);
  } catch {
    return false;
  }
}

export interface VerifyRemoteProofOptions {
  /** The record being attested (its `signatures` array is ignored). */
  subjectRecord: Record<string, unknown>;
  /** DID of the repository the subject record actually lives in. */
  subjectRepositoryDid: string;
  /** The fetched proof record (e.g. a receipts.* record). */
  proofRecord: Record<string, unknown>;
}

/**
 * Verify a remote attestation proof: strip `cid`/`signature`/`signatures` from
 * the proof record, recompute the canonical attestation CID over the subject in
 * its repository with that metadata, and require it to match the proof's `cid`.
 * Re-binding the proof to a copy of the subject in another repo fails. Never throws.
 */
export function verifyRemoteProof(opts: VerifyRemoteProofOptions): boolean {
  const declared = opts.proofRecord.cid;
  if (typeof declared !== "string") return false;
  try {
    const { cid: _c, signature: _s, signatures: _sg, ...metadata } = opts.proofRecord;
    const cid = createAttestationCid(
      opts.subjectRecord as RecordMap,
      metadata as RecordMap,
      opts.subjectRepositoryDid,
    );
    return cid.toString() === declared;
  } catch {
    return false;
  }
}
