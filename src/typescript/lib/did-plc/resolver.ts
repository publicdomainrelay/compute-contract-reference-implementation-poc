// Key resolver for did:plc identities — compatible with the KeysForDid type
// exported by lib/market/attest.ts.  Pass the returned function directly to
// createDidKeyResolver or use it standalone for did:plc-specific resolution.
//
// Integration with attest.ts:
//   import { createPlcKeyResolver } from "@publicdomainrelay/did-plc";
//   // Use as a drop-in for attest.ts's createDidKeyResolver({ plcUrl }) when you
//   // want the full PlcClient capabilities (audit log, op submission, etc.) and
//   // a typed resolver in the same package.

import { PlcClient, type PlcClientOptions } from "./client.ts";
import type { DidDocument } from "./types.ts";

/** Same signature as KeysForDid in lib/market/attest.ts — intentionally compatible. */
export type KeysForDid = (did: string) => Promise<string[]>;

/**
 * Extract all verificationMethod public keys from a DID document as did:key strings.
 * Keys already in `did:key:` form are returned as-is; raw multibase values get the
 * `did:key:` prefix added.
 */
export function keysFromDidDocument(doc: DidDocument): string[] {
  if (!doc.verificationMethod) return [];
  return doc.verificationMethod.flatMap((vm) => {
    const key = vm.publicKeyMultibase;
    if (!key) return [];
    return [key.startsWith("did:key:") ? key : `did:key:${key}`];
  });
}

export interface PlcKeyResolverOptions extends PlcClientOptions {
  /** Cache resolved keys in memory. Default: true. */
  cache?: boolean;
}

/**
 * Build a KeysForDid resolver backed by the PLC directory.
 *
 * Resolves did:plc identifiers to the set of verificationMethod public keys
 * listed in their DID document (as did:key strings). Suitable for use with
 * `verifyInlineAttestation` and `createDidKeyResolver` in attest.ts.
 *
 * Example — verify a market attestation signed by a did:plc identity:
 *
 * ```ts
 * import { createPlcKeyResolver } from "@publicdomainrelay/did-plc";
 * import { verifyInlineAttestation } from "@publicdomainrelay/market/attest";
 *
 * const keysForDid = createPlcKeyResolver();
 * const signerKeys = await keysForDid("did:plc:ewvi7nxzyoun6zhxrhs64oiz");
 * // pass to verifyInlineAttestation via keyResolver or check manually
 * ```
 */
export function createPlcKeyResolver(opts: PlcKeyResolverOptions = {}): KeysForDid {
  const { cache: useCache = true, ...clientOpts } = opts;
  const client = new PlcClient(clientOpts);
  const cacheMap = useCache ? new Map<string, string[]>() : null;

  return async (did: string): Promise<string[]> => {
    if (cacheMap?.has(did)) return cacheMap.get(did)!;
    let keys: string[];
    try {
      const doc = await client.resolve(did);
      keys = keysFromDidDocument(doc);
    } catch {
      keys = [];
    }
    cacheMap?.set(did, keys);
    return keys;
  };
}

/**
 * Wrap a PlcClient as a KeysForDid resolver (re-uses an existing client).
 * Useful when you already have a PlcClient with custom options/fetch.
 */
export function plcClientAsKeyResolver(
  client: PlcClient,
  opts: { cache?: boolean } = {},
): KeysForDid {
  const useCache = opts.cache ?? true;
  const cacheMap = useCache ? new Map<string, string[]>() : null;

  return async (did: string): Promise<string[]> => {
    if (cacheMap?.has(did)) return cacheMap.get(did)!;
    let keys: string[];
    try {
      const doc = await client.resolve(did);
      keys = keysFromDidDocument(doc);
    } catch {
      keys = [];
    }
    cacheMap?.set(did, keys);
    return keys;
  };
}
