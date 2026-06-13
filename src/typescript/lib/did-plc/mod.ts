// High-level API (PlcClient class, error types)
export * from "./client.ts";
// Hand-tuned types + re-exports from generated OpenAPI types
export * from "./types.ts";
// Business logic
export * from "./resolver.ts";
export * from "./genesis.ts";
export * from "./keypair-state.ts";

// Low-level generated SDK — for consumers who want direct access to
// individual endpoint functions or the underlying fetch client.
// NOTE: In Deno, the generated request functions spread `client` into
// RequestInit, which Deno's Request constructor rejects. Use PlcClient
// (which detects Deno and works around this) instead.
export {
  createPlcOp,
  export_,
  getLastOp,
  getPlcAuditLog,
  getPlcData,
  getPlcOpLog,
  resolveDid,
} from "./generated/sdk.gen.ts";
export { createClient, createConfig } from "./generated/client/index.ts";
export type { Client } from "./generated/client/index.ts";
