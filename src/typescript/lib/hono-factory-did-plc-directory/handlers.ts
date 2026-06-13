// Route handlers for the did:plc Directory Server API.
//
// Implements the 6 endpoints from:
//   https://web.plc.directory/api/plc-server-openapi3.yaml

import type { Context, Hono } from "@hono/hono";
import { encode as cborEncode } from "@ipld/dag-cbor";
import type { LogEntry, Operation, PlcOp, TombstoneOp } from "@publicdomainrelay/did-plc";
import type { PlcStore } from "./storage/plc-store.ts";
import { resolveDidDocument } from "./did-resolution.ts";
import {
  validateOperationStructure,
  verifyOperationSignature,
  validatePrevChain,
  validateRotationKeyAuth,
  computeOperationCid,
} from "./validation.ts";

// ── deps ─────────────────────────────────────────────────────────

export interface HandlerDeps {
  store: PlcStore;
  version: string;
  /** Optional signature verifier. If omitted, sig verification is skipped (permissive). */
  verifySig?: (did: string, data: Uint8Array, sig: Uint8Array) => Promise<boolean>;
}

// ── helpers ──────────────────────────────────────────────────────

function didParam(c: Context): string {
  const did = c.req.param("did");
  if (!did) throw new Error("Missing DID parameter");
  return did;
}

function json(c: Context, body: unknown, status = 200): Response {
  return c.json(body, status as Parameters<typeof c.json>[1]);
}

// ── mount ────────────────────────────────────────────────────────

export function mountHandlers(app: Hono, deps: HandlerDeps): void {
  // GET /health
  app.get("/health", (c) => handleHealth(c, deps));

  // GET /export (must be before /:did to avoid route conflict)
  app.get("/export", (c) => handleExport(c, deps));

  // GET /:did
  app.get("/:did", (c) => handleResolveDid(c, deps));

  // POST /:did
  app.post("/:did", (c) => handleCreateOp(c, deps));

  // GET /:did/log
  app.get("/:did/log", (c) => handleGetLog(c, deps));

  // GET /:did/log/audit
  app.get("/:did/log/audit", (c) => handleGetAuditLog(c, deps));
}

// ── handlers ─────────────────────────────────────────────────────

async function handleHealth(c: Context, deps: HandlerDeps): Promise<Response> {
  return json(c, { version: deps.version });
}

async function handleResolveDid(c: Context, deps: HandlerDeps): Promise<Response> {
  const did = didParam(c);
  const ops = await deps.store.getCurrentOps(did);

  if (ops.length === 0) {
    return json(c, { message: `DID not registered: ${did}` }, 404);
  }

  // Check for tombstone
  const lastOp = ops[ops.length - 1].operation;
  if (lastOp.type === "plc_tombstone") {
    return json(c, { message: `DID not available: ${did}` }, 410);
  }

  const doc = resolveDidDocument(did, ops);
  if (!doc) {
    return json(c, { message: `DID not available: ${did}` }, 410);
  }

  return json(c, doc);
}

async function handleGetLog(c: Context, deps: HandlerDeps): Promise<Response> {
  const did = didParam(c);
  const ops = await deps.store.getCurrentOps(did);

  if (ops.length === 0) {
    return json(c, { message: `DID not registered: ${did}` }, 404);
  }

  return json(c, ops.map((e) => e.operation));
}

async function handleGetAuditLog(c: Context, deps: HandlerDeps): Promise<Response> {
  const did = didParam(c);
  const ops = await deps.store.getAuditLog(did);

  if (ops.length === 0) {
    return json(c, { message: `DID not registered: ${did}` }, 404);
  }

  return json(c, ops);
}

async function handleCreateOp(c: Context, deps: HandlerDeps): Promise<Response> {
  const did = didParam(c);

  // Parse body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return json(c, { message: "Invalid JSON body" }, 400);
  }

  // Structural validation
  const structErr = validateOperationStructure(body);
  if (structErr) {
    return json(c, { message: structErr }, 400);
  }

  const op = body as Operation;
  const existingOps = await deps.store.getAuditLog(did);
  const currentOps = await deps.store.getCurrentOps(did);

  // ── prev-chain validation (for plc_operation and plc_tombstone) ─
  if (op.type === "plc_operation" || op.type === "plc_tombstone") {
    const prevErr = validatePrevChain(op.prev, existingOps);
    if (prevErr) {
      return json(c, { message: prevErr }, 400);
    }

    // ── signature verification ──────────────────────────────────
    if (deps.verifySig) {
      // Determine which key signed: for genesis, any rotationKey is valid;
      // for update, signer must be in prev op's rotationKeys.
      if (op.prev !== null && currentOps.length > 0) {
        const prevOp = currentOps[currentOps.length - 1].operation;
        if (prevOp.type === "plc_operation") {
          // Try each rotation key to find the signer
          let validSig = false;
          for (const key of prevOp.rotationKeys) {
            if (await verifyOperationSignature(op, key, deps.verifySig)) {
              validSig = true;
              break;
            }
          }
          if (!validSig) {
            return json(c, { message: "Invalid Signature" }, 400);
          }
        }
      }
      // For genesis (prev === null), we verify after CID computation to
      // determine which rotation key created the DID (skip for now).
    }
  }

  // ── CID computation ────────────────────────────────────────────
  let cid: string;
  try {
    const signedBytes = cborEncode(op);
    cid = await computeOperationCid(signedBytes);
  } catch {
    return json(c, { message: "Failed to compute operation CID" }, 400);
  }

  // ── handle recovery (nullify overridden ops) ──────────────────
  // If prev points to a non-last op in the current chain, this is a
  // recovery operation. Nullify all ops after prev.
  if (op.type === "plc_operation" && op.prev !== null && currentOps.length > 0) {
    const prevIdx = currentOps.findIndex((e) => e.cid === op.prev);
    if (prevIdx >= 0 && prevIdx < currentOps.length - 1) {
      const toNullify = currentOps.slice(prevIdx + 1).map((e) => e.cid);
      await deps.store.nullifyOps(did, toNullify);
    }
  }

  // ── persist ────────────────────────────────────────────────────
  const entry: LogEntry = {
    did,
    operation: op,
    cid,
    nullified: false,
    createdAt: new Date().toISOString(),
  };

  await deps.store.insertOp(entry);

  return json(c, entry, 200);
}

async function handleExport(c: Context, deps: HandlerDeps): Promise<Response> {
  const afterStr = c.req.query("after");
  const countStr = c.req.query("count");

  let after: Date | undefined;
  if (afterStr) {
    after = new Date(afterStr);
    if (isNaN(after.getTime())) {
      return json(c, { message: "Invalid Query Parameter: after" }, 400);
    }
  }

  let count: number | undefined;
  if (countStr) {
    count = parseInt(countStr, 10);
    if (isNaN(count) || count < 0) {
      return json(c, { message: "Invalid Query Parameter: count" }, 400);
    }
    count = Math.min(count, 1000); // cap per OpenAPI spec
  }

  const entries = await deps.store.exportLogs(after, count);
  return json(c, entries);
}
