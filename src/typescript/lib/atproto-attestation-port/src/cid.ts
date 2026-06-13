import type { JsonValue, JsonObject } from "./types.ts";
import { DagCborError } from "./errors.ts";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats";
import { sha256 } from "multiformats/hashes/sha2";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary value as DAG-CBOR and return its CIDv1 object
 * (dag-cbor codec 0x71, SHA-256 multihash).
 */
async function encodeToCid(value: unknown): Promise<CID> {
  let encoded: Uint8Array;
  try {
    encoded = dagCbor.encode(value);
  } catch (err) {
    throw new DagCborError(
      `DAG-CBOR encode failed: ${(err as Error).message}`,
    );
  }

  let multihash;
  try {
    multihash = await sha256.digest(encoded);
  } catch (err) {
    throw new DagCborError(
      `SHA-256 hashing failed: ${(err as Error).message}`,
    );
  }

  return CID.create(1, 0x71, multihash);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a DAG-CBOR CIDv1 (base32) for an arbitrary JSON-compatible value.
 *
 * Algorithm:
 *  1. Encode `value` with DAG-CBOR.
 *  2. SHA-256 hash the encoded bytes.
 *  3. Build a CIDv1 with dag-cbor codec (0x71).
 *  4. Return the base32-encoded CID string.
 */
export async function createDagCborCid(value: JsonValue): Promise<string> {
  const cid = await encodeToCid(value);
  return cid.toString();
}

/**
 * Create an attestation CID that binds a record, metadata, and repository DID.
 *
 * The implementation mirrors the Rust `atproto_attestation::cid::create_attestation_cid`:
 *  1. Compute a DAG-CBOR CID for `record` alone.
 *  2. Embed that CID (as an IPLD link) alongside `metadata` and `repository`
 *     in a DAG-CBOR array: `[recordCid, metadata, repository]`.
 *  3. Compute and return the CID of that combined structure.
 */
export async function createAttestationCid(
  record: JsonObject,
  metadata: JsonObject,
  repository: string,
): Promise<string> {
  // CID of the record alone (IPLD link, not a string)
  const recordCid = await encodeToCid(record);

  // Combined structure: record CID link, metadata object, repo DID string.
  // DAG-CBOR encoding will serialise the CID object as CBOR tag 42.
  const combined: [CID, JsonObject, string] = [recordCid, metadata, repository];
  const attestationCid = await encodeToCid(combined);
  return attestationCid.toString();
}

/**
 * Validate that `value` produces the expected DAG-CBOR CID.
 *
 * Recomputes the CID from the supplied value and throws `DagCborError` on
 * mismatch.
 */
export async function validateDagCborCid(
  value: JsonObject,
  expectedCid: string,
): Promise<void> {
  const computed = await createDagCborCid(value as JsonValue);
  if (computed !== expectedCid) {
    throw new DagCborError(
      `CID mismatch: expected "${expectedCid}", got "${computed}"`,
    );
  }
}
