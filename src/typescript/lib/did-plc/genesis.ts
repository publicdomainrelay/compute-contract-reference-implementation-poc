// Build and submit a did:plc genesis operation.
//
// DID derivation per spec v0.3.0:
//   sha256( dag-cbor( signed-op ) ) → first 15 bytes → base32lower → did:plc:<suffix>

import { encode as cborEncode } from "@ipld/dag-cbor";
import { base32 } from "multiformats/bases/base32";
import type { Operation, PlcOp, PlcService } from "./types.ts";

function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return new Uint8Array(buf);
}

export interface GenesisOptions {
  /** did:key public key strings — ordered, first has highest priority. */
  rotationKeys: string[];
  /** Map of VM/service ids to did:key signing keys. Defaults to empty. */
  verificationMethods?: Record<string, string>;
  /** Aliases (at:// URIs etc). Defaults to empty. */
  alsoKnownAs?: string[];
  /**
   * Service endpoints. Defaults to empty.
   *
   * Pass a function to derive services from the DID (two-pass: first derives
   * a preliminary DID with empty services, then rebuilds with the result).
   * The returned DID will differ slightly from the value passed to the
   * function — the endpoint URL uses a "close enough" preview DID.
   */
  services?:
    | Record<string, PlcService>
    | ((preliminaryDid: string) => Record<string, PlcService>);
  /** Sign raw bytes with the rotation key; return compact sig bytes. */
  sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

export interface GenesisResult {
  /** The derived did:plc identifier. */
  did: string;
  /** The signed genesis operation — ready to POST to the PLC directory. */
  op: Operation;
}

/**
 * Build a signed PlcOp genesis operation and derive the did:plc identifier.
 *
 * Example:
 * ```ts
 * import { Secp256k1Keypair } from "@atproto/crypto";
 * const kp = await Secp256k1Keypair.import(privateKeyBytes);
 * const { did, op } = await createGenesisOp({
 *   rotationKeys: [kp.did()],
 *   sign: (b) => kp.sign(b),
 * });
 * ```
 */
export async function createGenesisOp(opts: GenesisOptions): Promise<GenesisResult> {
  // Two-pass when services is a function: derive a preliminary DID with
  // empty services, feed it to the callback, then rebuild with the result.
  if (typeof opts.services === "function") {
    const servicesFn = opts.services;
    const { did: preliminaryDid } = await createGenesisOp({
      ...opts,
      services: {},
    });
    return createGenesisOp({ ...opts, services: servicesFn(preliminaryDid) });
  }

  const unsigned = {
    type: "plc_operation",
    rotationKeys: opts.rotationKeys,
    verificationMethods: opts.verificationMethods ?? {},
    alsoKnownAs: opts.alsoKnownAs ?? [],
    services: opts.services ?? {},
    prev: null,
  };

  const unsignedBytes = cborEncode(unsigned);
  const sigBytes = await opts.sign(unsignedBytes);
  const sig = toBase64url(sigBytes);

  const op = { ...unsigned, sig } as Operation;

  const signedBytes = cborEncode(op);
  const hash = await sha256(signedBytes);
  const did = "did:plc:" + base32.baseEncode(hash.slice(0, 15));

  return { did, op };
}
