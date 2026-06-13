/**
 * Error types mirroring atproto_attestation::errors::AttestationError.
 */

/** Root error class for all attestation operations. */
export class AttestationError extends Error {
  constructor(
    message: string,
    public readonly variant: string = "General",
    public readonly source?: unknown,
  ) {
    super(message);
    this.name = "AttestationError";
  }
}

/** Errors from the input module (mirrors input::AnyInputError). */
export class AnyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyInputError";
  }
}

// --- Concrete AttestationError variants ---

export class RecordMustBeObjectError extends AttestationError {
  constructor(source?: unknown) {
    super("Record must be a JSON object", "RecordMustBeObject", source);
  }
}

export class MetadataMustBeObjectError extends AttestationError {
  constructor(source?: unknown) {
    super("Attestation metadata must be a JSON object", "MetadataMustBeObject", source);
  }
}

export class MetadataMissingFieldError extends AttestationError {
  constructor(field: string, source?: unknown) {
    super(`Attestation metadata missing required field: ${field}`, "MetadataMissingField", source);
  }
}

export class DagCborError extends AttestationError {
  constructor(message: string, source?: unknown) {
    super(`DAG-CBOR error: ${message}`, "DagCbor", source);
  }
}

export class InvalidSignatureError extends AttestationError {
  constructor(message: string, source?: unknown) {
    super(`Invalid signature: ${message}`, "InvalidSignature", source);
  }
}

export class SignatureDecodingFailedError extends AttestationError {
  constructor(message: string, source?: unknown) {
    super(`Signature decoding failed: ${message}`, "SignatureDecodingFailed", source);
  }
}

export class KeyResolutionError extends AttestationError {
  constructor(did: string, source?: unknown) {
    super(`Failed to resolve key for DID: ${did}`, "KeyResolution", source);
  }
}

export class JsonError extends AttestationError {
  constructor(message: string, source?: unknown) {
    super(`JSON error: ${message}`, "Json", source);
  }
}

export class InvalidProofError extends AttestationError {
  constructor(message: string, source?: unknown) {
    super(`Invalid proof: ${message}`, "InvalidProof", source);
  }
}

export class InvalidAttestationError extends AttestationError {
  constructor(message: string, source?: unknown) {
    super(`Invalid attestation: ${message}`, "InvalidAttestation", source);
  }
}

export class RecordResolutionError extends AttestationError {
  constructor(aturi: string, source?: unknown) {
    super(`Failed to resolve record at: ${aturi}`, "RecordResolution", source);
  }
}

export class DanglingProofError extends AttestationError {
  constructor(message: string, source?: unknown) {
    super(`Dangling proof: ${message}`, "DanglingProof", source);
  }
}

export class CidMismatchError extends AttestationError {
  constructor(expected: string, actual?: string, source?: unknown) {
    const msg = actual !== undefined
      ? `CID mismatch: expected ${expected}, got ${actual}`
      : expected; // Allow single message arg
    super(msg, "CidMismatch", source);
  }
}

export class UnsupportedKeyTypeError extends AttestationError {
  constructor(keyType: string, source?: unknown) {
    super(`Unsupported key type: ${keyType}`, "UnsupportedKeyType", source);
  }
}
