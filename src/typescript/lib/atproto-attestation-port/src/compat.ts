/**
 * compat.ts — @atiproto/atproto-attestation compatible API surface.
 *
 * Mirrors the exact signatures and behaviour of @atiproto/atproto-attestation
 * so that consumers (lib/market) can swap the import map with zero code changes.
 *
 * Uses @noble/curves for K-256 / P-256 / Ed25519 signing and @noble/hashes for
 * synchronous SHA-256 (the port's own async WebCrypto path stays in cid.ts).
 */

import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats";
import * as Digest from "multiformats/hashes/digest";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "@noble/hashes/sha2";
import { p256 } from "@noble/curves/nist";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";

// ---------------------------------------------------------------------------
// normalizeSignature (compat — translates @atiproto key type strings)
// ---------------------------------------------------------------------------

/**
 * P-256 (secp256r1) curve order n.
 */
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/**
 * K-256 (secp256k1) curve order n.
 */
const K256_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Normalizes an ECDSA signature to low-S form.
 *
 * Handles @atiproto key type strings (`"p256"`, `"k256"`).
 *
 * @param signature - Raw 64-byte ECDSA signature (r || s, 32 bytes each).
 * @param type      - @atiproto key type string.
 * @returns A new Uint8Array containing the normalized signature.
 */
export function normalizeSignature(
  signature: Uint8Array,
  type: string,
): Uint8Array {
  if (signature.byteLength !== 64) {
    throw new Error(
      `Unexpected ECDSA signature length ${signature.byteLength}; expected 64`,
    );
  }

  // Non-ECDSA key types pass through.
  if (type !== "p256" && type !== "k256" && type !== "p384") return signature;

  const n = type === "p256" || type === "p384" ? P256_ORDER : K256_ORDER;
  const halfN = n >> 1n;

  // Decode s (bytes 32-63) as big-endian bigint.
  let s = 0n;
  for (let i = 0; i < 32; i++) {
    s = (s << 8n) | BigInt(signature[32 + i]);
  }

  // s is already in low-S form — return a copy.
  if (s <= halfN) {
    return new Uint8Array(signature);
  }

  // Replace s with n - s (low-S form).
  s = n - s;

  const normalized = new Uint8Array(64);
  // Copy r (bytes 0-31) unchanged.
  normalized.set(signature.subarray(0, 32), 0);
  // Write normalized s as 32-byte big-endian.
  for (let i = 0; i < 32; i++) {
    normalized[32 + i] = Number((s >> BigInt(8 * (31 - i))) & 0xffn);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Types (compatible with @atiproto/atproto-attestation)
// ---------------------------------------------------------------------------

/** Generic record map — every AT Protocol record is `Record<string, unknown>`. */
export type RecordMap = Record<string, unknown>;

/** Key type discriminator used by @atiproto. */
export type KeyType = "k256" | "p256" | "p384" | "ed25519";

/**
 * Key data shape as consumed/produced by @atiproto/atproto-attestation and
 * @atiproto/key-resolver.
 *
 * `toBytes()` is optional but present on keys constructed by the market
 * signing helpers so that wrappers that call `.toBytes()` don't crash.
 */
export interface KeyData {
  type: KeyType;
  bytes: Uint8Array;
  toBytes?: () => Uint8Array;
}

/** An inline attestation entry on a record's `signatures` array. */
export interface InlineAttestation {
  $type: string;
  key: string; // did:key of the signer
  cid: string; // attestation CID string
  signature: Uint8Array | { $bytes: string };
  issuer?: string;
  issuedAt?: string;
  role?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAG_CBOR_CODEC = 0x71;
const MULTIHASH_SHA256 = 0x12;

const DEFAULT_SIGNATURE_TYPE = "network.attested.signature";
const DEFAULT_PROOF_TYPE = "network.attested.proof";
const STRONG_REF_NSID = "com.atproto.repo.strongRef";

// ---------------------------------------------------------------------------
// Multicodec tables
// ---------------------------------------------------------------------------

interface CodecEntry {
  type: KeyType;
  kind: "public" | "private";
  prefix: Uint8Array;
}

const CODECS: CodecEntry[] = [
  { type: "p256", kind: "public", prefix: new Uint8Array([0x80, 0x24]) },
  { type: "p256", kind: "private", prefix: new Uint8Array([0x86, 0x26]) },
  { type: "p384", kind: "public", prefix: new Uint8Array([0x12, 0x00]) },
  { type: "p384", kind: "private", prefix: new Uint8Array([0x13, 0x01]) },
  { type: "k256", kind: "public", prefix: new Uint8Array([0xe7, 0x01]) },
  { type: "k256", kind: "private", prefix: new Uint8Array([0x81, 0x26]) },
  { type: "ed25519", kind: "public", prefix: new Uint8Array([0xed, 0x01]) },
  { type: "ed25519", kind: "private", prefix: new Uint8Array([0x80, 0x26]) },
];

// ---------------------------------------------------------------------------
// Curve dispatch
// ---------------------------------------------------------------------------

function curveFor(type: KeyType) {
  switch (type) {
    case "p256":
      return p256;
    case "p384":
      throw new Error("P-384 is not yet supported by the compat layer");
    case "k256":
      return secp256k1;
    case "ed25519":
      throw new Error("ed25519 uses a separate code path");
  }
}

// ---------------------------------------------------------------------------
// Multibase / did:key helpers
// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function findCodec(
  bytes: Uint8Array,
  kind: "public" | "private",
): CodecEntry | undefined {
  return CODECS.find((c) => c.kind === kind && startsWith(bytes, c.prefix));
}

function decodeMultibase(value: string): Uint8Array {
  return base58btc.decode(value);
}

function encodeMultibase(bytes: Uint8Array): string {
  return base58btc.encode(bytes);
}

/**
 * Parse a `did:key:…` string into its raw key material.
 *
 * @returns `{ type, bytes }` where `bytes` is the raw public key (no multicodec prefix).
 */
export function parseDidKey(didKey: string): KeyData {
  if (!didKey.startsWith("did:key:")) {
    throw new Error(`Not a did:key: ${didKey}`);
  }
  const mb = didKey.slice("did:key:".length);
  const decoded = decodeMultibase(mb);
  const codec = findCodec(decoded, "public");
  if (!codec) {
    throw new Error("Unknown public key codec for did:key");
  }
  return { type: codec.type, bytes: decoded.slice(codec.prefix.length) };
}

/**
 * Format raw key material as a `did:key:…` string.
 *
 * @param key — `{ type, bytes }` where `bytes` is the raw public key (no multicodec prefix).
 */
export function formatDidKey(key: KeyData): string {
  const codec = CODECS.find((c) => c.type === key.type && c.kind === "public");
  if (!codec) throw new Error(`Unsupported key type: ${key.type}`);
  const combined = new Uint8Array(codec.prefix.length + key.bytes.length);
  combined.set(codec.prefix, 0);
  combined.set(key.bytes, codec.prefix.length);
  return `did:key:${encodeMultibase(combined)}`;
}

/**
 * Parse a multibase-encoded private key string into raw key material.
 */
export function parsePrivateMultibase(mb: string): KeyData {
  const decoded = decodeMultibase(mb);
  const codec = findCodec(decoded, "private");
  if (!codec) {
    throw new Error("Unknown private key codec");
  }
  return { type: codec.type, bytes: decoded.slice(codec.prefix.length) };
}

/**
 * Format raw private key material as a multibase string.
 */
export function formatPrivateMultibase(key: KeyData): string {
  const codec = CODECS.find((c) => c.type === key.type && c.kind === "private");
  if (!codec) throw new Error(`Unsupported key type: ${key.type}`);
  const combined = new Uint8Array(codec.prefix.length + key.bytes.length);
  combined.set(codec.prefix, 0);
  combined.set(key.bytes, codec.prefix.length);
  return encodeMultibase(combined);
}

// ---------------------------------------------------------------------------
// CID helpers
// ---------------------------------------------------------------------------

/**
 * Synchronous DAG-CBOR CIDv1 (SHA-256) computation.
 *
 * Uses @noble/hashes for sync SHA-256 (multiformats' `sha256.digest` is
 * async — it delegates to WebCrypto).
 */
export function createDagCborCid(value: unknown): CID {
  const bytes = dagCbor.encode(value);
  const digest = Digest.create(MULTIHASH_SHA256, sha256(bytes));
  return CID.create(1, DAG_CBOR_CODEC, digest);
}

/**
 * Create an attestation CID binding a record, metadata, and repository.
 *
 * Algorithm (matches @atiproto/atproto-attestation):
 *  1. Strip `cid` and `signature` from metadata.
 *  2. Add `repository` to metadata.
 *  3. Place metadata under `$sig` in a copy of the record.
 *  4. Strip `signatures` from the record copy.
 *  5. Optionally keep only `fields` (plus `$type` and `$sig`).
 *  6. Compute DAG-CBOR CIDv1 over the resulting object.
 *
 * @param record     — The record being attested.
 * @param metadata   — Attestation metadata (must have `$type`).
 * @param repository — DID of the repository the record lives in.
 * @param fields     — Optional allow-list of record fields to include.
 * @returns A CID object with `.toString()` and `.bytes`.
 */
export function createAttestationCid(
  record: RecordMap,
  metadata: RecordMap,
  repository: string,
  fields?: string[],
): CID {
  if (typeof record.$type !== "string" || record.$type.length === 0) {
    throw new Error("record is missing $type");
  }
  if (typeof metadata.$type !== "string" || metadata.$type.length === 0) {
    throw new Error("attestation metadata is missing $type");
  }

  // Prepare metadata: remove cid/signature, add repository.
  const preparedMetadata: RecordMap = { ...metadata };
  delete preparedMetadata.cid;
  delete preparedMetadata.signature;
  preparedMetadata.repository = repository;

  // Prepare record.
  let preparedRecord: RecordMap;
  if (fields) {
    preparedRecord = { $type: record.$type, $sig: preparedMetadata };
    for (const f of fields) {
      if (f in record && f !== "signatures") {
        preparedRecord[f] = record[f];
      }
    }
  } else {
    preparedRecord = { ...record };
    delete preparedRecord.signatures;
    preparedRecord.$sig = preparedMetadata;
  }

  return createDagCborCid(preparedRecord);
}

/**
 * Check whether a string is a valid DAG-CBOR CIDv1 with SHA-256.
 */
export function isAttestationCidString(value: string): boolean {
  try {
    const cid = CID.parse(value);
    return (
      cid.version === 1 &&
      cid.code === DAG_CBOR_CODEC &&
      cid.multihash.code === MULTIHASH_SHA256 &&
      cid.multihash.digest.length === 32
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign a payload with a private key.
 *
 * Hashes `payload` with SHA-256, then signs the digest with the curve
 * indicated by `privateKey.type`. Returns a 64-byte raw ECDSA signature
 * (r||s, compact / low-S normalised).
 *
 * Supports: p256, k256, ed25519.
 */
export function signBytes(payload: Uint8Array, privateKey: KeyData): Uint8Array {
  if (privateKey.type === "ed25519") {
    return ed25519.sign(payload, privateKey.bytes);
  }

  const curve = curveFor(privateKey.type);
  const digest = sha256(payload);
  const sig = curve.sign(digest, privateKey.bytes, {
    lowS: privateKey.type !== "p384",
  });

  // @noble/curves >=1.8: Signature class removed; toBytes may be absent.
  const sigBytes: Uint8Array = typeof (sig as { toBytes?: (fmt: string) => Uint8Array }).toBytes === "function"
    ? (sig as { toBytes: (fmt: string) => Uint8Array }).toBytes("compact")
    : (() => {
        // Manual r||s serialisation fallback (64 bytes: 32 r + 32 s).
        const s = sig as unknown as { r: bigint; s: bigint };
        const b = new Uint8Array(64);
        const rHex = s.r.toString(16).padStart(64, "0");
        const sHex = s.s.toString(16).padStart(64, "0");
        for (let i = 0; i < 32; i++) b[i] = parseInt(rHex.slice(i * 2, i * 2 + 2), 16);
        for (let i = 0; i < 32; i++) b[i + 32] = parseInt(sHex.slice(i * 2, i * 2 + 2), 16);
        return b;
      })();

  return normalizeSignature(sigBytes, privateKey.type);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a signature over a payload with a public key.
 *
 * Hashes `payload` with SHA-256, then verifies the ECDSA signature against
 * the digest using the curve indicated by `publicKey.type`.
 *
 * Never throws — returns `false` on any error.
 */
export function verifyBytes(
  payload: Uint8Array,
  signature: Uint8Array,
  publicKey: KeyData,
): boolean {
  try {
    if (publicKey.type === "ed25519") {
      return ed25519.verify(signature, payload, publicKey.bytes);
    }
    const curve = curveFor(publicKey.type);
    const digest = sha256(payload);
    return curve.verify(signature, digest, publicKey.bytes, {
      lowS: publicKey.type !== "p384",
      format: "compact",
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Attestation class
// ---------------------------------------------------------------------------

/** Options for the Attestation constructor. */
export interface AttestationOptions {
  privateKey: KeyData | string; // KeyData or multibase-encoded private key
  publicKey?: string; // did:key string; derived from privateKey when omitted
  signatureType?: string;
  proofType?: string;
  role?: string;
  issuer?: string;
  agent?: {
    did: string;
    call: (
      nsid: string,
      opts: unknown,
      body: unknown,
    ) => Promise<{ data: unknown }>;
  };
}

/** Options for Attestation.sign(). */
export interface SignOptions {
  record: RecordMap;
  repository: string;
  signatureType?: string;
  metadata?: RecordMap;
  fields?: string[];
}

/**
 * An AT Protocol attestation signer.
 *
 * Mirrors the `Attestation` class from @atiproto/atproto-attestation.
 *
 * ```ts
 * const att = new Attestation({ privateKey: keyData, issuer: "did:web:example.com" });
 * const entry = await att.sign({ record, repository: "did:plc:..." });
 * ```
 */
export class Attestation {
  privateKey: KeyData;
  publicKey: string; // did:key
  signatureType: string;
  proofType: string;
  role?: string;
  issuer?: string;
  agent?: AttestationOptions["agent"];

  constructor(options: AttestationOptions) {
    this.privateKey =
      typeof options.privateKey === "string"
        ? parsePrivateMultibase(options.privateKey)
        : options.privateKey;
    this.publicKey =
      options.publicKey ?? derivePublicDidKey(this.privateKey);
    // Sanity-check: public key type must match private key type.
    const parsed = parseDidKey(this.publicKey);
    if (parsed.type !== this.privateKey.type) {
      throw new Error(
        `Public/private key type mismatch (pub=${parsed.type}, priv=${this.privateKey.type})`,
      );
    }
    this.signatureType = options.signatureType ?? DEFAULT_SIGNATURE_TYPE;
    this.proofType = options.proofType ?? DEFAULT_PROOF_TYPE;
    this.role = options.role;
    this.issuer = options.issuer;
    this.agent = options.agent;
  }

  /**
   * Sign a record.
   *
   * Returns an inline attestation entry (when no `agent` was configured) or
   * a strongRef to a freshly written proof record (when `agent` is set).
   */
  async sign(options: SignOptions): Promise<InlineAttestation | RecordMap> {
    const {
      record,
      repository,
      signatureType,
      metadata: extraMetadata,
      fields,
    } = options;
    const remote = this.agent !== undefined;
    const $type = remote ? this.proofType : (signatureType ?? this.signatureType);
    const metadata: RecordMap = { $type };
    if (!remote) metadata.key = this.publicKey;
    const issuer = extraMetadata?.issuer ?? this.issuer;
    const issuedAt = extraMetadata?.issuedAt;
    const role = extraMetadata?.role ?? this.role;
    if (issuer !== undefined) metadata.issuer = issuer;
    if (issuedAt !== undefined) metadata.issuedAt = issuedAt;
    if (role !== undefined) metadata.role = role;
    if (extraMetadata) {
      for (const [k, v] of Object.entries(extraMetadata)) {
        if (k === "issuer" || k === "issuedAt" || k === "role") continue;
        metadata[k] = v;
      }
    }

    const cid = createAttestationCid(record, metadata, repository, fields);

    // Remote path: write proof record via the agent.
    if (remote) return this.writeProof(cid.toString(), metadata);

    // Inline path: sign the CID bytes.
    const signature = signBytes(cid.bytes, this.privateKey);
    const entry: RecordMap & { $type: string; key: string; cid: string; signature: Uint8Array } = {
      $type,
      key: this.publicKey,
      cid: cid.toString(),
      signature,
    };
    if (issuer !== undefined) entry.issuer = issuer;
    if (issuedAt !== undefined) entry.issuedAt = issuedAt;
    if (role !== undefined) entry.role = role;
    if (extraMetadata) {
      for (const [k, v] of Object.entries(extraMetadata)) {
        if (k === "issuer" || k === "issuedAt" || k === "role") continue;
        entry[k] = v;
      }
    }
    return entry as InlineAttestation;
  }

  /**
   * Sign and merge the entry into `input.record.signatures`.
   *
   * Re-sign detection: if an existing entry on `signatures[]` was issued by
   * THIS attestation (inline entries match by `key`), it is replaced rather
   * than appended.
   */
  async signAndAppend(input: {
    record: RecordMap;
    repository: string;
    signatureType?: string;
    metadata?: RecordMap;
    fields?: string[];
  }): Promise<RecordMap> {
    const { record } = input;
    const entry = await this.sign(input);
    const prior = Array.isArray(record.signatures) ? record.signatures : [];
    const replaceIdx = this.findOwnIndex({ signatures: prior });
    let next: unknown[];
    if (replaceIdx >= 0) {
      next = prior.slice();
      next[replaceIdx] = entry;
    } else {
      next = [...prior, entry];
    }
    return { ...record, signatures: next };
  }

  /**
   * Find the index of an existing signature on `signatures[]` that was
   * issued by us. Returns -1 when nothing matches.
   */
  findOwnIndex({ signatures }: { signatures: unknown[] }): number {
    const agentDid = this.agent?.did;
    return signatures.findIndex((raw) => {
      const entry = raw && typeof raw === "object" ? (raw as RecordMap) : undefined;
      if (!entry) return false;
      if (entry.$type === STRONG_REF_NSID) {
        return (
          typeof entry.uri === "string" &&
          !!agentDid &&
          strongRefRepo(entry.uri) === agentDid
        );
      }
      return entry.key === this.publicKey;
    });
  }

  /** Write a proof record and return a strongRef. */
  private async writeProof(
    contentCid: string,
    metadata: RecordMap,
  ): Promise<RecordMap> {
    const agent = this.agent!;
    const repo = agent.did;
    if (!repo) {
      throw new Error("Attestation agent must expose a `did` to write proofs");
    }
    const proofRecord: RecordMap = { $type: this.proofType, cid: contentCid };
    if (metadata.issuer !== undefined) proofRecord.issuer = metadata.issuer;
    if (metadata.role !== undefined) proofRecord.role = metadata.role;
    if (metadata.status !== undefined) proofRecord.status = metadata.status;
    const res = await agent.call("com.atproto.repo.createRecord", undefined, {
      repo,
      collection: this.proofType,
      record: proofRecord,
    });
    const data =
      res.data && typeof res.data === "object" ? (res.data as RecordMap) : undefined;
    if (!data || typeof data.uri !== "string" || typeof data.cid !== "string") {
      throw new Error("PDS did not return { uri, cid } for proof write");
    }
    return {
      $type: "com.atproto.repo.strongRef",
      uri: data.uri,
      cid: data.cid,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for Attestation
// ---------------------------------------------------------------------------

function derivePublicDidKey(privateKey: KeyData): string {
  let bytes: Uint8Array;
  switch (privateKey.type) {
    case "p256":
      bytes = p256.getPublicKey(privateKey.bytes);
      break;
    case "k256":
      bytes = secp256k1.getPublicKey(privateKey.bytes);
      break;
    case "ed25519":
      bytes = ed25519.getPublicKey(privateKey.bytes);
      break;
    case "p384":
      throw new Error(
        "Cannot derive P-384 public did:key; pass `publicKey` explicitly",
      );
  }
  return formatDidKey({ type: privateKey.type, bytes });
}

function strongRefRepo(uri: string): string | undefined {
  if (!uri.startsWith("at://")) return undefined;
  const rest = uri.slice("at://".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

// ---------------------------------------------------------------------------
// Record verification (mirrors @atiproto's verify function)
// ---------------------------------------------------------------------------

/** Key resolver: maps a did:key (or any DID) to raw public key data. */
export type KeyResolver = (
  did: string,
) => KeyData | Promise<KeyData>;

/** Record resolver: fetches a record by at:// URI. */
export type RecordResolver = (
  uri: string,
) => RecordMap | Promise<RecordMap>;

export interface VerifyOptions {
  record: RecordMap;
  repository: string;
  keyResolver?: KeyResolver;
  recordResolver?: RecordResolver;
  fields?: string[];
  role?: string;
}

export interface VerifyEntryResult {
  index: number;
  $type: string;
  ok: boolean;
  reason?: string;
}

/**
 * Default key resolver — only handles `did:key:` DIDs by parsing them directly.
 */
export function defaultKeyResolver(did: string): KeyData {
  if (!did.startsWith("did:key:")) {
    throw new Error(`Default keyResolver only handles did:key (got: ${did})`);
  }
  return parseDidKey(did);
}

/**
 * Verify every entry in a record's `signatures` array.
 *
 * Never throws — returns an array of per-entry results.
 */
export async function verify(
  options: VerifyOptions,
): Promise<VerifyEntryResult[]> {
  const {
    record,
    repository,
    keyResolver = defaultKeyResolver,
    recordResolver,
    fields,
    role,
  } = options;

  const signatures: unknown[] = Array.isArray(record.signatures)
    ? record.signatures
    : [];
  const entries: VerifyEntryResult[] = [];

  for (let i = 0; i < signatures.length; i++) {
    const entry =
      signatures[i] && typeof signatures[i] === "object"
        ? (signatures[i] as RecordMap)
        : undefined;
    const $type: string =
      entry && typeof entry.$type === "string" ? entry.$type : "";

    if (!entry || !$type) {
      entries.push({
        index: i,
        $type,
        ok: false,
        reason: "Entry is not an object with a $type",
      });
      continue;
    }

    try {
      if ($type === STRONG_REF_NSID) {
        // Remote attestation (strongRef).
        if (!recordResolver) {
          throw new Error("Remote attestation requires input.recordResolver");
        }
        const uri = entry.uri;
        if (typeof uri !== "string" || uri.length === 0) {
          throw new Error("Remote attestation entry missing `uri`");
        }
        const proof = await recordResolver(uri);
        if (!proof || typeof proof !== "object") {
          throw new Error("Resolved proof was not an object");
        }
        if (role !== undefined && proof.role !== role) continue;
        const computed = createAttestationCid(record, proof, repository, fields);
        if (proof.cid !== computed.toString()) {
          throw new Error("Remote attestation CID mismatch");
        }
        entries.push({ index: i, $type, ok: true });
      } else {
        // Inline attestation.
        const key = entry.key;
        if (typeof key !== "string" || key.length === 0) {
          throw new Error("Inline attestation missing `key`");
        }
        const sig = entry.signature;
        if (!(sig instanceof Uint8Array) && typeof sig !== "object") {
          throw new Error("Inline attestation missing `signature`");
        }
        let sigBytes: Uint8Array;
        if (sig instanceof Uint8Array) {
          sigBytes = sig;
        } else if (
          sig &&
          typeof sig === "object" &&
          typeof (sig as RecordMap).$bytes === "string"
        ) {
          sigBytes = base64ToBytes((sig as RecordMap).$bytes as string);
        } else {
          throw new Error("Inline attestation signature is not bytes or {$bytes}");
        }

        const pubKey = await keyResolver(key);
        const computed = createAttestationCid(record, entry, repository, fields);
        if (entry.cid !== computed.toString()) {
          throw new Error("Inline attestation CID mismatch");
        }
        const ok = verifyBytes(computed.bytes, sigBytes, pubKey);
        if (!ok) throw new Error("Signature verification failed");
        entries.push({ index: i, $type, ok: true });
      }
    } catch (err) {
      entries.push({
        index: i,
        $type,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
