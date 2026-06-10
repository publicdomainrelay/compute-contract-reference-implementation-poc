// badge.blue CID generation (https://badge.blue §3).
//
// The attestation CID is the signing payload for inline attestations and the
// binding reference for remote ones. Given a record, a metadata object, and the
// DID of the repository housing the record:
//
//   1. strip the `signatures` array from the record
//   2. strip `cid` / `signature` from the metadata (we also strip `signatures`,
//      so a proof record that is itself inline-signed stays verifiable)
//   3. add `repository` = the repo DID to the metadata
//   4. insert the metadata into the record as `$sig`
//   5. DAG-CBOR encode (deterministic), SHA-256, wrap as CIDv1 (dag-cbor codec)
//
// The repository binding is the spec's replay-attack defense: the same record
// in a different repo produces a different CID, invalidating every signature.

import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { base64ToBytes } from "./bytes.ts";

/**
 * Convert a record from atproto JSON to the IPLD data model so DAG-CBOR
 * serialization matches what a CBOR-native implementation produces:
 * `{ "$bytes": … }` becomes raw bytes and `{ "$link": … }` becomes a CID.
 * Uint8Array / CID values pass through, `undefined` properties are dropped.
 */
export function jsonToIpld(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array || CID.asCID(value)) return value;
  if (Array.isArray(value)) return value.map(jsonToIpld);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj.$bytes === "string") return base64ToBytes(obj.$bytes);
  if (keys.length === 1 && typeof obj.$link === "string") return CID.parse(obj.$link);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = jsonToIpld(v);
  }
  return out;
}

export interface AttestationCidInput {
  /** The record being attested (its `signatures` array is ignored). */
  record: Record<string, unknown>;
  /**
   * Attestation metadata — must carry `$type`; `cid`, `signature`, and
   * `signatures` are stripped before insertion as `$sig`.
   */
  metadata: Record<string, unknown>;
  /** DID of the repository housing the record (its author). */
  repositoryDid: string;
}

/** Compute the badge.blue attestation CID (CIDv1, dag-cbor codec, SHA-256). */
export async function computeAttestationCid(
  input: AttestationCidInput,
): Promise<CID> {
  const { signatures: _sigs, $sig: _stale, ...bare } = input.record;
  const { cid: _cid, signature: _sig, signatures: _metaSigs, ...meta } = input.metadata;
  const payload = { ...bare, $sig: { ...meta, repository: input.repositoryDid } };
  const bytes = dagCbor.encode(jsonToIpld(payload));
  const digest = await sha256.digest(bytes);
  return CID.createV1(dagCbor.code, digest);
}

export { CID };
