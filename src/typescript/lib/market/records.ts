// Small atproto repo helpers shared by market producers.
//
// Resolving referenced records is the receiver's job (see ./resolve.ts); these
// are the *write* side that producers (the spindle, the bidder) need to mint and
// retract the market.* records they author. They were duplicated verbatim in
// both reference services before living here. Each takes an authenticated
// `Agent` (or session-backed agent) — the library never logs you in for you.

import type { Agent } from "@atproto/api";
import { getPdsEndpoint } from "@atproto/common-web";
import type { IdResolver } from "@atproto/identity";
import { parseAtUri } from "./resolve.ts";
import { strongRef, type StrongRef } from "./types.ts";

/**
 * Create a record in the agent's own repo and return a strongRef to it. The
 * record should carry its own `$type` matching `collection`, the same as a
 * direct `com.atproto.repo.createRecord` call.
 */
export async function createRecord(
  agent: Agent,
  collection: string,
  record: Record<string, unknown>,
): Promise<StrongRef> {
  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection,
    record,
  });
  return strongRef(res.data.uri, res.data.cid);
}

/** Delete a record the agent authored, addressed by its strongRef (uri parsed). */
export async function deleteRecord(agent: Agent, ref: { uri: string }): Promise<void> {
  const { repo, collection, rkey } = parseAtUri(ref.uri);
  await agent.com.atproto.repo.deleteRecord({ repo, collection, rkey });
}

/** A record as returned by com.atproto.repo.listRecords. */
export type ListedRecord = { uri: string; cid: string; value: Record<string, unknown> };

/**
 * List every record in a repo's collection, following the cursor to exhaustion.
 * Reads over plain HTTP against the given PDS (no auth needed for public repos),
 * matching how producers discover, e.g., a bidder's offering collection. Stops
 * (returning what it has) on the first non-OK response.
 */
export async function listRecordsAll(
  pdsUrl: string,
  repo: string,
  collection: string,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<ListedRecord[]> {
  const limit = opts.limit ?? 100;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const out: ListedRecord[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", repo);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) break;
    const data = await res.json() as { records: Array<{ uri: string; cid: string; value: unknown }>; cursor?: string };
    for (const r of data.records) out.push({ uri: r.uri, cid: r.cid, value: r.value as Record<string, unknown> });
    cursor = data.cursor;
  } while (cursor);
  return out;
}

/** Resolve a DID to its PDS service endpoint via the supplied IdResolver. */
export async function resolvePds(idResolver: IdResolver, did: string): Promise<string> {
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`could not resolve did ${did}`);
  const pds = getPdsEndpoint(doc);
  if (!pds) throw new Error(`no pds endpoint for ${did}`);
  return pds;
}
