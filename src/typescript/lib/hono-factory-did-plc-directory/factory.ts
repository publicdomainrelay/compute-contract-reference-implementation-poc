// @publicdomainrelay/hono-factory-did-plc-directory — Factory assembly
//
// createPlcDirectoryFactory({ store?, version?, verifySig? })
//   → { app: Hono, store: PlcStore }
//
// Wires storage + validation + handlers into a ready-to-serve Hono app
// that implements the did:plc Directory Server API.

import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { MemoryPlcStore, type PlcStore } from "./storage/plc-store.ts";
import { mountHandlers, type HandlerDeps } from "./handlers.ts";

// ── types ─────────────────────────────────────────────────────────

export interface PlcDirectoryOptions {
  /** Operation store. Defaults to MemoryPlcStore. */
  store?: PlcStore;
  /** Server version string returned by /health. */
  version?: string;
  /**
   * Optional signature verifier.
   * Signature verification is skipped when omitted (permissive mode).
   */
  verifySig?: HandlerDeps["verifySig"];
}

export interface PlcDirectoryFactory {
  /** Ready-to-serve Hono app with all PLC directory routes mounted. */
  app: Hono;
  /** The operation store (exposed for testing/direct access). */
  store: PlcStore;
}

export type { PlcStore } from "./storage/plc-store.ts";

// ── factory ───────────────────────────────────────────────────────

export function createPlcDirectoryFactory(
  opts: PlcDirectoryOptions = {},
): PlcDirectoryFactory {
  const store = opts.store ?? new MemoryPlcStore();
  const version = opts.version ?? "0.1.0";

  const app = new Hono();

  // CORS — permissionless API
  app.use("*", cors());

  // Error middleware
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : "Internal Server Error";
    const status = err instanceof Error && "status" in err
      ? (err as Error & { status: number }).status
      : 500;
    return c.json({ message }, status as Parameters<typeof c.json>[1]);
  });

  // Mount all PLC directory routes
  mountHandlers(app, { store, version, verifySig: opts.verifySig });

  return { app, store };
}
