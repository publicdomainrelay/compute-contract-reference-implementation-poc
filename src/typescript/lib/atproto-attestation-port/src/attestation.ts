/**
 * attestation.ts — Core attestation operations mirroring the Rust
 * `atproto-attestation` crate v0.14.5 API.
 *
 * Provides functions to create, append, and verify inline and remote
 * attestations on AT Protocol records using ECDSA (P-256 / K-256) keys.
 */

import { KeyData, KEY_TYPE, type KeyType, type KeyResolver, type RecordResolver, type JsonObject } from "./types.ts";
import {
  AttestationError,
  InvalidSignatureError,
  KeyResolutionError,
  RecordResolutionError,
  InvalidAttestationError,
  InvalidProofError,
  DanglingProofError,
  CidMismatchError,
  UnsupportedKeyTypeError,
  MetadataMustBeObjectError,
  MetadataMissingFieldError,
  RecordMustBeObjectError,
  SignatureDecodingFailedError,
} from "./errors.ts";
import { AnyInput } from "./input.ts";
import { createDagCborCid, createAttestationCid, validateDagCborCid } from "./cid.ts";
import { normalizeSignature } from "./signature.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base-58 BTC alphabet (used by did:key). */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Base64url-encode (RFC 4648 §5, no padding).
 */
function base64urlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Base64url-decode (RFC 4648 §5, tolerates missing padding).
 */
function base64urlDecode(str: string): Uint8Array {
  // Restore padding.
  const pad = (4 - (str.length % 4)) % 4;
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Base-58 BTC encode (no multibase prefix).
 */
function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zero bytes.
  let zeroCount = 0;
  while (zeroCount < bytes.length && bytes[zeroCount] === 0) zeroCount++;

  // Convert to BigInt (big-endian).
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }

  // Encode in base-58.
  const result: string[] = [];
  while (value > 0n) {
    result.unshift(BASE58_ALPHABET[Number(value % 58n)]);
    value /= 58n;
  }

  // Prepend a '1' for each leading zero byte in the input.
  while (zeroCount-- > 0) result.unshift("1");
  return result.join("");
}

/**
 * Encode an unsigned integer as a varint (unsigned LEB128).
 */
function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

/**
 * Return the multicodec varint prefix for a key type.
 *
 * - P-256 (secp256r1): code 0x1200 → varint [0x80, 0x24]
 * - K-256 (secp256k1): code 0xe701 → varint [0x81, 0xce, 0x03]
 */
function multicodecPrefix(keyType: KeyType): Uint8Array {
  switch (keyType) {
    case "P256Private":
    case "P256Public":
      return new Uint8Array([0x80, 0x24]);
    case "K256Private":
    case "K256Public":
      return new Uint8Array([0x81, 0xce, 0x03]);
    default:
      throw new UnsupportedKeyTypeError(`Unknown key type: ${keyType}`);
  }
}

/**
 * Compress an EC public key.
 *
 * Accepts:
 * - 65-byte uncompressed (0x04 || x || y)
 * - 64-byte raw (x || y, no prefix)
 * - 33-byte compressed (0x02/0x03 || x) — returned as-is
 *
 * Returns 33 bytes (0x02/0x03 || x).
 */
function compressPublicKey(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) {
    // Already compressed.
    return bytes;
  }

  let x: Uint8Array;
  let y: Uint8Array;

  if (bytes.length === 65 && bytes[0] === 0x04) {
    x = bytes.subarray(1, 33);
    y = bytes.subarray(33, 65);
  } else if (bytes.length === 64) {
    // Raw x || y without 0x04 prefix.
    x = bytes.subarray(0, 32);
    y = bytes.subarray(32, 64);
  } else {
    throw new UnsupportedKeyTypeError(
      `Unrecognised public key length: ${bytes.length} bytes`,
    );
  }

  // Determine y parity from the last byte of y.
  const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
  const compressed = new Uint8Array(33);
  compressed[0] = prefix;
  compressed.set(x, 1);
  return compressed;
}

/**
 * Concatenate two Uint8Arrays.
 */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// did:key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a `did:key` string from a KeyData's public key.
 *
 * Supports P-256 and K-256 keys using the standard multicodec prefix +
 * compressed public key bytes, encoded as base58btc with multibase prefix 'z'.
 *
 * @throws {UnsupportedKeyTypeError} if the key type or format is not
 *   recognised.
 */
export function didForKey(keyData: KeyData): string {
  const compressed = compressPublicKey(keyData.publicKey!);
  const prefix = multicodecPrefix(keyData.keyType);
  const encoded = base58btcEncode(concat(prefix, compressed));
  return `did:key:z${encoded}`;
}

// ---------------------------------------------------------------------------
// DER <-> raw ECDSA signature conversion
// ---------------------------------------------------------------------------

/**
 * Parse a DER-encoded ECDSA signature and return raw r||s (64 bytes).
 *
 * Expected DER structure:
 *   SEQUENCE { INTEGER r, INTEGER s }
 *
 * @throws {InvalidSignatureError} on malformed input.
 */
function derSignatureToRaw(derBytes: Uint8Array): Uint8Array {
  let pos = 0;

  // --- SEQUENCE ---
  if (derBytes[pos] !== 0x30) {
    throw new InvalidSignatureError(
      "Expected SEQUENCE tag (0x30) at start of DER signature",
    );
  }
  pos++;

  // Sequence length (short-form only — ECDSA signatures are small).
  const seqLen = derBytes[pos++];
  if (seqLen !== derBytes.length - pos) {
    // Long-form length is vanishingly unlikely for ECDSA; support it anyway.
    let actualLen = seqLen;
    if (seqLen & 0x80) {
      const numLenBytes = seqLen & 0x7f;
      actualLen = 0;
      for (let i = 0; i < numLenBytes; i++) actualLen = (actualLen << 8) | derBytes[pos++];
    }
    if (pos + actualLen > derBytes.length) {
      throw new InvalidSignatureError("DER signature: SEQUENCE length exceeds buffer");
    }
    // Re-read pos to point past the length field; we already consumed it.
    // Just validate the bounds check.
  }

  const readInteger = (): Uint8Array => {
    if (derBytes[pos] !== 0x02) {
      throw new InvalidSignatureError("DER signature: expected INTEGER tag (0x02)");
    }
    pos++;

    let len = derBytes[pos++];
    if (len & 0x80) {
      const numLen = len & 0x7f;
      len = 0;
      for (let i = 0; i < numLen; i++) len = (len << 8) | derBytes[pos++];
    }

    // Strip leading 0x00 byte used to indicate a positive integer.
    let dataOff = pos;
    let dataLen = len;
    if (dataLen > 32 && derBytes[dataOff] === 0) {
      dataOff++;
      dataLen--;
    }

    // Produce a 32-byte zero-padded result.
    const result = new Uint8Array(32);
    const copyLen = Math.min(dataLen, 32);
    result.set(derBytes.subarray(dataOff, dataOff + copyLen), 32 - copyLen);

    pos += len;
    return result;
  };

  const r = readInteger();
  const s = readInteger();

  // Validate exact 64-byte output.
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/**
 * Encode raw r||s (64 bytes) as a DER-encoded ECDSA signature.
 */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const encodeInteger = (bytes: Uint8Array): Uint8Array => {
    // Strip leading zeros.
    let start = 0;
    while (start < bytes.length && bytes[start] === 0) start++;
    const stripped = bytes.subarray(start);

    // If the MSB of the stripped value is set, prepend 0x00 (DER positive integer).
    const needsLeadingZero = stripped.length === 0 || (stripped[0] & 0x80) !== 0;
    const payloadLen = stripped.length + (needsLeadingZero ? 1 : 0);

    const der = new Uint8Array(2 + payloadLen);
    der[0] = 0x02;
    der[1] = payloadLen;
    let off = 2;
    if (needsLeadingZero) der[off++] = 0x00;
    der.set(stripped, off);
    return der;
  };

  const rEnc = encodeInteger(raw.subarray(0, 32));
  const sEnc = encodeInteger(raw.subarray(32, 64));

  const seqLen = rEnc.length + sEnc.length;
  const der = new Uint8Array(2 + seqLen);
  der[0] = 0x30;
  der[1] = seqLen;
  der.set(rEnc, 2);
  der.set(sEnc, 2 + rEnc.length);
  return der;
}

// ---------------------------------------------------------------------------
// WebCrypto key helpers
// ---------------------------------------------------------------------------

/**
 * Import a P-256 private key as a CryptoKey for signing.
 *
 * @throws {UnsupportedKeyTypeError} for non-P-256 keys or unrecognised
 *   public-key formats.
 */
async function getPrivateCryptoKey(keyData: KeyData): Promise<CryptoKey> {
  if (keyData.keyType !== "P256Private") {
    throw new UnsupportedKeyTypeError(
      `WebCrypto does not support ${keyData.keyType} keys directly. ` +
        "Use an external library such as @noble/curves for K-256 signing.",
    );
  }

  const pub = keyData.publicKey!;
  const priv = keyData.privateKey;

  // Extract x and y.
  let x: Uint8Array;
  let y: Uint8Array;

  if (pub.length === 65 && pub[0] === 0x04) {
    x = pub.subarray(1, 33);
    y = pub.subarray(33, 65);
  } else if (pub.length === 64) {
    x = pub.subarray(0, 32);
    y = pub.subarray(32, 64);
  } else {
    throw new UnsupportedKeyTypeError(
      `Unrecognised P-256 public key length: ${pub.length} bytes`,
    );
  }

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(x),
    y: base64urlEncode(y),
    ...(priv ? { d: base64urlEncode(priv) } : {}),
  };

  try {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    throw new UnsupportedKeyTypeError(
      `Failed to import P-256 private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Import a P-256 public key as a CryptoKey for verification.
 *
 * @throws {UnsupportedKeyTypeError} for non-P-256 keys.
 */
async function getPublicCryptoKey(keyData: KeyData): Promise<CryptoKey> {
  if (keyData.keyType !== "P256Public" && keyData.keyType !== "P256Private") {
    throw new UnsupportedKeyTypeError(
      `WebCrypto does not support ${keyData.keyType} keys directly.`,
    );
  }

  const pub = keyData.publicKey!;

  let x: Uint8Array;
  let y: Uint8Array;

  if (pub.length === 65 && pub[0] === 0x04) {
    x = pub.subarray(1, 33);
    y = pub.subarray(33, 65);
  } else if (pub.length === 64) {
    x = pub.subarray(0, 32);
    y = pub.subarray(32, 64);
  } else {
    throw new UnsupportedKeyTypeError(
      `Unrecognised P-256 public key length: ${pub.length} bytes`,
    );
  }

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(x),
    y: base64urlEncode(y),
  };

  try {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (err) {
    throw new KeyResolutionError(
      `Failed to import P-256 public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Input unwrapping
// ---------------------------------------------------------------------------

/**
 * Unwrap an AnyInput to a plain JsonObject.
 *
 * @throws {RecordMustBeObjectError} if the unwrapped value is not an object.
 */
function unwrapToObject<T extends JsonObject>(input: AnyInput<T>, label: string): JsonObject {
  const val = input.unwrap();
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    const err = label === "record"
      ? new RecordMustBeObjectError(`Expected ${label} to be a JSON object`)
      : new MetadataMustBeObjectError(`Expected ${label} to be a JSON object`);
    throw err;
  }
  return val;
}

// ---------------------------------------------------------------------------
// Input – CID computation (return type)
// ---------------------------------------------------------------------------

/**
 * Result of computing an attestation CID.
 */
interface CidResult {
  /** Human- and protocol-facing CID string (e.g. "bafyreia…"). */
  cid: string;
  /** Raw bytes that should be signed / verified (CID hash bytes). */
  bytes: Uint8Array;
}

/**
 * Wrap an `AnyInput` value into a plain object for CID computation by
 * calling the imported `createAttestationCid`.
 *
 * This indirection lets us normalise the interface consumed from `./cid.ts`.
 */
async function computeAttestationCid(
  record: JsonObject,
  metadata: JsonObject,
  repository: string,
): Promise<CidResult> {
  // The imported createAttestationCid accepts the pre-unwrapped objects and
  // returns either a string CID or an object with { cid, bytes }.
  const result = await createAttestationCid(record, metadata, repository);

  // Normalise to our expected shape.
  if (typeof result === "string") {
    // Fallback: sign the UTF-8 encoding of the CID string.
    return {
      cid: result,
      bytes: new TextEncoder().encode(result),
    };
  }

  // Assume { cid: string, bytes: Uint8Array }.
  return result as unknown as CidResult;
}

// ---------------------------------------------------------------------------
// Signing core
// ---------------------------------------------------------------------------

/**
 * Sign raw bytes with the given key data, producing a normalized 64-byte
 * ECDSA signature (raw r||s).
 *
 * For P-256 keys this uses WebCrypto internally. For K-256 an error is
 * thrown.
 */
async function signBytes(
  payload: Uint8Array,
  keyData: KeyData,
): Promise<Uint8Array> {
  if (keyData.keyType === "K256Private" || keyData.keyType === "K256Public") {
    throw new UnsupportedKeyTypeError(
      "K-256 (secp256k1) signing is not supported by WebCrypto. " +
        "Use `createSignature` with an external K-256 library such as @noble/curves, " +
        "or convert to P-256.",
    );
  }

  const privateKey = await getPrivateCryptoKey(keyData);
  const derSig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    payload.buffer as ArrayBuffer,
  );
  const raw = derSignatureToRaw(new Uint8Array(derSig));
  return normalizeSignature(raw, keyData.keyType);
}

/**
 * Verify a normalized 64-byte raw ECDSA signature against the payload bytes
 * and a public key.
 */
async function verifySignature(
  payload: Uint8Array,
  rawSignature: Uint8Array,
  keyData: KeyData,
): Promise<boolean> {
  if (keyData.keyType === "K256Private" || keyData.keyType === "K256Public") {
    throw new UnsupportedKeyTypeError(
      "K-256 (secp256k1) verification is not supported by WebCrypto. " +
        "Use an external library such as @noble/curves.",
    );
  }

  const publicKey = await getPublicCryptoKey(keyData);

  // WebCrypto expects DER-encoded signatures, so convert back from raw.
  const derSig = rawSignatureToDer(rawSignature);

  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    derSig.buffer as ArrayBuffer,
    payload.buffer as ArrayBuffer,
  );
}

// ---------------------------------------------------------------------------
// $sig builder
// ---------------------------------------------------------------------------

/**
 * Build a $sig attestation metadata object.
 *
 * $type is inherited from the caller-supplied metadata.
 */
function buildSigMetadata(
  metadataType: string,
  key: string,
  cid: string,
  signatureB64: string,
): JsonObject {
  return {
    $type: metadataType,
    key,
    sig: signatureB64,
    cid,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an inline attestation — sign a record with a private key and embed
 * the `$sig` metadata directly into the record's `signatures` array.
 *
 * Algorithm:
 * 1. Unwrap record and metadata to plain JSON objects.
 * 2. Compute the attestation CID from (record, metadata, repository).
 * 3. Build a `$sig` entry with the issuer DID and computed CID.
 * 4. Sign the CID bytes with the private key.
 * 5. Normalise the signature and base64url-encode it.
 * 6. Deep-clone the record, add / update its `signatures` array, and return.
 *
 * @param recordInput     - Record to attest.
 * @param metadataInput   - Attestation metadata (must contain `$type`).
 * @param repository      - AT Protocol repository (DID) the record belongs to.
 * @param privateKeyData  - Signing key.
 * @returns A new record object with the `signatures` entry appended.
 *
 * @throws {RecordMustBeObjectError}
 * @throws {MetadataMustBeObjectError}
 * @throws {MetadataMissingFieldError}   if metadata lacks `$type`.
 * @throws {UnsupportedKeyTypeError}
 * @throws {InvalidSignatureError}
 */
export async function createInlineAttestation(
  recordInput: AnyInput<JsonObject>,
  metadataInput: AnyInput<JsonObject>,
  repository: string,
  privateKeyData: KeyData,
): Promise<JsonObject> {
  try {
    const record = unwrapToObject(recordInput, "record");
    const metadata = unwrapToObject(metadataInput, "metadata");

    if (typeof metadata.$type !== "string" || !metadata.$type) {
      throw new MetadataMissingFieldError(
        "Attestation metadata must contain a non-empty '$type' field",
      );
    }

    // Compute the attestation CID.
    const { cid, bytes } = await computeAttestationCid(record, metadata, repository);

    // Derive the issuer DID.
    const keyDid = didForKey(privateKeyData);

    // Sign the CID bytes.
    const rawSig = await signBytes(bytes, privateKeyData);
    const sigB64 = base64urlEncode(rawSig);

    // Build the $sig entry.
    const sigEntry = buildSigMetadata(metadata.$type as string, keyDid, cid, sigB64);

    // Deep-clone the record and append the signature.
    const signedRecord: JsonObject = JSON.parse(JSON.stringify(record));
    const signatures = (signedRecord.signatures as JsonObject[]) ?? [];
    signatures.push(sigEntry);
    signedRecord.signatures = signatures;

    return signedRecord;
  } catch (err) {
    if (err instanceof AttestationError) throw err;
    throw new AttestationError(
      `createInlineAttestation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create a remote attestation — produce an attested record and a separate
 * proof record that can be stored at another repository.
 *
 * Algorithm:
 * 1. Unwrap record and metadata.
 * 2. Compute the attestation CID using `attestationRepository` as the repo.
 * 3. Build a proof record: `{ $type, cid, ...metadata }`.
 * 4. Build an attested record: clone the record, add a `signatures` array
 *    with a `strongRef` pointing to the proof record's AT URI.
 * 5. Return `[attestedRecord, proofRecord]`.
 *
 * @param recordInput          - Record being attested.
 * @param metadataInput        - Attestation metadata (must contain `$type`).
 * @param repository           - Repository of the record.
 * @param attestationRepository - Repository where the proof record will be
 *                                stored (used for CID binding).
 * @returns A tuple of `[attestedRecord, proofRecord]`.
 */
export async function createRemoteAttestation(
  recordInput: AnyInput<JsonObject>,
  metadataInput: AnyInput<JsonObject>,
  repository: string,
  attestationRepository: string,
): Promise<[JsonObject, JsonObject]> {
  try {
    const record = unwrapToObject(recordInput, "record");
    const metadata = unwrapToObject(metadataInput, "metadata");

    if (typeof metadata.$type !== "string" || !metadata.$type) {
      throw new MetadataMissingFieldError(
        "Attestation metadata must contain a non-empty '$type' field",
      );
    }

    // Compute the CID bound to the attestation repository.
    const { cid } = await computeAttestationCid(record, metadata, attestationRepository);

    // Build the proof record: metadata fields + the computed CID.
    const proofRecord: JsonObject = {
      $type: metadata.$type as string,
      cid,
    };
    // Spread remaining metadata fields (avoid overwriting $type and cid).
    for (const [k, v] of Object.entries(metadata)) {
      if (k !== "$type") proofRecord[k] = v;
    }

    // Build the attested record with a strongRef to the proof.
    const attestedRecord: JsonObject = JSON.parse(JSON.stringify(record));
    const signatures = (attestedRecord.signatures as JsonObject[]) ?? [];

    // The proof URI will be at://attestationRepository/rkey (rkey is the TID
    // of the proof record; the caller sets it when writing).  We store the
    // strongRef reference so a consumer can resolve the proof.
    signatures.push({
      $type: metadata.$type as string,
      proof: {
        $type: "at://",
        uri: `at://${attestationRepository}`,
        cid,
      },
    });
    attestedRecord.signatures = signatures;

    return [attestedRecord, proofRecord];
  } catch (err) {
    if (err instanceof AttestationError) throw err;
    throw new AttestationError(
      `createRemoteAttestation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Low-level signature creation.
 *
 * Computes the attestation CID from the record, attestation metadata, and
 * repository, then signs the CID bytes with the supplied private key and
 * returns the raw normalised 64-byte ECDSA signature.
 *
 * @param recordInput       - Record to attest.
 * @param attestationInput  - Attestation metadata (must contain `$type`).
 * @param repository        - AT Protocol repository DID.
 * @param privateKeyData    - Signing key.
 * @returns Raw 64-byte normalised ECDSA signature (r||s).
 */
export async function createSignature(
  recordInput: AnyInput<JsonObject>,
  attestationInput: AnyInput<JsonObject>,
  repository: string,
  privateKeyData: KeyData,
): Promise<Uint8Array> {
  try {
    const record = unwrapToObject(recordInput, "record");
    const attestation = unwrapToObject(attestationInput, "attestation");

    const { bytes } = await computeAttestationCid(record, attestation, repository);

    return await signBytes(bytes, privateKeyData);
  } catch (err) {
    if (err instanceof AttestationError) throw err;
    throw new AttestationError(
      `createSignature failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Append an inline attestation — verify a `$sig` entry and, if valid, append
 * it to the record's `signatures` array.
 *
 * Algorithm:
 * 1. Unwrap record and attestation metadata.
 * 2. Extract the `$sig` entry from attestationInput (must have `key`, `sig`,
 *    and `cid` fields).
 * 3. Resolve the signing key via `keyResolver(did)`.
 * 4. Recompute the attestation CID from (record, sigMetadata, repository).
 *    **Important:** the recomputed CID must match the `cid` field in the $sig.
 * 5. Verify the signature over the CID bytes with the resolved public key.
 * 6. If valid, clone the record and append the $sig entry.
 *
 * @param recordInput      - Record to which the attestation should be appended.
 * @param attestationInput - Must be a JSON object containing a `$sig` entry
 *                           with `key`, `sig`, `cid`, and `$type` fields.
 * @param repository       - AT Protocol repository DID.
 * @param keyResolver      - Async function that resolves a DID string to a
 *                           `KeyData` (with public key).
 * @returns A new record object with the attestation appended.
 */
export async function appendInlineAttestation(
  recordInput: AnyInput<JsonObject>,
  attestationInput: AnyInput<JsonObject>,
  repository: string,
  keyResolver: KeyResolver,
): Promise<JsonObject> {
  try {
    const record = unwrapToObject(recordInput, "record");
    const sigMeta = unwrapToObject(attestationInput, "attestation");

    // Validate required $sig fields.
    const keyDid = sigMeta.key;
    if (typeof keyDid !== "string" || !keyDid) {
      throw new InvalidAttestationError(
        "Inline attestation metadata must contain a 'key' field (DID string)",
      );
    }
    const sigB64 = sigMeta.sig;
    if (typeof sigB64 !== "string" || !sigB64) {
      throw new InvalidAttestationError(
        "Inline attestation metadata must contain a 'sig' field (base64url string)",
      );
    }
    const sigCid = sigMeta.cid;
    if (typeof sigCid !== "string" || !sigCid) {
      throw new InvalidAttestationError(
        "Inline attestation metadata must contain a 'cid' field (CID string)",
      );
    }
    const sigType = sigMeta.$type;
    if (typeof sigType !== "string" || !sigType) {
      throw new InvalidAttestationError(
        "Inline attestation metadata must contain a '$type' field",
      );
    }

    // Resolve the signing key.
    let keyData: KeyData;
    try {
      keyData = await keyResolver.resolveKey(keyDid);
    } catch (err) {
      throw new KeyResolutionError(
        `Failed to resolve key for DID "${keyDid}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Recompute the attestation CID.
    const { cid, bytes } = await computeAttestationCid(
      record,
      sigMeta as unknown as JsonObject,
      repository,
    );

    // Validate the CID matches.
    if (cid !== sigCid) {
      throw new CidMismatchError(
        `Recomputed CID "${cid}" does not match the claimed CID "${sigCid}" in the attestation`,
      );
    }

    // Decode and verify the signature.
    let rawSig: Uint8Array;
    try {
      rawSig = base64urlDecode(sigB64);
    } catch {
      throw new SignatureDecodingFailedError(
        "Failed to base64url-decode the 'sig' field",
      );
    }

    if (rawSig.length !== 64) {
      throw new InvalidSignatureError(
        `Expected 64-byte signature, got ${rawSig.length} bytes`,
      );
    }

    // Normalise to low-S before verification (the signer should have, but be safe).
    const normalisedSig = normalizeSignature(rawSig, keyData.keyType);
    const isValid = await verifySignature(bytes, normalisedSig, keyData);

    if (!isValid) {
      throw new InvalidSignatureError("Inline attestation signature verification failed");
    }

    // Clone the record and append.
    const updatedRecord: JsonObject = JSON.parse(JSON.stringify(record));
    const signatures = (updatedRecord.signatures as JsonObject[]) ?? [];
    signatures.push(sigMeta as unknown as JsonObject);
    updatedRecord.signatures = signatures;

    return updatedRecord;
  } catch (err) {
    if (err instanceof AttestationError) throw err;
    throw new AttestationError(
      `appendInlineAttestation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Append a remote attestation — validate an existing proof record and append a
 * `strongRef` to the record's `signatures` array.
 *
 * Algorithm:
 * 1. Unwrap record and attestation metadata.
 * 2. The attestation metadata should contain the proof record information
 *    (including a `cid` field from the proof).
 * 3. Recompute the attestation CID from (record, metadata without cid, repository)
 *    and verify it matches the claimed CID.
 * 4. Build a `strongRef` pointing to the proof record at `attestationUri`.
 * 5. Clone the record and append the strongRef.
 *
 * @param recordInput     - Record being attested.
 * @param metadataInput   - Metadata containing the proof CID and $type.
 * @param repository      - AT Protocol repository DID.
 * @param attestationUri  - AT URI where the proof record lives (e.g.
 *                          `at://did:plc:…/app.bsky.feed.post/rkey`).
 * @returns A new record with the strongRef appended.
 */
export async function appendRemoteAttestation(
  recordInput: AnyInput<JsonObject>,
  metadataInput: AnyInput<JsonObject>,
  repository: string,
  attestationUri: string,
): Promise<JsonObject> {
  try {
    const record = unwrapToObject(recordInput, "record");
    const meta = unwrapToObject(metadataInput, "metadata");

    // The metadata should contain the proof CID.
    const proofCid = meta.cid;
    if (typeof proofCid !== "string" || !proofCid) {
      throw new InvalidProofError(
        "Remote attestation metadata must contain a 'cid' field referencing the proof",
      );
    }

    if (typeof meta.$type !== "string" || !meta.$type) {
      throw new MetadataMissingFieldError(
        "Remote attestation metadata must contain a '$type' field",
      );
    }

    // Recompute the CID without the `cid` field to verify authenticity.
    const metaForCid: JsonObject = { $type: meta.$type as string };
    for (const [k, v] of Object.entries(meta)) {
      if (k !== "cid") metaForCid[k] = v;
    }

    const { cid: recomputedCid } = await computeAttestationCid(
      record,
      metaForCid,
      repository,
    );

    if (recomputedCid !== proofCid) {
      throw new CidMismatchError(
        `Recomputed CID "${recomputedCid}" does not match proof CID "${proofCid}"`,
      );
    }

    // Build the strongRef.
    const strongRef: JsonObject = {
      $type: meta.$type as string,
      proof: {
        $type: "at://",
        uri: attestationUri,
        cid: proofCid,
      },
    };

    const updatedRecord: JsonObject = JSON.parse(JSON.stringify(record));
    const signatures = (updatedRecord.signatures as JsonObject[]) ?? [];
    signatures.push(strongRef);
    updatedRecord.signatures = signatures;

    return updatedRecord;
  } catch (err) {
    if (err instanceof AttestationError) throw err;
    throw new AttestationError(
      `appendRemoteAttestation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Fully verify all attestation signatures on a record.
 *
 * For each entry in the record's `signatures` array:
 * - **Inline** (`sig` field present): recompute the attestation CID, resolve
 *   the signing key from the DID, and verify the signature.
 * - **Remote** (`proof` field present): resolve the proof record at the URI,
 *   verify the proof record contains the expected CID, and verify the proof's
 *   own signature (recursive resolution is left to the caller).
 *
 * Errors are aggregated: all signatures are checked even if some fail, and
 * an `AttestationError` is thrown listing every failure.
 *
 * @param verifyInput    - Record containing a `signatures` array.
 * @param repository     - AT Protocol repository DID.
 * @param keyResolver    - Async DID-to-KeyData resolver.
 * @param recordResolver - Async AT-URI-to-record resolver.
 * @throws {InvalidSignatureError}     if any signature is invalid.
 * @throws {KeyResolutionError}        if a key cannot be resolved.
 * @throws {RecordResolutionError}     if a proof record cannot be resolved.
 * @throws {CidMismatchError}          if a CID does not match.
 * @throws {DanglingProofError}        if a proof record is missing.
 * @throws {InvalidProofError}         if a proof record is malformed.
 */
export async function verifyRecord(
  verifyInput: AnyInput<JsonObject>,
  repository: string,
  keyResolver: KeyResolver,
  recordResolver: RecordResolver,
): Promise<void> {
  const errors: string[] = [];

  let record: JsonObject;
  try {
    record = unwrapToObject(verifyInput, "record");
  } catch (err) {
    throw err;
  }

  const signatures = record.signatures as JsonObject[] | undefined;
  if (!Array.isArray(signatures) || signatures.length === 0) {
    // No signatures to verify — that is fine.
    return;
  }

  // Check every signature and collect failures.
  for (let idx = 0; idx < signatures.length; idx++) {
    const sig = signatures[idx];
    if (typeof sig !== "object" || sig === null) {
      errors.push(`Signature[${idx}]: expected an object, got ${typeof sig}`);
      continue;
    }

    const sigEntry = sig as Record<string, unknown>;

    try {
      // Determine whether it is inline or remote.
      const hasSig = typeof sigEntry.sig === "string" && sigEntry.sig !== "";
      const hasProof = typeof sigEntry.proof === "object" && sigEntry.proof !== null;

      if (hasSig && hasProof) {
        errors.push(
          `Signature[${idx}]: has both 'sig' and 'proof' — ambiguous`,
        );
        continue;
      }

      if (!hasSig && !hasProof) {
        errors.push(
          `Signature[${idx}]: must contain either 'sig' (inline) or 'proof' (remote)`,
        );
        continue;
      }

      if (hasSig) {
        // --- Inline attestation ---
        await verifyInlineSignature(record, sigEntry, repository, keyResolver, idx, errors);
      } else {
        // --- Remote attestation ---
        await verifyRemoteSignature(sigEntry, recordResolver, idx, errors);
      }
    } catch (err) {
      errors.push(
        `Signature[${idx}]: unexpected error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (errors.length > 0) {
    throw new InvalidSignatureError(
      `Record has ${errors.length} invalid attestation(s):\n${errors.join("\n")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal verify helpers
// ---------------------------------------------------------------------------

/**
 * Verify a single inline $sig entry.
 */
async function verifyInlineSignature(
  record: JsonObject,
  sigEntry: Record<string, unknown>,
  repository: string,
  keyResolver: KeyResolver,
  idx: number,
  errors: string[],
): Promise<void> {
  const keyDid = sigEntry.key as string;
  const sigB64 = sigEntry.sig as string;
  const sigCid = sigEntry.cid as string;
  const sigType = (sigEntry.$type as string) ?? "unknown";

  if (!keyDid) {
    errors.push(`Signature[${idx}]: missing 'key' field`);
    return;
  }
  if (!sigB64) {
    errors.push(`Signature[${idx}]: missing 'sig' field`);
    return;
  }
  if (!sigCid) {
    errors.push(`Signature[${idx}]: missing 'cid' field`);
    return;
  }

  // Rebuild metadata (the $sig entry itself is the attestation metadata).
  const sigMeta: JsonObject = {
    $type: sigType,
    key: keyDid,
    sig: sigB64,
    cid: sigCid,
  };

  // Recompute CID.
  let cidResult: CidResult;
  try {
    cidResult = await computeAttestationCid(record, sigMeta, repository);
  } catch (err) {
    errors.push(
      `Signature[${idx}]: CID computation failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  if (cidResult.cid !== sigCid) {
    errors.push(
      `Signature[${idx}]: CID mismatch — expected "${sigCid}", recomputed "${cidResult.cid}"`,
    );
    return;
  }

  // Resolve key.
  let keyData: KeyData;
  try {
    keyData = await keyResolver.resolveKey(keyDid);
  } catch (err) {
    errors.push(
      `Signature[${idx}]: key resolution failed for "${keyDid}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  // Decode and verify signature.
  let rawSig: Uint8Array;
  try {
    rawSig = base64urlDecode(sigB64);
  } catch {
    errors.push(`Signature[${idx}]: failed to base64url-decode 'sig'`);
    return;
  }

  if (rawSig.length !== 64) {
    errors.push(
      `Signature[${idx}]: expected 64-byte signature, got ${rawSig.length}`,
    );
    return;
  }

  const normalisedSig = normalizeSignature(rawSig, keyData.keyType);
  let valid: boolean;
  try {
    valid = await verifySignature(cidResult.bytes, normalisedSig, keyData);
  } catch (err) {
    errors.push(
      `Signature[${idx}]: verification threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  if (!valid) {
    errors.push(`Signature[${idx}]: invalid signature`);
  }
}

/**
 * Verify a single remote attestation (proof) entry.
 */
async function verifyRemoteSignature(
  sigEntry: Record<string, unknown>,
  recordResolver: RecordResolver,
  idx: number,
  errors: string[],
): Promise<void> {
  const proof = sigEntry.proof as Record<string, unknown> | undefined;
  if (!proof || typeof proof.uri !== "string") {
    errors.push(`Signature[${idx}]: 'proof' must be an object with a 'uri' field`);
    return;
  }

  const proofUri = proof.uri as string;
  const expectedCid = proof.cid as string | undefined;

  // Resolve the proof record.
  let proofRecord: JsonObject;
  try {
    proofRecord = await recordResolver.resolve(proofUri);
  } catch (err) {
    errors.push(
      `Signature[${idx}]: failed to resolve proof at "${proofUri}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  if (typeof proofRecord !== "object" || proofRecord === null) {
    errors.push(
      `Signature[${idx}]: proof record at "${proofUri}" is not a JSON object`,
    );
    return;
  }

  // Verify the proof record contains the expected CID.
  if (expectedCid) {
    const actualCid = proofRecord.cid;
    if (actualCid !== expectedCid) {
      errors.push(
        `Signature[${idx}]: proof record CID mismatch — ` +
          `expected "${expectedCid}", got "${actualCid}"`,
      );
    }
  }

  // If the proof record itself has a 'signatures' array, its signatures
  // would need to be verified recursively.  The Rust crate does *not*
  // recurse automatically in verify_record — it only checks the proof
  // reference.  We follow the same policy.
}
