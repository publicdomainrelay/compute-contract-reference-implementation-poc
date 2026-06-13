// ── Rust crate mirror API ──────────────────────────────────────────────
export { AttestationError } from "./src/errors.ts";
// createDagCborCid (async, WebCrypto) is superseded by the sync compat
// version below. Import directly from "./src/cid.ts" if the async variant
// is needed.
export { AnyInput, AnyInputError } from "./src/input.ts";

// Core attestation functions
export {
  createInlineAttestation,
  createRemoteAttestation,
  createSignature,
  appendInlineAttestation,
  appendRemoteAttestation,
  verifyRecord,
  didForKey,
} from "./src/attestation.ts";

// normalizeSignature is exported via the compat layer below (accepts @atiproto
// key-type strings "p256"/"k256").  For the port-native variant (KeyType enums)
// import directly from "./src/signature.ts".

// Types (port-native shapes)
export type {
  KeyType as PortKeyType,
  KeyData as PortKeyData,
  KeyResolver as PortKeyResolver,
  RecordResolver as PortRecordResolver,
  JsonValue,
  JsonObject,
  CidString,
  AttestationMetadata,
  AttestationSignature,
  LexiconType,
} from "./src/types.ts";

// Error types
export {
  AnyInputError as AnyInputErrorClass,
  RecordMustBeObjectError,
  MetadataMustBeObjectError,
  MetadataMissingFieldError,
  DagCborError,
  InvalidSignatureError,
  SignatureDecodingFailedError,
  KeyResolutionError,
  JsonError,
  InvalidProofError,
  InvalidAttestationError,
  RecordResolutionError,
  DanglingProofError,
  CidMismatchError,
  UnsupportedKeyTypeError,
} from "./src/errors.ts";

// ── @atiproto/atproto-attestation compatible API ────────────────────────
// These match the exact signatures that lib/market (and other consumers of
// @atiproto/atproto-attestation) expect.  Import-map @atiproto/atproto-attestation
// to this module and existing code compiles without changes.
export {
  // Types (compat shapes — RecordMap, KeyData, etc.)
  type RecordMap,
  type KeyData,
  type InlineAttestation,
  type KeyResolver,
  type RecordResolver,
  type AttestationOptions,
  type SignOptions,
  type VerifyOptions,
  type VerifyEntryResult,
  // Functions
  createDagCborCid,
  createAttestationCid,
  signBytes,
  verifyBytes,
  verify,
  normalizeSignature,
  formatDidKey,
  parseDidKey,
  formatPrivateMultibase,
  parsePrivateMultibase,
  isAttestationCidString,
  defaultKeyResolver,
  // Attestation class
  Attestation,
} from "./src/compat.ts";
