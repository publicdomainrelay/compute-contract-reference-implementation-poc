// @publicdomainrelay/hono-factory-atproto-repo — com.atproto.repo.* handlers
//
// Hono routes for record CRUD. Attached to the factory Hono app under /xrpc/.

import type { Context, Hono } from "@hono/hono";
import type { RepoApi, WriteOp, Cid, Did } from "../contracts.ts";
import { XrpcError } from "../contracts.ts";

// ── helpers ───────────────────────────────────────────────────────

function jsonError(c: Context, err: unknown, defaultStatus = 500): Response {
  // Hono types want ContentfulStatusCode; use Response directly for flexibility
  if (err instanceof XrpcError) {
    return new Response(JSON.stringify({ error: err.error, message: err.message }), {
      status: err.status,
      headers: { "content-type": "application/json" },
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Response(JSON.stringify({ error: "InvalidRequest", message: msg }), {
    status: defaultStatus,
    headers: { "content-type": "application/json" },
  });
}

/** Extract the requester's DID from auth context (set by auth middleware). */
function requesterDid(c: Context): Did {
  // Auth middleware sets this. For now, fall back to a header or query param.
  const did = c.get("requesterDid" as never) as string | undefined;
  if (did) return did;
  // Fallback: try to get from authorization header or query
  const fromQuery = c.req.query("did");
  if (fromQuery) return fromQuery;
  throw new XrpcError("AuthenticationRequired", "no DID in request context");
}

// ── routes ────────────────────────────────────────────────────────

export function mountRepoRoutes(app: Hono, repo: RepoApi): void {
  // POST /xrpc/com.atproto.repo.createRecord
  app.post("/xrpc/com.atproto.repo.createRecord", async (c) => {
    try {
      const did = requesterDid(c);
      const body = await c.req.json() as {
        collection: string;
        rkey?: string;
        record: unknown;
      };
      if (!body.collection || !body.record) {
        throw new XrpcError("InvalidRequest", "collection and record are required");
      }
      // Generate rkey if not provided
      const { nextTid } = await import("../util/tid.ts");
      const rkey = body.rkey ?? nextTid();

      const writes: WriteOp[] = [{
        action: "create",
        collection: body.collection,
        rkey,
        record: body.record,
      }];
      const evt = await repo.applyWrites(did, writes);
      const uri = `at://${did}/${body.collection}/${rkey}`;
      return c.json({ uri, cid: evt.commit });
    } catch (err) {
      return jsonError(c, err);
    }
  });

  // GET /xrpc/com.atproto.repo.getRecord
  app.get("/xrpc/com.atproto.repo.getRecord", async (c) => {
    try {
      const did = c.req.query("repo") ?? requesterDid(c);
      const collection = c.req.query("collection");
      const rkey = c.req.query("rkey");
      if (!collection || !rkey) {
        throw new XrpcError("InvalidRequest", "collection and rkey are required");
      }
      const record = await repo.getRecord(did, collection, rkey);
      if (!record) {
        throw new XrpcError("RecordNotFound", `record not found: ${collection}/${rkey}`);
      }
      return c.json(record);
    } catch (err) {
      return jsonError(c, err);
    }
  });

  // GET /xrpc/com.atproto.repo.listRecords
  app.get("/xrpc/com.atproto.repo.listRecords", async (c) => {
    try {
      const did = c.req.query("repo") ?? requesterDid(c);
      const collection = c.req.query("collection");
      if (!collection) {
        throw new XrpcError("InvalidRequest", "collection is required");
      }
      const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
      const cursor = c.req.query("cursor") ?? undefined;
      const result = await repo.listRecords(did, collection, { limit, cursor });
      return c.json(result);
    } catch (err) {
      return jsonError(c, err);
    }
  });

  // GET /xrpc/com.atproto.repo.describeRepo
  app.get("/xrpc/com.atproto.repo.describeRepo", async (c) => {
    try {
      const did = c.req.query("repo") ?? requesterDid(c);
      const desc = await repo.describe(did);
      return c.json(desc);
    } catch (err) {
      return jsonError(c, err);
    }
  });
}
