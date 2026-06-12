# PLAN — `@publicdomainrelay/hono-factory-atproto-repo`

A Deno + Hono factory that implements a minimal but real atproto **PDS repo
surface**: `com.atproto.repo.*` (record CRUD over a signed MST) and
`com.atproto.sync.subscribeRepos` (the firehose). Storage and crypto are
**pluggable** so the same code runs on a Deno server (filesystem / Deno KV,
native crypto) or in a browser (IndexedDB, WebCrypto / `@atproto/crypto`).

- [ ] HTTP server as Hono Factory
- [ ] Account database with actor + account tables and migrations
- [ ] Actor store database per user with record + blob + repo tables
- [ ] Sequencer database with ordered event log
- [ ] Blob storage
- [ ] Keypair generation (secp256k1) and storage (webcrypto if in bowser)
- [ ] Repo data structures (MST, blocks, CAR, commits)
- [ ] Record validation against lexicon schemas
- [ ] `/xrpc/_health` endpoint
- [ ] `/.well-known/atproto-did` endpoint
- [ ] `com.atproto.server.describeServer` — returns server metadata
- [ ] `com.atproto.server.createAccount` — creates account + repo
- [ ] `com.atproto.server.createSession` — login + JWT issuance
- [ ] `com.atproto.server.refreshSession` — token rotation
- [ ] `com.atproto.repo.createRecord` — write a single record
- [ ] `com.atproto.repo.getRecord` — read a record
- [ ] `com.atproto.repo.uploadBlob` — upload blob
- [ ] `com.atproto.sync.getRepo` — export repo as CAR
- [ ] `com.atproto.sync.subscribeRepos` — WebSocket event stream
- [ ] `com.atproto.identity.resolveHandle` — handle → DID
- [ ] `com.atproto.identity.updateHandle` — change handle
- [ ] AppView pipethrough via Xrpc Atproto Service Proxying for `app.bsky.*` methods
- [ ] Auth verifier with access/refresh/admin token methods

The output is a factory:

```ts
const repo = createRepoFactory({ storage, signer, sequencer });
// repo.app        : Hono            → plug into createSubscriberFactory({ app })
// repo.subscribe  : SubscribeHandler → plug into runSubscriber({ subscribe })
```

It drops straight into the existing relay seams:

- `lib/hono-factory-xrpc-subscriber` → `createSubscriberFactory({ app: repo.app })`
  routes inbound `#request` frames into the Hono app.
- `lib/xrpc-relay` `SubscribeHandler = (sub, emit) => () => void` →
  `repo.subscribe` streams firehose frames to each subscriber.

So a subscriber registered against `xrpc-test.fedproxy.com` becomes a working
PDS-like endpoint reachable at `https://<subdomain>.<dispatcher>/xrpc/...`.

---

## Why this shape

This is the natural extension of work already in the tree:

- The subscribe seam was deliberately decoupled from the WebSocket
  (`SubscribeHandler`), so the firehose is "just another event source".
- `createSubscriberFactory` already bridges `#request` frames → `app.fetch()`.
- Crypto is already isomorphic (`@atproto/crypto`, isomorphic base64 in
  `lib/xrpc-relay/subscriber.ts`).

This plan only adds: a real repo (MST + signed commits + CAR), real handlers,
and a sequencer/firehose — behind storage and crypto interfaces.

## Shared infrastructure to reuse

- **`@publicdomainrelay/event-bus`** (`lib/event-bus/mod.ts`) — a tiny, typed,
  isomorphic synchronous fan-out bus (`subscribe(fn) => disposer`, `publish(msg)`).
  Its `subscribe` already returns a disposer, so it satisfies the
  `SubscribeHandler` contract directly: `subscribe: (sub, emit) => bus.subscribe(emit)`.
  The web demo (`web-client-example`) already uses it to stream request activity.

  **Reuse it as the live-delivery layer of the firehose `Sequencer`
  (Workstream F).** Do **not** rebuild fan-out. The sequencer's job is the part
  the bus does not do: assigning `seq`, building `#commit` frames, and replaying
  backlog for `cursor` backfill. If the firehose needs more than the bus offers
  (e.g. a bounded replay buffer, async backpressure, or per-`nsid` topics),
  **extend `lib/event-bus`** with those capabilities (kept generic and isomorphic)
  rather than forking a private copy — other consumers benefit.

---

## Ground rules for ALL agents

1. **Deno-first, isomorphic.** No Node built-ins. No `node:` specifiers. No
   `Buffer`. Use Web APIs (`crypto.subtle`, `TextEncoder`, `Uint8Array`). If you
   need base64/hex, copy the isomorphic helpers from
   `lib/xrpc-relay/subscriber.ts` into `util/bytes.ts` (Workstream A owns it).
2. **Interfaces are frozen in Phase 0.** Everything in `contracts.ts` is the
   coordination boundary. Do **not** edit another workstream's files. If a
   contract is wrong, raise it — do not unilaterally change it.
3. **File ownership is exclusive.** Each workstream owns a directory. No two
   agents write the same file. Shared types live only in `contracts.ts`
   (Phase 0, single author).
4. **Lexicon-accurate.** Match the real atproto lexicons for request/response
   shapes and error names (`InvalidRequest`, `RecordNotFound`, etc.). Vendor the
   lexicon JSON (Workstream F) — do not invent field names.
5. **Pure core, impure edges.** `repo/` and `mst/` must be pure (only depend on
   `contracts.ts` interfaces). Storage/crypto concretes live in their own dirs.
6. **Every workstream ships tests** under `test/` mirroring its dir. Deno test.
   `deno task test` must pass before a workstream is "done".

---

## Module / file map

```
lib/hono-factory-atproto-repo/
  deno.json                 # tasks: test, check, fmt
  mod.ts                    # public exports (Workstream G)
  contracts.ts              # FROZEN interfaces — Phase 0, single author
  util/
    bytes.ts                # hex/base64/utf8 (isomorphic)        [A]
    cid.ts                  # CIDv1 dag-cbor sha256               [A]
    tid.ts                  # TID rev generator (clock+random)    [A]
  cbor/
    dag-cbor.ts             # deterministic dag-cbor enc/dec      [A]
  crypto/
    signer.ts               # Signer/Verifier impls (deno+browser)[B]
  storage/
    memory.ts               # in-memory BlockStore+RepoStore      [C]
    deno-kv.ts              # Deno KV impl                        [C]
    indexeddb.ts            # browser IndexedDB impl              [C]
  mst/
    mst.ts                  # Merkle Search Tree                  [D]
  repo/
    repo.ts                 # commit build/sign, apply writes     [E]
    car.ts                  # CAR v1 encode (export) + decode     [E]
  handlers/
    repo.ts                 # com.atproto.repo.* routes           [E]
    sync.ts                 # com.atproto.sync.* routes (non-sub) [F]
  firehose/
    sequencer.ts            # seq assignment + commit→frame       [F]
    subscribe.ts            # SubscribeHandler impl               [F]
  lexicons/
    *.json                  # vendored lexicons + index           [F]
  factory/
    factory.ts              # createRepoFactory assembly          [G]
  test/                     # mirrors dirs                        [each]
  PLAN.md
```

Bracketed letters = owning workstream.

---

## Phase 0 — `contracts.ts` (BLOCKING, single author, ~1 short session)

Nothing else starts until this lands and is reviewed. Defines:

```ts
// ── bytes / identity ──────────────────────────────────────────────
export type Bytes = Uint8Array;
export type Cid = string;            // base32 CIDv1 string form
export type Did = string;
export type Tid = string;            // rev / rkey clock id

// ── crypto ────────────────────────────────────────────────────────
export interface Signer {
  did(): Did;                        // did:key for the signing key
  sign(bytes: Bytes): Promise<Bytes>;
}
export interface Verifier {
  verify(did: Did, bytes: Bytes, sig: Bytes): Promise<boolean>;
}

// ── storage ───────────────────────────────────────────────────────
export interface BlockStore {              // content-addressed blocks
  get(cid: Cid): Promise<Bytes | null>;
  put(cid: Cid, bytes: Bytes): Promise<void>;
  has(cid: Cid): Promise<boolean>;
}
export interface RepoStore {               // per-repo mutable head
  getHead(did: Did): Promise<{ commit: Cid; rev: Tid } | null>;
  setHead(did: Did, head: { commit: Cid; rev: Tid }): Promise<void>;
}
export interface Storage extends BlockStore, RepoStore {}

// ── firehose ──────────────────────────────────────────────────────
export interface CommitEvent {       // produced by repo, consumed by sequencer
  repo: Did;
  commit: Cid;
  rev: Tid;
  since: Tid | null;
  blocks: Bytes;                     // CAR slice of new blocks
  ops: { action: 'create' | 'update' | 'delete'; path: string; cid: Cid | null }[];
}
export type SequencedFrame = Record<string, unknown>; // dag-cbor-able #commit frame
export interface Sequencer {
  append(evt: CommitEvent): SequencedFrame;            // assigns seq, builds frame
  backfill(since?: number): AsyncIterable<SequencedFrame>;
  live(): AsyncIterable<SequencedFrame>;
}

// ── record write API (used by handlers) ───────────────────────────
export interface WriteOp {
  action: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  record?: unknown;
}
export interface RepoApi {
  describe(did: Did): Promise<{ collections: string[]; head: Tid | null }>;
  getRecord(did: Did, collection: string, rkey: string): Promise<{ uri: string; cid: Cid; value: unknown } | null>;
  listRecords(did: Did, collection: string, opts?: { limit?: number; cursor?: string }): Promise<{ records: { uri: string; cid: Cid; value: unknown }[]; cursor?: string }>;
  applyWrites(did: Did, writes: WriteOp[]): Promise<CommitEvent>;
}
```

Also export an `XrpcError` helper + canonical error names. Acceptance:
`deno check contracts.ts` passes; every downstream import resolves against it.

---

## Workstreams (parallel after Phase 0)

Each entry: **scope · owns · depends on · acceptance**.

### A. Primitives — bytes, CBOR, CID, TID
- **Scope:** isomorphic byte helpers; deterministic DAG-CBOR encode/decode;
  CIDv1 (dag-cbor codec `0x71`, sha256 `0x12`) compute + parse; TID generator
  (monotonic clock id, base32-sortable).
- **Owns:** `util/bytes.ts`, `util/cid.ts`, `util/tid.ts`, `cbor/dag-cbor.ts`,
  their tests.
- **Depends on:** `contracts.ts` only.
- **Acceptance:** round-trip CBOR for ints/strings/bytes/maps/arrays/CID-links;
  CID of a fixed block matches a known atproto vector; TIDs strictly increasing
  and 13 chars. **This is the critical-path dep for D and E — prioritize.**

### B. Crypto — Signer/Verifier
- **Scope:** `Signer`/`Verifier` impls. Default to `@atproto/crypto`
  `Secp256k1Keypair` (works in Deno + browser). Provide `signerFromKeypair(kp)`
  and `signerFromPrivateKeyHex(hex)`; `did()` returns `did:key`. Verifier
  resolves `did:key` → pubkey and checks signature.
- **Owns:** `crypto/signer.ts`, tests.
- **Depends on:** `contracts.ts`, `util/bytes.ts` (A).
- **Acceptance:** sign→verify round-trip in both runtimes; `did()` matches the
  DID produced by the existing relay subscriber for the same key.

### C. Storage backends
- **Scope:** three `Storage` impls behind the same interface: `memory.ts`
  (Map-based, canonical/reference), `deno-kv.ts` (Deno KV), `indexeddb.ts`
  (browser; guard so it tree-shakes out of Deno builds).
- **Owns:** `storage/*.ts`, tests (memory + KV under Deno; IndexedDB behind a
  feature check / `@deno-types` shim or skipped in CI with a note).
- **Depends on:** `contracts.ts`, `util/bytes.ts` (A).
- **Acceptance:** a shared conformance test suite (export it) passes for memory
  and Deno KV: put/get/has, head get/set, overwrite, missing→null.

### D. MST — Merkle Search Tree
- **Scope:** atproto MST: insert/update/delete/get over `path → CID` leaves,
  fanout by leading-zero count of sha256(key), node serialization to DAG-CBOR,
  root CID, and diff (old root vs new root → changed/removed blocks) for commit
  block-slices.
- **Owns:** `mst/mst.ts`, tests.
- **Depends on:** `contracts.ts`, A (CBOR/CID), C-interface (BlockStore).
- **Acceptance:** insert N records → deterministic root CID stable across runs;
  diff yields exactly the new node blocks; matches an atproto MST test vector
  if available, else internal golden.

### E. Repo core + `com.atproto.repo.*` handlers
- **Scope:** `repo.ts` — load head, `applyWrites` (build new MST, collect new
  blocks, build + **sign** commit `{ did, version:3, data:<mstRoot>, rev, prev }`,
  persist, return `CommitEvent`). `car.ts` — CAR v1 export (`getRepo`) and the
  per-commit block slice. `handlers/repo.ts` — Hono routes:
  `getRecord`, `listRecords`, `describeRepo`, `createRecord`, `putRecord`,
  `deleteRecord`, `applyWrites`. Implements `RepoApi`.
- **Owns:** `repo/repo.ts`, `repo/car.ts`, `handlers/repo.ts`, tests.
- **Depends on:** `contracts.ts`, A, B (Signer), C-interface, D (MST).
- **Acceptance:** createRecord→getRecord round-trip; deleteRecord removes;
  listRecords paginates; commit signature verifies (B.Verifier); CAR export
  re-imports to the same root. Error shapes match lexicon (`RecordNotFound`,
  `InvalidRequest`).

### F. Sync + firehose + lexicons
- **Scope:** `sequencer.ts` — assign `seq`, turn `CommitEvent` → subscribeRepos
  `#commit` frame (`seq, repo, commit, rev, since, blocks, ops, time`), keep a
  bounded backlog for backfill-by-cursor. `subscribe.ts` — the
  `SubscribeHandler`: on subscribe, optionally backfill from `cursor` param then
  stream live frames via `emit`; return a disposer that detaches. `handlers/sync.ts`
  — `getRepo`, `getLatestCommit`, `getRecord` (sync variant). `lexicons/` —
  vendor the relevant `com.atproto.repo.*` and `com.atproto.sync.*` lexicon JSON
  + a small validator.
- **Owns:** `firehose/*.ts`, `handlers/sync.ts`, `lexicons/*`, tests.
- **Depends on:** `contracts.ts`, A, `@publicdomainrelay/event-bus` (live
  fan-out — reuse, extend if needed), and the `CommitEvent` contract from E
  (interface only — not E's impl).
- **Acceptance:** applyWrites → sequencer emits a frame with correct `ops` and
  monotonic `seq`; a subscriber with `cursor=0` gets backfill then live; cursor
  resume skips already-seen seqs; frame validates against vendored lexicon.

### G. Factory assembly + public API
- **Scope:** `factory/factory.ts` — `createRepoFactory({ storage, signer, did?,
  sequencer? })` wires storage+crypto+repo+handlers+firehose and returns
  `{ app: Hono, subscribe: SubscribeHandler, api: RepoApi }`. `mod.ts` — curated
  public exports. A `deno.json` with `test`/`check`/`fmt` tasks.
- **Owns:** `factory/factory.ts`, `mod.ts`, `deno.json`.
- **Depends on:** ALL (integration). Starts skeleton early against `contracts.ts`;
  finalizes last.
- **Acceptance:** end-to-end Deno test: build factory with memory storage →
  drive `app.fetch()` for create/get/list → assert a matching firehose frame was
  delivered to a `subscribe` consumer. No relay required (in-process).

---

## Dependency graph / sequencing

```
Phase 0:  contracts.ts ────────────────┐
                                        ▼
Phase 1 (parallel):  A (primitives)   B (crypto)   F.lexicons
                          │  │            │
Phase 2 (parallel):       │  └─► D (MST)  │     C (storage)
                          └─────────────► E (repo+handlers) ◄── B, C, D
                                          │
Phase 3:                 F.firehose/sync (needs CommitEvent shape from E-contract)
                                          │
Phase 4:                 G (factory + e2e wiring)
```

A is the long pole of Phase 1 — staff it first/heaviest. B, C, F.lexicons can
run fully concurrently. D needs A. E needs A+B+C+D. F.firehose needs only the
`CommitEvent` contract (so it can start in Phase 1 against stubs).

---

## Integration with the existing relay (Workstream G + demo)

After G lands, wire it where the demo currently mounts the toy Hono app:

```ts
// web-client-example/src/lib/relay-subscriber.ts (replaces buildDemoApp)
const repo = createRepoFactory({
  storage: new IndexedDbStorage('relay-demo'),
  signer:  signerFromKeypair(this.#keypair),   // browser crypto
});
const factory = createSubscriberFactory({ app: repo.app });
this.#ctrl = runSubscriber({
  ...,
  handleRequest: factory.handleRequest,
  subscribe: repo.subscribe,                   // real firehose, not synthetic
});
```

Deno server consumers do the same with `denoKvStorage()` + a native signer.

Acceptance for integration (manual / e2e): against `xrpc-test.fedproxy.com`,
`createRecord` via `https://<subdomain>/xrpc/com.atproto.repo.createRecord`
returns a uri+cid, and a `com.atproto.sync.subscribeRepos` caller (the existing
`xrpc-relay/client-of-client-example.ts`) receives the matching `#commit` frame.

---

## Testing strategy

- **Unit per workstream** under `test/` (Deno test). Pure modules (A/D/E-core)
  get golden-vector tests; prefer real atproto vectors where available.
- **Storage conformance suite** (C exports it; run against each backend).
- **End-to-end in-process** (G): no network — `app.fetch()` + a `subscribe`
  consumer assert the write/firehose contract.
- **Live smoke** (manual, post-integration): drive through the relay against
  `xrpc-test` with the browser demo + `client-of-client-example.ts`.

---

## Risks / call-outs

- **DAG-CBOR determinism** (A) is the correctness keystone — wrong canonical
  ordering ⇒ wrong CIDs ⇒ nothing verifies. Lock it with vectors first.
- **MST parity** (D) is the second keystone; if exact atproto-byte-parity is not
  required for this milestone, state that explicitly and use internal goldens.
- **IndexedDB in Deno CI** (C) — guard import; skip its tests in Deno with a
  documented note rather than faking the API.
- **Scope fence:** auth/handle-resolution/blob storage/account mgmt are **out of
  scope** for v1. Repo CRUD + firehose only. A single signing key per factory
  instance (`signer.did()`), no multi-tenant repos in v1.
- **Sequencer durability:** in-memory backlog only for v1; persistent cursor
  store is a follow-up (note it, don't build it).
```

---

# Personal Data Server (PDS) Notes

This document describes what it means to implement an AT Protocol Personal Data Server (PDS). It is a complete, agent-executable plan derived from the TypeScript reference implementation in this monorepo.

## 1. What a PDS Is

A PDS is a single-tenant atproto server. Each user's data lives on exactly one PDS, but one PDS hosts many users. The PDS is the user's "home server" — it holds their account, their signed repository of records, their blobs, and their identity keys. Other services (AppViews, feed generators, labelers) read from PDSes; the PDS is the write path and the canonical storage layer.

## 2. Core Responsibilities

1. **Account Management** — create, update, deactivate, delete, takedown accounts. Handles email verification, password reset, app passwords, invite codes.
2. **Identity** — manage DIDs (did:plc), handles, signing keys. Expose `/.well-known/atproto-did` for handle-to-DID resolution.
3. **Repository (Repo)** — each account has a signed Merkle Search Tree (MST) repo. The PDS stores the full repo, validates writes, signs commits, and exposes the repo via XRPC.
4. **Blob Storage** — store and serve blobs (images, etc.) referenced in records.
5. **Sequencer** — emit a globally-ordered event stream of all mutations (commits, account events, identity changes, sync events) across all accounts on that PDS.
6. **Auth / OAuth** — authenticate users via OAuth 2.0 / DPoP, issue access/refresh tokens, validate service auth tokens for inter-service calls.
7. **XRPC API** — implement all `com.atproto.*` lexicon methods that a PDS is responsible for, and proxy or pass-through `app.bsky.*` methods to an AppView.
8. **Rate Limiting** — per-endpoint rate limiting with bypass support.
9. **Well-Known Endpoints** — `/.well-known/atproto-did` for handle resolution, `/.well-known/oauth-protected-resource` for OAuth metadata.

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                        PDS                               │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Express App  │  │ OAuth        │  │ Rate Limiter  │  │
│  │ (routes)     │  │ Middleware   │  │               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│  ┌──────┴─────────────────┴───────────────────┴───────┐  │
│  │                 AppContext                         │  │
│  │  (holds all service dependencies)                  │  │
│  └──────┬───────┬───────┬───────┬───────┬────────────┘  │
│         │       │       │       │       │                │
│  ┌──────┴┐ ┌────┴──┐ ┌──┴───┐ ┌─┴─────┐ ┌┴──────────┐  │
│  │Account│ │Actor  │ │Seque-│ │Auth   │ │Pipethrough │  │
│  │Manager│ │Store  │ │ncer  │ │Verif. │ │(to AppView)│  │
│  └───┬───┘ └───┬───┘ └──┬───┘ └───┬───┘ └─────┬──────┘  │
│      │         │         │         │            │          │
│  ┌───┴───┐ ┌───┴───┐ ┌───┴────┐ ┌──┴────┐ ┌───┴──────┐  │
│  │Databse│ │Databse│ │Database│ │Memcache│ │External  │  │
│  │(acct) │ │(repo) │ │(seq)   │ │(scratch│ │AppView   │  │
│  │       │ │       │ │        │ │ cache) │ │          │  │
│  └───────┘ └───────┘ └────────┘ └───────┘ └──────────┘  │
│                                                          │
│  ┌──────────────────┐  ┌────────────────────────────┐    │
│  │ Blob Store       │  │ Background Queue           │    │
│  │                  │  │                            │    │
│  └──────────────────┘  └────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

## 4. Implementation Phases

### Phase 1: Foundation — Data Layer

#### 4.1 Databases

The PDS uses three separate databases:

**A. Account Database** (`account-manager/db/`)
- Location: configured via `accountDbLoc`
- Tables:
  - `actor` — did, handle, createdAt, takedownRef, deactivatedAt, deleteAfter
  - `account` — did, email, emailConfirmedAt, passwordScrypt, invitesDisabled
  - `refresh_token` — id (jti), did, appPasswordName, expiresAt, nextId
  - `used_refresh_token` — id, did
  - `app_password` — did, name, passwordScrypt, createdAt, privileged
  - `email_token` — id, did, purpose, token, requestedAt, expiresAt
  - `invite_code` — code, availableUses, disabled, forUser, createdBy, createdAt
  - `invite_code_use` — code, usedBy, usedAt
  - `repo_root` — did, cid, rev, indexedAt
  - `authorization_request` — id, did, clientId, scope, state, ...
  - `authorized_client` — id, did, clientId, scope, ...
  - `device` — id, did, ...
  - `account_device` — accountDid, deviceId, ...
  - `lexicon` — (schema storage for lexicons)
- Kysely query builder over better-sqlite3
- Migrations: 001-init through 007-lexicon-failures-index

**B. Actor Store Database** (per-user, `actor-store/db/`)
- Location: `{dataDir}/{didHash[0:2]}/{did}/store.sqlite`
- Each user gets their own database
- Tables:
  - `repo_root` — did, cid, rev, indexedAt
  - `record` — uri, cid, collection, rkey, repoRev, indexedAt, takedownRef
  - `repo_block` — cid, repoRev, size, content
  - `blob` — cid, mimeType, size, tempKey, createdAt, takedownRef
  - `record_blob` — recordUri, blobCid
  - `backlink` — uri, path, linkTo, linkFrom (for reverse lookups)
  - `account_pref` — id, valueJson (user preferences)

**C. Sequencer Database** (`sequencer/db/`)
- Location: configured via `repoDbLoc` (shared across all accounts)
- Tables:
  - `repo_seq` — seq (autoincrement), did, eventType, event (CBOR), sequencedAt

#### 4.2 Blob Storage

Interface: `BlobStore` (from `@atproto/repo`)
- `putTemp(bytes)` → `string` (temp key)
- `makePermanent(tempKey, cid)` → `void`
- `putPermanent(cid, bytes)` → `void`
- `getBytes(cid)` → `Uint8Array`
- `delete(cid)` → `void`
- `deleteMany(cids)` → `void`

#### 4.3 Key Management

- Each account has an **secp256k1** keypair
- Key stored at `{dataDir}/{didHash[0:2]}/{did}/key`
- Keys are `exportable` (can be exported as raw bytes for PLC rotation)
- Reserved keypair directory: `{dataDir}/reserved_keys/{did}`
- Keypair used for: signing repo commits, signing service auth tokens, PLC operations

### Phase 2: Repo System

#### 4.4 Repository (Merkle Search Tree)

The `@atproto/repo` package implements the core repo data structure:
- **MST** (`mst/`) — Merkle Search Tree. A content-addressed key-value store. Each node is a CBOR-encoded block identified by CID. Keys are sorted strings, values are CIDs.
- **Repo** (`repo.ts`) — wraps MST. Each commit produces a new CID. Repo is signed by the account key.
- **BlockMap** (`block-map.ts`) — tracks blocks by CID for CAR file construction.
- **CAR** (`car.ts`) — Content-Addressable Archive format for transporting blocks.
- **DataDiff** (`data-diff.ts`) — computes add/update/delete operations between repo versions.
- **Storage** (`storage/`) — read/write interface for repo blocks.
- **Sync** (`sync/`) — sync protocol helpers for inter-PDS repo transfer.

Key concepts:
- Records are stored at paths like `{collection}/{rkey}` (e.g., `app.bsky.feed.post/3jkv7...`)
- Each write creates a signed commit with: new CID, revision string, previous CID, operations array
- The `since` field points to the previous commit CID (null for first commit)
- Operations include: `action` (create/update/delete), `path`, `cid`, `prev`
- Blobs referenced in records are discovered via `$build` enumeration and stored separately

#### 4.5 Repo Prepare & Commit

`repo/prepare.ts` handles:
1. **Record validation** — validates records against known lexicon schemas
2. **Blob discovery** — `$build` over the record to find all blob references (`TypedBlobRef`, `LegacyBlobRef`)
3. **Write preparation** — `prepareCreate`, `prepareUpdate`, `prepareDelete` produce `PreparedWrite` objects
4. **Commit creation** — assembles prepared writes into a signed commit with new repo CID

The commit process:
```
createRecord/applyWrites API handler
  → repoPrepare.prepareCreate/prepareUpdate
  → actorStore.transact(did, fn)
    → inside transaction: apply writes to MST
    → compute new commit CID
    → sign commit with account keypair
    → update repo_root table
    → index records into record table
    → record blob references in record_blob table
    → compute backlinks
  → sequencer.sequenceCommit(did, commitData)
  → return commit CID and rev
```

### Phase 3: Account Management

#### 4.6 AccountManager

`account-manager/account-manager.ts` is the central account logic.

Key operations:
- **createAccount** — creates actor row, account row (email+password), initializes repo root, records invite use
- **createAccountAndSession** — creates account + issues access/refresh JWT pair
- **login** — verifies password (scrypt), issues tokens
- **updateHandle** — validates handle, updates PLC document, stores locally, emits identity event
- **deleteAccount** — soft-deletes (sets `deactivatedAt`, `deleteAfter`)
- **activateAccount** — clears deactivation
- **takedownAccount** — sets `takedownRef` for moderation

Handle validation:
- Normalize: lowercase, trim
- Check explicit slur list
- For service domains: enforce constraints (no underscores, valid TLD)
- For external domains: resolve DID via handle, verify it points back to this account
- Check uniqueness (no other account has this handle)

Email verification flow:
- `requestEmailConfirmation` → generates token, sends email
- `confirmEmail` → verifies token, sets `emailConfirmedAt`

Password reset flow:
- `requestPasswordReset` → generates token, sends email
- `resetPassword` → verifies token, updates `passwordScrypt`

App passwords:
- `createAppPassword` → generates scrypt hash, stores with name
- `listAppPasswords` → returns names and timestamps (not hashes)
- `revokeAppPassword` → deletes hash and associated refresh tokens

#### 4.7 Auth Tokens

JWT-based, using `jose` library:
- **Access token**: short-lived (~15min), scope claims (`com.atproto.access`, `com.atproto.appPass`, etc.)
- **Refresh token**: long-lived (~90 days), includes `jti` for revocation
- Tokens signed with HS256 using server's `jwtKey`
- `sub` claim = DID
- Refresh token rotation: old token gets grace period with `nextId` pointer to new token
- DPoP (Demonstration of Proof-of-Possession) binding supported via OAuth provider

Auth scopes (`auth-scope.ts`):
- `Access` — full account access
- `AppPass` — limited app password access
- `AppPassPrivileged` — privileged app password (can manage other app passwords)
- `Refresh` — refresh token scope
- `Takendown` — restricted access for taken-down accounts

### Phase 4: XRPC API

#### 4.8 API Structure

Routes are registered via `@atproto/xrpc-server`:
```
createServer([], { jsonLimit: 150kb, textLimit: 100kb })
  → apiRoutes (com.atproto + app.bsky handlers)
```

Hono middleware order:
1. Logger middleware
2. Compression (gzip)
3. Auth routes (OAuth middleware, `/.well-known/oauth-protected-resource`)
4. CORS
5. Basic routes (/, /robots.txt, /xrpc/_health)
6. Well-known routes (`/.well-known/atproto-did`)
7. XRPC server router (all `/xrpc/*` methods)
8. Error handler

#### 4.9 Lexicon Contract

Lexicons live in `lexicons/com/atproto/` and define the protocol contract. The PDS implements:

**com.atproto.server** (account/session management):
| Method | Type | Auth | Description |
|--------|------|------|-------------|
| `createAccount` | procedure | none | Create new account with invite code |
| `createSession` | procedure | none | Login, get access+refresh tokens |
| `refreshSession` | procedure | refresh | Rotate refresh token |
| `deleteSession` | procedure | refresh | Revoke refresh token |
| `getSession` | query | access | Get current session info |
| `describeServer` | query | none | Server metadata (did, version, available user domains, invite code required, links) |
| `createInviteCode` | procedure | access | Create invite code |
| `createInviteCodes` | procedure | access | Create multiple invite codes |
| `getAccountInviteCodes` | query | access | List account's invite codes |
| `createAppPassword` | procedure | access | Create app-specific password |
| `listAppPasswords` | query | access | List app passwords |
| `revokeAppPassword` | procedure | access | Delete app password |
| `getServiceAuth` | query | access | Get service auth token for proxied access |
| `checkAccountStatus` | query | none | Check if account exists/is active |
| `activateAccount` | procedure | none* | Re-activate deactivated account |
| `deactivateAccount` | procedure | access | Deactivate account |
| `deleteAccount` | procedure | access | Permanently delete account |
| `requestAccountDelete` | procedure | access | Request account deletion |
| `requestEmailConfirmation` | procedure | access | Send confirmation email |
| `confirmEmail` | procedure | none* | Confirm email with token |
| `requestEmailUpdate` | procedure | access | Request email change |
| `updateEmail` | procedure | none* | Update email with token |
| `requestPasswordReset` | procedure | none | Request password reset email |
| `resetPassword` | procedure | none* | Reset password with token |
| `reserveSigningKey` | procedure | none* | Reserve a signing key for account creation |

**com.atproto.repo** (repository CRUD):
| Method | Type | Auth | Description |
|--------|------|------|-------------|
| `createRecord` | procedure | access | Create single record |
| `putRecord` | procedure | access | Create or update record |
| `deleteRecord` | procedure | access | Delete record |
| `getRecord` | query | none* | Get a record by AT-URI |
| `listRecords` | query | none* | List records in a collection |
| `describeRepo` | query | none | Get repo metadata (handle, did, didDoc, collections, etc.) |
| `applyWrites` | procedure | access | Batch create/update/delete |
| `uploadBlob` | procedure | access | Upload a blob |
| `listMissingBlobs` | query | access | List blob CIDs not stored on this server |
| `importRepo` | procedure | access | Import repo from CAR file (account migration) |

**com.atproto.sync** (repo synchronization):
| Method | Type | Auth | Description |
|--------|------|------|-------------|
| `getRepo` | query | none* | Download full repo as CAR file |
| `getLatestCommit` | query | none | Get latest commit CID for a repo |
| `getRecord` | query | none | Get a record (for sync) |
| `getBlocks` | query | none | Get blocks by CID |
| `getBlob` | query | none | Get blob by CID |
| `listBlobs` | query | none | List all blob CIDs for a repo |
| `getRepoStatus` | query | none | Get repo status |
| `listRepos` | query | none | List all repos on this PDS |
| `subscribeRepos` | subscription | none | WebSocket event stream of all repo events |

**com.atproto.identity** (identity management):
| Method | Type | Auth | Description |
|--------|------|------|-------------|
| `resolveHandle` | query | none | Resolve handle to DID |
| `updateHandle` | procedure | access | Change account handle |
| `getRecommendedDidCredentials` | query | none | Get recommended DID signing key |
| `requestPlcOperationSignature` | procedure | none | Request PDS to sign a PLC operation |
| `signPlcOperation` | procedure | none | Sign a PLC operation |
| `submitPlcOperation` | procedure | none | Submit signed PLC operation to PLC directory |

**com.atproto.admin** (PDS admin):
| Method | Type | Auth | Description |
|--------|------|------|-------------|
| `getAccountInfo` | query | admin | Get full account details |
| `getAccountInfos` | query | admin | Get multiple account details |
| `getInviteCodes` | query | admin | List all invite codes |
| `disableInviteCodes` | procedure | admin | Disable invite codes |
| `deleteAccount` | procedure | admin | Admin-delete an account |
| `updateAccountHandle` | procedure | admin | Admin-update handle |
| `updateAccountEmail` | procedure | admin | Admin-update email |
| `updateAccountPassword` | procedure | admin | Admin-update password |
| `sendEmail` | procedure | admin | Send custom email to account |
| `enableAccountInvites` | procedure | admin | Enable invites for account |
| `disableAccountInvites` | procedure | admin | Disable invites for account |
| `getSubjectStatus` | query | admin | Get moderation status of subject |
| `updateSubjectStatus` | procedure | admin | Update moderation status |

**com.atproto.moderation**:
| Method | Type | Auth | Description |
|--------|------|------|-------------|
| `createReport` | procedure | access | Submit a moderation report |

**com.atproto.temp**:
| Method | Type | Auth | Description |
|--------|------|------|-------------|
| `checkSignupQueue` | query | none | Check signup queue status |
| `requestPhoneVerification` | procedure | none | Request SMS verification |

#### 4.10 Auth Per-Method

Authentication is per-method, configured in the XRPC server definition. Auth verifier (`auth-verifier.ts`) supports:
- **unauthenticated** — no credentials required (public endpoints)
- **access** — valid access token (Bearer JWT, or OAuth token)
- **refresh** — valid refresh token
- **admin** — HTTP Basic auth with admin password
- **mod_service** — service auth token from moderation service
- **user_service** — service auth token from a user (for proxied access)

### Phase 5: AppView Pipethrough

#### 4.11 Pipethrough Proxy

The PDS does NOT implement `app.bsky.*` methods itself (with a few exceptions for local state like `app.bsky.actor.getPreferences`). Instead, it:
1. Receives `app.bsky.*` requests
2. Forwards them to a configured AppView (Bluesky AppView or self-hosted)
3. Adds service auth headers so the AppView can verify the request comes from this PDS on behalf of this user
4. Streams the response back to the client (for both streaming and buffered responses)

`pipethrough.ts` handles:
- Resolving the target AppView from config (`bskyAppView.url`)
- Adding `authorization` header with service JWT
- Adding `atproto-proxy` header for proxied user identity
- Forwarding query parameters and headers
- Streaming binary responses (CAR files, blobs)

Some `app.bsky.*` methods ARE handled locally by the PDS:
- `app.bsky.actor.getPreferences` — reads from local `account_pref` table
- `app.bsky.actor.putPreferences` — writes to local `account_pref` table
- `app.bsky.actor.getProfile` — can serve locally or proxy to AppView
- `app.bsky.actor.getProfiles` — can serve locally or proxy
- `app.bsky.feed.getTimeline`, `getFeed`, `getAuthorFeed`, `getPostThread`, `getActorLikes` — proxy
- `app.bsky.notification.registerPush` — proxy

### Phase 6: Sequencer & Event Stream

#### 4.12 Sequencer

The sequencer (`sequencer/sequencer.ts`) provides a globally-ordered event log for all mutations on this PDS.

Event types:
- **commit** — a repo mutation (create/update/delete records). Contains: repo DID, commit CID, revision, since (previous CID), blocks (CAR file), ops array, blob CIDs, prevData CID
- **sync** — thin sync event with commit info (rev, cid, blocks)
- **identity** — handle change. Contains: DID, optional handle
- **account** — account status change. Contains: DID, active boolean, optional status enum (takendown/suspended/deleted/deactivated)

All events are CBOR-encoded and stored in `repo_seq` table with auto-incrementing `seq` number.

The sequencer:
- Polls the database for new events (exponential backoff when idle, max 1s)
- Emits events via EventEmitter to listeners
- Supports WebSocket subscription via `com.atproto.sync.subscribeRepos` (streams events to consumers like AppViews)
- Atomically sequences all events for account creation: identity + account + commit + sync events in one transaction

### Phase 7: Read-After-Write

#### 4.13 Read-After-Write Consistency

`read-after-write/viewer.ts` provides the `LocalViewer` class. After a write, results may not yet be visible in the AppView (the AppView consumes from the sequencer and has eventual consistency). The `LocalViewer` can serve results directly from the local actor store to give the writer immediate read-after-write consistency.

### Phase 8: Entryway Mode

#### 4.14 Entryway vs Standalone

The PDS can run in two modes:

**Standalone** (default):
- PDS handles everything: account creation, auth, OAuth provider
- PLC operations signed by PDS's own key
- `entryway` config is null

**Entryway** (production Bluesky):
- An external Entryway service handles account creation, invite codes, and PLC operations
- PDS delegates PLC operations to the Entryway
- OAuth authorization server is the Entryway (PDS is just the resource server)
- Service auth between PDS and Entryway via `entrywayClient`

### Phase 9: Background Queue

Simple in-process queue (with concurrency 5) for out-of-band work:
- Used for: indexing after writes, sending emails, cleanup tasks
- On shutdown: stops accepting new tasks, drains existing queue

## 5. Configuration

The PDS server requires:

```
ServerConfig:
  service:
    port: number (default 2583)
    hostname: string
    publicUrl: string
    version: string
    devMode: boolean
  identity:
    serviceHandleDomains: string[]
    plcUrl: string
    didPlcRotationKey?: Keypair
    recoverHandleOnStartup: boolean
  database:
    accountDbLoc: string          // path to account DB
    repoDbLoc: string             // path to sequencer DB
    disableWalAutoCheckpoint: boolean
  actorStore:
    directory: string             // data directory for actor stores
    disableWalAutoCheckpoint: boolean
  blobstore:
    provider: 'disk' | 's3'
    // for disk:
    directory?: string
    tempDirectory?: string
    // for s3:
    bucket?: string
    region?: string
    endpoint?: string
    forcePathStyle?: boolean
  auth:
    jwtKey: KeyObject             // HS256 key for JWT signing
    adminPass: string             // admin basic auth password
    didPlcRotationKey?: Keypair
  entryway: null | {
    url: string
    did: string
    adminUrl?: string
    adminDid?: string
  }
  bskyAppView:
    url: string
    did: string
    cdnUrlPattern?: string
  appViews: AppViewOptions[]      // additional AppViews for proxying
  crawlers:
    hardCrawlers: string[]
    notificationChannels: string[]
  labelerDid?: string
```

## 6. Dependencies

Core libraries used by the reference PDS:
- `@atproto/xrpc-server` — XRPC server framework (Express-based)
- `@atproto/repo` — Repo data structures (MST, blocks, CAR)
- `@atproto/crypto` — Keypair generation, signing, hashing
- `@atproto/identity` — DID/handle resolution
- `@atproto/lex` — Lexicon SDK for type-safe records and XRPC
- `@atproto/oauth-provider` — OAuth 2.0 provider (DPoP, PAR)
- `@atproto/syntax` — AT-URI, DID, handle, TID parsing/validation
- `@atproto/common` — Shared utilities (retry, streams, timing)
- `@atproto/lex-cbor` — CBOR encoding/decoding
- `@did-plc/lib` — PLC directory client
- `hono` — HTTP server
- `jose` — JWT/JWS/JWE operations

## 7. Build & Codegen

1. **Lexicons are the contract** — All XRPC methods and record types are defined as JSON lexicon files in `lexicons/`
2. Codegen runs `lex build` from each package's `prebuild` script
3. Generated types/validators live in `src/lexicons/` (gitignored)
4. After editing any lexicon, run `pnpm codegen` from the package directory

## 8. Key Design Decisions

1. **One database per account** — actor store databases are per-user, making them independently migratable, shardable, and deletable.
2. **MST for data integrity** — repo data integrity is guaranteed by the Merkle tree structure. Each write produces a verifiable commit CID.
3. **Event sourcing via sequencer** — all mutations are sequenced, enabling reliable fan-out to downstream services.
4. **Pipethrough for AppView** — the PDS doesn't compute feeds/timelines; it proxies to an AppView which does the expensive read-side work.
5. **OAuth 2.0 with DPoP** — modern auth using DPoP tokens for proof-of-possession
6. **did:plc with rotation keys** — PDS holds a rotation key that can update the PLC document when handles change.
7. **Entryway separation** — in production, the Entryway handles global account namespace and invite codes; the PDS just stores data.

## 9. What a PDS Does NOT Do

- Compute feeds, timelines, or search indexes (that's the AppView)
- Moderate content (that's Ozone/moderation services)
- Store global social graph (AppView responsibility)
- Handle federation negotiation (protocol-level, not server-level)
- Provide real-time notifications directly (AppView/bsync)

## 10. Testing Strategy

The reference implementation tests:
1. **Unit tests** — each helper/db module in isolation
2. **Integration tests** — using `dev-env` which boots a full PDS + AppView + PLC + bsync + ozone constellation
3. **OAuth flow tests** — browser-driven via Puppeteer/Playwright
4. **Auth tests** — enumeration resistance, token lifecycle, scope enforcement
5. **Sync tests** — repo transfer between PDSes, event stream correctness
6. **Lexicon conformance** — interop test files in
   `https://github.com/bluesky-social/atproto interop-test-files/`
