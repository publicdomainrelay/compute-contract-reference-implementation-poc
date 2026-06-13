// Re-export generated types from the OpenAPI spec.
// Hand-tuned augmentations for types the spec models loosely (untyped maps,
// bespoke JSON Lines responses, etc.).

export type {
  ClientOptions,
  CreatePlcOpData,
  CreatePlcOpError,
  CreatePlcOpErrors,
  CreatePlcOpResponses,
  DidDocument,
  ExportData,
  ExportError,
  ExportErrors,
  ExportResponse,
  ExportResponses,
  GetLastOpData,
  GetLastOpError,
  GetLastOpErrors,
  GetLastOpResponse,
  GetLastOpResponses,
  GetPlcAuditLogData,
  GetPlcAuditLogError,
  GetPlcAuditLogErrors,
  GetPlcAuditLogResponse,
  GetPlcAuditLogResponses,
  GetPlcDataData,
  GetPlcDataError,
  GetPlcDataErrors,
  GetPlcDataResponses,
  GetPlcOpLogData,
  GetPlcOpLogError,
  GetPlcOpLogErrors,
  GetPlcOpLogResponse,
  GetPlcOpLogResponses,
  LegacyCreateOp,
  LogEntry,
  Operation,
  PlcOp,
  ResolveDidData,
  ResolveDidError,
  ResolveDidErrors,
  ResolveDidResponse,
  ResolveDidResponses,
  TombstoneOp,
} from "./generated/types.gen.ts";

// ── Hand-tuned additions ──────────────────────────────────────────────

/** Service endpoint descriptor used inside a PLC operation. */
export interface PlcService {
  type: string;
  endpoint: string;
}

/** Pagination options for the /export endpoint. */
export interface ExportOptions {
  /** Return entries created after this ISO timestamp (pagination cursor). */
  after?: string;
  /** Max entries to return (server default applies when omitted). */
  count?: number;
}

/** Server health response (not in the OpenAPI spec). */
export interface HealthResponse {
  version: string;
}
