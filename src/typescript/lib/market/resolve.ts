// AT-URI helpers and the strongRef resolution abstraction.
//
// The library never assumes how a caller wants to fetch records: a
// `RecordResolver` is injected into every server handler so consumers can share
// a single identity/cache layer, point at a fixture in tests, or reuse an
// existing helper (the reference bidder injects its own `resolveAs`). A default
// resolver built on @atproto/api is provided for the common case.

import { Agent } from "@atproto/api";
import { getPdsEndpoint } from "@atproto/common-web";
import type { IdResolver } from "@atproto/identity";
import type { Resolved } from "./types.ts";

export type AtUriParts = { repo: string; collection: string; rkey: string };

/** Split an at:// URI into its repo (authority), collection, and rkey. */
export function parseAtUri(uri: string): AtUriParts {
  const parts = uri.slice("at://".length).split("/");
  return { repo: parts[0], collection: parts[1], rkey: parts[2] };
}

/** The authority (repo DID/handle) portion of an at:// URI, without fragment. */
export function atUriAuthority(uri: string): string {
  return uri.replace("at://", "").split("/")[0];
}

/** The NSID of the record an at:// URI points at (its collection segment). */
export function nsidFromUri(uri: string): string {
  return parseAtUri(uri).collection;
}

/** A reference to a single record: the minimal shape a resolver needs. */
export type RecordRef = { uri: string; cid: string };

/** A stable key identifying one record *version*: `${uri}#${cid}`. */
export function refKey(ref: RecordRef): string {
  return `${ref.uri}#${ref.cid}`;
}

/** True when two refs point at the same record version (same uri and cid). */
export function refsEqual(a: RecordRef, b: RecordRef): boolean {
  return a.uri === b.uri && a.cid === b.cid;
}

/** Drop the `_uri`/`_cid` resolution annotations, recovering the bare record value. */
export function stripResolved<T>(resolved: Resolved<T>): T {
  const { _uri: _u, _cid: _c, ...rest } = resolved as Resolved<T> & Record<string, unknown>;
  return rest as unknown as T;
}

/**
 * Turn a resolved record into a `{ uri, cid, value }` triple — its strongRef
 * coordinates alongside the bare record value (resolution annotations stripped).
 */
export function resolvedRef<T>(resolved: Resolved<T>): { uri: string; cid: string; value: T } {
  return { uri: resolved._uri, cid: resolved._cid, value: stripResolved(resolved) };
}

/**
 * Resolves a strongRef (uri+cid) to the record value. Injected into handlers so
 * the transport and any caching/validation policy stay the caller's concern.
 */
export interface RecordResolver {
  resolve<T>(ref: RecordRef): Promise<Resolved<T>>;
}

export type CreateRecordResolverOptions = {
  /**
   * If set, every resolved record must carry a `version` equal to this value
   * (records without a `version` are treated as "0.0.0"). Mirrors the reference
   * bidder's guard against records written by a future, incompatible schema.
   */
  expectVersion?: string;
};

/** Thrown by the default resolver when `expectVersion` is set and mismatched. */
export class RecordVersionError extends Error {
  constructor(public readonly version: string, expected: string, public readonly uri: string) {
    super(`unexpected record version ${version} for ${uri}; expected ${expected}`);
    this.name = "RecordVersionError";
  }
}

/**
 * A default {@link RecordResolver} that resolves each record's repo to its PDS
 * via the supplied {@link IdResolver}, then reads the record with an
 * unauthenticated Agent. PDS endpoints are cached per-DID for the resolver's
 * lifetime.
 */
export function createRecordResolver(
  idResolver: IdResolver,
  opts: CreateRecordResolverOptions = {},
): RecordResolver {
  const pdsCache = new Map<string, string>();

  async function pdsForDid(did: string): Promise<string> {
    const cached = pdsCache.get(did);
    if (cached) return cached;
    const doc = await idResolver.did.resolve(did);
    if (!doc) throw new Error(`could not resolve did ${did}`);
    const pds = getPdsEndpoint(doc);
    if (!pds) throw new Error(`no pds for ${did}`);
    pdsCache.set(did, pds);
    return pds;
  }

  return {
    async resolve<T>(ref: RecordRef): Promise<Resolved<T>> {
      const { repo, collection, rkey } = parseAtUri(ref.uri);
      const pds = await pdsForDid(repo);
      const read = new Agent(new URL(pds));
      const res = await read.com.atproto.repo.getRecord({ repo, collection, rkey, cid: ref.cid });
      const value = res.data.value as Record<string, unknown>;
      if (opts.expectVersion !== undefined) {
        const version = (value.version as string | undefined) ?? "0.0.0";
        if (version !== opts.expectVersion) {
          throw new RecordVersionError(version, opts.expectVersion, ref.uri);
        }
      }
      return { ...(value as unknown as T), _uri: res.data.uri, _cid: res.data.cid ?? ref.cid };
    },
  };
}
