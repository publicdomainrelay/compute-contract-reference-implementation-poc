// Key management: load/generate signing keypairs and bind did:keys to DIDs.
//
// The services in this repo author records with PDS-hosted accounts, so they
// cannot sign with the account's repo signing key — they hold their own
// attestation keypair instead. To make signatures *bindable*, a service
// publishes the keypair's public half as a Multikey verificationMethod in the
// did:web document it already hosts, and names that did:web as `issuer` in the
// attestation metadata. Verifiers then bind `key` to the author DID or the
// issuer DID via createDidKeyResolver.

import { Secp256k1Keypair } from "@atproto/crypto";
import type { KeysForDid } from "./types.ts";

/**
 * Load a secp256k1 keypair from a hex-encoded private key, or generate a fresh
 * (exportable) one when absent. Pass e.g. Deno.env.get("ATTESTATION_PRIVATE_KEY_HEX");
 * generated keys do not survive restarts, so persist the hex for stable identity.
 */
export async function loadOrGenerateKeypair(privKeyHex?: string): Promise<Secp256k1Keypair> {
  if (privKeyHex) return await Secp256k1Keypair.import(privKeyHex, { exportable: true });
  return await Secp256k1Keypair.create({ exportable: true });
}

/**
 * The Multikey verificationMethod entry a service adds to its did:web document
 * so verifiers can bind its attestation did:key to that DID.
 */
export function attestationVerificationMethod(
  controller: string,
  keypairDid: string,
  fragment = "attestation",
): { id: string; type: "Multikey"; controller: string; publicKeyMultibase: string } {
  return {
    id: `${controller}#${fragment}`,
    type: "Multikey",
    controller,
    publicKeyMultibase: keypairDid.replace(/^did:key:/, ""),
  };
}

/** The slice of a DID document key binding needs. */
export interface DidDocumentLike {
  verificationMethod?: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>;
}

/** The slice of @atproto/identity's IdResolver key binding needs. */
export interface DidResolverLike {
  did: { resolve(did: string): Promise<DidDocumentLike | null> };
}

/**
 * Build a {@link KeysForDid} over an IdResolver: resolves the DID document and
 * returns every verificationMethod with a publicKeyMultibase as a did:key
 * (this includes the account's #atproto repo signing key and any Multikey a
 * service publishes in its did:web document). Results are cached for the
 * resolver's lifetime; unresolvable DIDs yield an empty list.
 */
export function createDidKeyResolver(idResolver: DidResolverLike): KeysForDid {
  const cache = new Map<string, string[]>();
  return async (did: string): Promise<string[]> => {
    const cached = cache.get(did);
    if (cached) return cached;
    let keys: string[] = [];
    try {
      const doc = await idResolver.did.resolve(did);
      keys = (doc?.verificationMethod ?? [])
        .filter((vm) => typeof vm.publicKeyMultibase === "string")
        .map((vm) => `did:key:${vm.publicKeyMultibase}`);
    } catch {
      keys = [];
    }
    cache.set(did, keys);
    return keys;
  };
}
