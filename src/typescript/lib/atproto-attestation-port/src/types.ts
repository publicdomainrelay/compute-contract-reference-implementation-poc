/**
 * Core types mirroring atproto-attestation Rust crate v0.14.5.
 * Maps Rust types to TypeScript interfaces for Deno.
 */

// --- Key types (mirrors atproto-identity::key) ---

/** Supported AT Protocol key types. */
export type KeyType =
  | "P256Private"
  | "P256Public"
  | "K256Private"
  | "K256Public";

/** Runtime constants for KeyType values (for use in switch/case, comparisons). */
export const KEY_TYPE = {
  P256Private: "P256Private" as const,
  P256Public: "P256Public" as const,
  K256Private: "K256Private" as const,
  K256Public: "K256Public" as const,
} as const;

/** Parsed AT Protocol key data. */
export interface KeyData {
  /** Key type discriminator. */
  keyType: KeyType;
  /** Raw key bytes (DER or raw format per type). */
  keyBytes: Uint8Array;
  /** DID derived from this key, if resolvable. */
  did?: string;
  /** Convenience: raw public key bytes (SPKI for P-256, compressed for K-256). */
  publicKey?: Uint8Array;
  /** Convenience: raw private key bytes (PKCS8 for P-256). */
  privateKey?: Uint8Array;
}

/** Resolver trait re-exported from atproto-identity. Resolves a DID to its verification key. */
export interface KeyResolver {
  resolveKey(did: string): Promise<KeyData>;
}

// --- Record resolver (mirrors atproto-client::RecordResolver) ---

/** Resolver trait for retrieving AT Protocol records by at:// URI. */
export interface RecordResolver {
  resolve<T = unknown>(aturi: string): Promise<T>;
}

// --- JSON value (mirrors serde_json::Value) ---

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// --- CID (mirrors cid::Cid) ---

/** Content Identifier generated from DAG-CBOR serialization. */
export interface CidString {
  /** CIDv1 string representation (e.g. "bafyrei..."). */
  toString(): string;
  /** Raw CID bytes. */
  toBytes(): Uint8Array;
}

// --- Attestation metadata ---

/** Structure embedded in record's `$sig` metadata field. */
export interface AttestationMetadata {
  $type: string;
  key: string;
  sig: string; // base64url-encoded
  cid: string;
}

/** Attestation signature entry in a record. */
export interface AttestationSignature {
  $type: string;
  key: string;
  sig: string;
  cid: string;
  /** Present for remote attestation proofs. */
  proof?: string;
}

// --- LexiconType (mirrors atproto-record::LexiconType) ---

/** Marker interface for typed lexicon records. */
export interface LexiconType {
  $type: string;
}
