// Base64 helpers for signature bytes.
//
// badge.blue encodes signature bytes with the standard Base64 alphabet, padded;
// decoders accept both padded and unpadded input. atproto's JSON representation
// for `bytes` lexicon fields is the same encoding wrapped as `{ "$bytes": … }`,
// so these helpers serve both.

/** Encode bytes with the standard Base64 alphabet (padded). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode standard-alphabet Base64, accepting padded or unpadded input. */
export function base64ToBytes(b64: string): Uint8Array {
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A `bytes` value as it appears in atproto record JSON. */
export type BytesJson = { $bytes: string };

/** Accept a signature as raw bytes or its atproto JSON `{ $bytes }` form. */
export function asBytes(value: Uint8Array | BytesJson): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return base64ToBytes(value.$bytes);
}
