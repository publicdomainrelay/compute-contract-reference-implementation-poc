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
import { parseAtUri, type RecordRef } from "./resolve.ts";
import { strongRef, type StrongRef } from "./types.ts";
import { OFFERING_NSID, RECEIPT_NSID } from "@publicdomainrelay/lexicons";
import type { Logger } from "./types.ts";
import { createRemoteProofRecord, type RecordSigner } from "./signing.ts";

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

/** The strongRef'd records a market.receipt binds together. */
export interface ReceiptRefs {
  rfp: RecordRef;
  bid: RecordRef;
  accept: RecordRef;
  /** Proof-of-settlement record (the bid's payment/grant receipt). */
  payload: RecordRef;
  /** Service DID reference (did:web:HOST#compute_event) where teardown events are sent. */
  submitEvent: string;
}

/** The accept this receipt attests, as it lives in the requester's repo. */
export interface ReceiptSubject {
  /** The resolved accept record value (its `signatures` array is ignored). */
  acceptRecord: Record<string, unknown>;
  /** DID of the repository the accept lives in (the requester). */
  acceptRepositoryDid: string;
}

/**
 * Mint a market.receipt in the agent's own repo, binding the rfp, bid, accept,
 * and proof-of-settlement payload, and advertising where to send teardown
 * events. The receipt is a badge.blue remote attestation proof over the accept
 * (its `cid`) and carries the provider's inline signature. Returns a strongRef
 * to the created receipt.
 */
export function createReceiptRecord(
  agent: Agent,
  refs: ReceiptRefs,
  subject: ReceiptSubject,
  signer: RecordSigner,
): Promise<StrongRef> {
  return createRemoteProofRecord(
    agent,
    RECEIPT_NSID,
    {
      $type: RECEIPT_NSID,
      rfp: strongRef(refs.rfp.uri, refs.rfp.cid),
      bid: strongRef(refs.bid.uri, refs.bid.cid),
      accept: strongRef(refs.accept.uri, refs.accept.cid),
      payload: strongRef(refs.payload.uri, refs.payload.cid),
      submitEvent: refs.submitEvent,
      createdAt: new Date().toISOString(),
    },
    { subjectRecord: subject.acceptRecord, subjectRepositoryDid: subject.acceptRepositoryDid },
    signer,
  );
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

/**
 * Ensure the agent has exactly one offering record for the given `appliesTo`
 * NSIDs pointing at `expectedEndpoint`. Creates it if absent; updates in place
 * if the endpoint is stale. No-ops if already correct.
 */
export async function ensureOfferingRecord(
  agent: Agent,
  appliesTo: string[],
  expectedEndpoint: string,
  log: Logger,
): Promise<void> {
  const listRes = await agent.com.atproto.repo.listRecords({
    repo: agent.assertDid,
    collection: OFFERING_NSID,
    limit: 100,
  });
  const existing = listRes.data.records.find((r) => {
    const value = r.value as Record<string, unknown>;
    const at = value.appliesTo as string[] | undefined;
    return Array.isArray(at) && appliesTo.every((nsid) => at.includes(nsid));
  });
  if (existing) {
    const existingEndpoint = (existing.value as Record<string, unknown>).endpointUrl as string | undefined;
    if (existingEndpoint === expectedEndpoint) {
      log("info", "offering record exists", { uri: existing.uri });
      return;
    }
    const rkey = existing.uri.split("/").pop()!;
    await agent.com.atproto.repo.putRecord({
      repo: agent.assertDid,
      collection: OFFERING_NSID,
      rkey,
      record: {
        ...(existing.value as Record<string, unknown>),
        $type: OFFERING_NSID,
        endpointUrl: expectedEndpoint,
      },
    });
    log("info", "offering record updated", { uri: existing.uri, endpointUrl: expectedEndpoint });
    return;
  }
  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: OFFERING_NSID,
    record: {
      $type: OFFERING_NSID,
      endpointUrl: expectedEndpoint,
      appliesTo,
      createdAt: new Date().toISOString(),
    },
  });
  log("info", "offering record created", {
    ref: { $type: "com.atproto.repo.strongRef", uri: res.data.uri, cid: res.data.cid },
  });
}
