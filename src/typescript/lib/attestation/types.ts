// Shared types for the attestation library.

/**
 * What signing needs from a keypair — satisfied by @atproto/crypto's
 * Secp256k1Keypair / P256Keypair (low-S signatures, did:key identifiers).
 */
export interface AttestationKeypair {
  /** did:key public-key reference for the verification side. */
  did(): string;
  /** ECDSA-sign the message (the attestation CID bytes). */
  sign(msg: Uint8Array): Promise<Uint8Array>;
}

/** Resolve the did:keys a DID's document vouches for. */
export type KeysForDid = (did: string) => Promise<string[]>;
