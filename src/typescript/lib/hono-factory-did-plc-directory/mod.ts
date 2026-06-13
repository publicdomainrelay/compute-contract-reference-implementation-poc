// @publicdomainrelay/hono-factory-did-plc-directory — public API
//
// A Deno + Hono factory that implements a local did:plc Directory Server.
// Exposes the standard PLC directory REST API for operation submission,
// DID resolution, audit logs, and bulk export.

// ── factory ───────────────────────────────────────────────────────
export {
  createPlcDirectoryFactory,
} from "./factory.ts";
export type {
  PlcDirectoryOptions,
  PlcDirectoryFactory,
  PlcStore,
} from "./factory.ts";

// ── storage ───────────────────────────────────────────────────────
export { MemoryPlcStore } from "./storage/plc-store.ts";

// ── validation (for advanced use) ─────────────────────────────────
export {
  validateOperationStructure,
  verifyOperationSignature,
  validatePrevChain,
  validateRotationKeyAuth,
  computeOperationCid,
} from "./validation.ts";

// ── did resolution (for advanced use) ─────────────────────────────
export { resolveDidDocument } from "./did-resolution.ts";
