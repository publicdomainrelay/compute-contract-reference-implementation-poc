// @publicdomainrelay/hono-factory-atproto-repo — frozen contracts
//
// Phase 0, single author. Everything else depends on these interfaces.
// Do NOT edit without coordination — downstream workstreams import from here.
//
// Deno-first, isomorphic. No Node built-ins. Web APIs only.

// ── bytes / identity ──────────────────────────────────────────────

export type Bytes = Uint8Array;

/** CIDv1 string form (base32, e.g. "bafyreie...") */
export type Cid = string;

/** did:key or did:plc */
export type Did = string;

/** TID / rkey — clock-based sortable record key, 13 chars base32-sortable */
export type Tid = string;

// ── crypto ────────────────────────────────────────────────────────

export interface Signer {
  /** did:key for the signing key */
  did(): Did;
  /** Sign raw bytes. Returns the signature (not the bytes + sig). */
  sign(bytes: Bytes): Promise<Bytes>;
}

export interface Verifier {
  /** Verify a signature produced by a Signer with the given DID. */
  verify(did: Did, bytes: Bytes, sig: Bytes): Promise<boolean>;
}

// ── storage ───────────────────────────────────────────────────────

/** Content-addressed block store. */
export interface BlockStore {
  get(cid: Cid): Promise<Bytes | null>;
  put(cid: Cid, bytes: Bytes): Promise<void>;
  has(cid: Cid): Promise<boolean>;
}

/** Per-repo mutable head pointer. */
export interface RepoStore {
  getHead(did: Did): Promise<{ commit: Cid; rev: Tid } | null>;
  setHead(did: Did, head: { commit: Cid; rev: Tid }): Promise<void>;
}

/** Combined storage interface — both content-addressed blocks and repo heads. */
export interface Storage extends BlockStore, RepoStore {}

// ── firehose ──────────────────────────────────────────────────────

/** An operation recorded in a commit. */
export interface CommitOp {
  action: "create" | "update" | "delete";
  path: string;
  cid: Cid | null;
}

/**
 * Produced by the repo layer when applyWrites succeeds.
 * The sequencer consumes this to build a firehose frame.
 */
export interface CommitEvent {
  repo: Did;
  commit: Cid;
  rev: Tid;
  /** Previous rev, or null for the initial commit. */
  since: Tid | null;
  /** CARv1 bytes containing the new/changed blocks for this commit. */
  blocks: Bytes;
  ops: CommitOp[];
}

/** A dag-cbor-encodable firehose frame (the subscribeRepos #commit payload). */
export type SequencedFrame = Record<string, unknown>;

/**
 * Event sequencer. Assigns monotonic `seq` numbers, builds #commit frames,
 * and provides backfill + live streaming.
 */
export interface Sequencer {
  /** Append a commit event, assign a seq number, return the frame. */
  append(evt: CommitEvent): SequencedFrame;
  /** Replay events since a cursor (seq number). If `since` is undefined, start from 0. */
  backfill(since?: number): AsyncIterable<SequencedFrame>;
  /** Stream live events as they are appended. */
  live(): AsyncIterable<SequencedFrame>;
}

// ── record write API ──────────────────────────────────────────────

export interface WriteOp {
  action: "create" | "update" | "delete";
  collection: string;
  rkey: string;
  record?: unknown;
}

export interface RepoApi {
  /** Get repo metadata. */
  describe(did: Did): Promise<{ collections: string[]; head: Tid | null }>;
  /** Get a single record by AT-URI components. */
  getRecord(
    did: Did,
    collection: string,
    rkey: string,
  ): Promise<{ uri: string; cid: Cid; value: unknown } | null>;
  /** List records in a collection, with optional pagination. */
  listRecords(
    did: Did,
    collection: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ records: { uri: string; cid: Cid; value: unknown }[]; cursor?: string }>;
  /** Apply a batch of writes atomically, returning a commit event. */
  applyWrites(did: Did, writes: WriteOp[]): Promise<CommitEvent>;
}

// ── errors ────────────────────────────────────────────────────────

/** Canonical XRPC error names per atproto lexicon convention. */
export const XrpcErrorNames = {
  InvalidRequest: "InvalidRequest",
  AuthenticationRequired: "AuthenticationRequired",
  RecordNotFound: "RecordNotFound",
  RepoNotFound: "RepoNotFound",
  InvalidSwap: "InvalidSwap",
} as const;

export type XrpcErrorName = (typeof XrpcErrorNames)[keyof typeof XrpcErrorNames];

/**
 * Throw this in handlers; the factory's error middleware serializes it to a
 * standard atproto JSON error envelope: `{ error, message }`.
 */
export class XrpcError extends Error {
  readonly error: XrpcErrorName;
  readonly status: number;

  constructor(error: XrpcErrorName, message: string, status?: number) {
    super(message);
    this.error = error;
    this.status = status ?? (error === "AuthenticationRequired" ? 401 : 400);
    this.name = "XrpcError";
  }

  /** Return the JSON error envelope `{ error, message }`. */
  toJSON(): { error: string; message: string } {
    return { error: this.error, message: this.message };
  }
}
