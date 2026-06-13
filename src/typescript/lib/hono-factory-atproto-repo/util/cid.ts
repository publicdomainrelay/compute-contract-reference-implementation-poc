// @publicdomainrelay/hono-factory-atproto-repo — CIDv1 helpers
//
// CIDv1: <version:1><codec:1><mh-type:1><mh-len:1><digest:32>
// String form: multibase "b" + base32-lowercase (atproto convention).

import type { Bytes, Cid } from "../contracts.ts";
import { base32Encode, base32Decode, concat, bytesEqual } from "./bytes.ts";

// ── constants ─────────────────────────────────────────────────────

/** dag-cbor multicodec */
export const DAG_CBOR_CODEC = 0x71;
/** sha2-256 multihash type */
export const SHA256_CODE = 0x12;
/** sha2-256 digest length in bytes */
export const SHA256_DIGEST_LEN = 32;

const CIDv1_HEADER_LEN = 4; // version + codec + mh-type + mh-len
const CIDv1_BYTES_LEN = CIDv1_HEADER_LEN + SHA256_DIGEST_LEN; // 36

// ── construction ──────────────────────────────────────────────────

/** Build a CIDv1 (dag-cbor, sha2-256) from a raw sha256 digest. */
export function cidFromDigest(digest: Bytes): Cid {
  if (digest.length !== SHA256_DIGEST_LEN) {
    throw new Error(`cidFromDigest: digest must be 32 bytes, got ${digest.length}`);
  }
  const cidBytes = new Uint8Array(CIDv1_BYTES_LEN);
  cidBytes[0] = 0x01; // CIDv1
  cidBytes[1] = DAG_CBOR_CODEC; // dag-cbor
  cidBytes[2] = SHA256_CODE; // sha2-256
  cidBytes[3] = SHA256_DIGEST_LEN; // 32 bytes
  cidBytes.set(digest, CIDv1_HEADER_LEN);
  return "b" + base32Encode(cidBytes);
}

/** Parse a CIDv1 string into its raw bytes. */
export function cidToBytes(cid: Cid): Bytes {
  if (!cid.startsWith("b")) {
    throw new Error(`cidToBytes: CID must start with 'b' (multibase base32), got '${cid[0] ?? ""}'`);
  }
  return base32Decode(cid.slice(1));
}

/** Extract the sha256 digest bytes from a CID. */
export function cidDigest(cid: Cid): Bytes {
  const raw = cidToBytes(cid);
  if (raw.length < CIDv1_BYTES_LEN) {
    throw new Error(`cidDigest: CID too short (${raw.length} bytes, expected ${CIDv1_BYTES_LEN})`);
  }
  if (raw[0] !== 0x01) throw new Error("cidDigest: not CIDv1");
  if (raw[1] !== DAG_CBOR_CODEC) throw new Error("cidDigest: not dag-cbor");
  if (raw[2] !== SHA256_CODE) throw new Error("cidDigest: not sha2-256");
  return raw.slice(CIDv1_HEADER_LEN, CIDv1_HEADER_LEN + SHA256_DIGEST_LEN);
}

/** Validate a CID string form. */
export function isValidCid(s: string): s is Cid {
  try {
    const raw = cidToBytes(s);
    return raw.length === CIDv1_BYTES_LEN &&
      raw[0] === 0x01 &&
      raw[1] === DAG_CBOR_CODEC &&
      raw[2] === SHA256_CODE &&
      raw[3] === SHA256_DIGEST_LEN;
  } catch {
    return false;
  }
}

/** Compare two CIDs for equality. */
export function cidEquals(a: Cid, b: Cid): boolean {
  return bytesEqual(cidToBytes(a), cidToBytes(b));
}
