// @publicdomainrelay/hono-factory-atproto-repo — com.atproto.sync.* handlers
//
// Hono routes for repo sync methods (non-subscription).

import type { Context, Hono } from "@hono/hono";
import type { RepoApi, Did, Storage } from "../contracts.ts";
import { XrpcError } from "../contracts.ts";
import { exportCar } from "../repo/car.ts";
import { decode as cborDecode } from "../cbor/dag-cbor.ts";

// ── helpers ───────────────────────────────────────────────────────

function jsonError(c: Context, err: unknown): Response {
  if (err instanceof XrpcError) {
    return new Response(JSON.stringify({ error: err.error, message: err.message }), {
      status: err.status,
      headers: { "content-type": "application/json" },
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Response(JSON.stringify({ error: "InvalidRequest", message: msg }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

// ── routes ────────────────────────────────────────────────────────

export interface SyncHandlerOptions {
  repo: RepoApi;
  storage: Storage;
}

export function mountSyncRoutes(app: Hono, opts: SyncHandlerOptions): void {
  // GET /xrpc/com.atproto.sync.getRepo
  app.get("/xrpc/com.atproto.sync.getRepo", async (c) => {
    try {
      const did = c.req.query("did");
      if (!did) throw new XrpcError("InvalidRequest", "did is required");

      const head = await opts.storage.getHead(did);
      if (!head) throw new XrpcError("RepoNotFound", `no repo for ${did}`);

      // Extract MST root CID from the commit block
      const commitBytes = await opts.storage.get(head.commit);
      if (!commitBytes) throw new XrpcError("RepoNotFound", "commit not found");
      const commit = cborDecode(commitBytes) as Record<string, unknown>;
      const rootCid = (commit.data as { $link: string })?.$link;
      if (!rootCid) throw new XrpcError("RepoNotFound", "MST root not found in commit");

      const carBytes = await exportCar(opts.storage, rootCid);
      return new Response(carBytes as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "application/vnd.ipld.car" },
      });
    } catch (err) {
      return jsonError(c, err);
    }
  });

  // GET /xrpc/com.atproto.sync.getLatestCommit
  app.get("/xrpc/com.atproto.sync.getLatestCommit", async (c) => {
    try {
      const did = c.req.query("did");
      if (!did) throw new XrpcError("InvalidRequest", "did is required");

      const desc = await opts.repo.describe(did);
      return c.json({ cid: desc.head ?? null, rev: desc.head ?? null });
    } catch (err) {
      return jsonError(c, err);
    }
  });

  // GET /xrpc/com.atproto.sync.getRecord
  app.get("/xrpc/com.atproto.sync.getRecord", async (c) => {
    try {
      const did = c.req.query("did");
      const collection = c.req.query("collection");
      const rkey = c.req.query("rkey");
      if (!did || !collection || !rkey) {
        throw new XrpcError("InvalidRequest", "did, collection, and rkey are required");
      }
      const record = await opts.repo.getRecord(did, collection, rkey);
      if (!record) {
        throw new XrpcError("RecordNotFound", `${collection}/${rkey}`);
      }
      return c.json(record);
    } catch (err) {
      return jsonError(c, err);
    }
  });
}
