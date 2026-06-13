import { KeyType } from "./types.ts";
import { InvalidSignatureError } from "./errors.ts";

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
 * Normalizes an ECDSA signature to low-S form as required by the AT Protocol.
 *
 * For P-256 and K-256 curves, ensures the `s` component is at most n/2 where n
 * is the curve order. If `s > n/2`, it is replaced with `n - s`.
 *
 * @param signature - Raw 64-byte ECDSA signature (r || s, 32 bytes each).
 * @param keyType   - The elliptic curve key type (P256 or K256).
 * @returns A new Uint8Array containing the normalized signature.
 * @throws {InvalidSignatureError} if the signature is not exactly 64 bytes.
 */
export function normalizeSignature(
  signature: Uint8Array,
  keyType: KeyType,
): Uint8Array {
  if (signature.byteLength !== 64) {
    throw new InvalidSignatureError(
      `ECDSA signature must be 64 bytes (r||s), got ${signature.byteLength} bytes`,
    );
  }

  const n = (keyType === "P256Private" || keyType === "P256Public") ? P256_ORDER : K256_ORDER;
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
