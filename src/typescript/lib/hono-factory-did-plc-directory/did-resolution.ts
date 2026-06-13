// DID document resolution from PLC operation chains.
//
// Walks the current (non-nullified) operation log and accumulates state
// into a W3C DID Document.

import type {
  DidDocument,
  LogEntry,
  Operation,
  PlcOp,
  LegacyCreateOp,
} from "@publicdomainrelay/did-plc";

/**
 * Resolve a DID document from the current operation chain.
 *
 * Returns `null` if:
 *  - The chain is empty (DID not registered), OR
 *  - The last operation is a tombstone (DID deactivated).
 */
export function resolveDidDocument(
  did: string,
  currentOps: LogEntry[],
): DidDocument | null {
  if (currentOps.length === 0) return null;

  // Check if deactivated
  const lastOp = currentOps[currentOps.length - 1].operation;
  if (lastOp.type === "plc_tombstone") return null;

  // Accumulate state by walking all non-nullified ops in order
  let verificationMethods: Record<string, string> = {};
  let alsoKnownAs: string[] = [];
  let services: Record<string, { type: string; endpoint: string }> = {};

  for (const entry of currentOps) {
    const op = entry.operation;
    if (op.type === "plc_operation") {
      verificationMethods = { ...verificationMethods, ...op.verificationMethods };
      alsoKnownAs = dedupe([...alsoKnownAs, ...op.alsoKnownAs]);
      services = { ...services, ...op.services };
    } else if (op.type === "create") {
      // Legacy genesis: single signingKey + recoveryKey, handle, service URL
      verificationMethods = { atproto: op.signingKey, ...verificationMethods };
      if (op.handle) alsoKnownAs = dedupe([...alsoKnownAs, op.handle]);
      services = {
        atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: op.service },
        ...services,
      };
    }
  }

  // Build DID Document verificationMethods
  const vm: DidDocument["verificationMethod"] = [];
  for (const [id, key] of Object.entries(verificationMethods)) {
    const multibaseKey = key.startsWith("did:key:") ? key.slice("did:key:".length) : key;
    vm.push({
      id: `#${id}`,
      type: "Multikey",
      controller: did,
      publicKeyMultibase: multibaseKey,
    });
  }

  // Build DID Document services
  const svc: DidDocument["service"] = [];
  for (const [id, s] of Object.entries(services)) {
    svc.push({
      id: `#${id}`,
      type: s.type,
      serviceEndpoint: s.endpoint,
    });
  }

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
    ],
    id: did,
    alsoKnownAs: alsoKnownAs.length > 0 ? alsoKnownAs : undefined,
    verificationMethod: vm.length > 0 ? vm : undefined,
    service: svc.length > 0 ? svc : undefined,
  };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
