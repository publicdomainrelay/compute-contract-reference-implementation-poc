// Types derived from https://web.plc.directory/api/plc-server-openapi3.yaml and
// https://web.plc.directory/spec/v0.1/did-plc

export interface PlcService {
  type: string;
  endpoint: string;
}

/** Regular PLC operation (create or update). `prev` is null for genesis. */
export interface PlcOp {
  type: "plc_operation";
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: Record<string, PlcService>;
  prev: string | null;
  sig: string;
}

/** Permanently deactivates a DID. Irreversible after recovery window. */
export interface TombstoneOp {
  type: "plc_tombstone";
  prev: string;
  sig: string;
}

/** Deprecated genesis format — must still be handled for existing DIDs. */
export interface LegacyCreateOp {
  type: "create";
  signingKey: string;
  recoveryKey: string;
  handle: string;
  service: string;
  prev: string | null;
  sig: string;
}

export type Operation = PlcOp | TombstoneOp | LegacyCreateOp;

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export interface DidDocument {
  "@context"?: string[];
  id: string;
  alsoKnownAs?: string[];
  verificationMethod?: VerificationMethod[];
  service?: ServiceEndpoint[];
}

export interface LogEntry {
  did: string;
  operation: Operation;
  /** CID hash of the operation, string-encoded. */
  cid: string;
  /** True when overridden by a later valid operation (fork recovery). */
  nullified: boolean;
  createdAt: string;
}

export interface ExportOptions {
  /** Return entries created after this ISO timestamp (pagination cursor). */
  after?: string;
  /** Max entries to return (server default applies when omitted). */
  count?: number;
}

export interface HealthResponse {
  version: string;
}
