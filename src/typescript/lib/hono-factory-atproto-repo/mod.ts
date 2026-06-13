// @publicdomainrelay/hono-factory-atproto-repo — public API
//
// A Deno + Hono factory that implements a minimal atproto PDS repo surface:
// com.atproto.repo.* (record CRUD over a signed MST) and
// com.atproto.sync.subscribeRepos (the firehose).

// ── factory (main entry point) ────────────────────────────────────
export { createRepoFactory } from "./factory/factory.ts";
export type { RepoFactoryOptions, RepoFactory } from "./factory/factory.ts";

// ── contracts ─────────────────────────────────────────────────────
export type {
  Bytes, Cid, Did, Tid,
  Signer, Verifier,
  BlockStore, RepoStore, Storage,
  CommitEvent, CommitOp,
  SequencedFrame, Sequencer,
  WriteOp, RepoApi,
} from "./contracts.ts";
export { XrpcError, XrpcErrorNames } from "./contracts.ts";

// ── util ──────────────────────────────────────────────────────────
export { hexEncode, hexDecode, base64Encode, base64Decode, base32Encode, base32Decode, utf8Encode, utf8Decode, concat, bytesEqual } from "./util/bytes.ts";
export { cidFromDigest, cidToBytes, cidDigest, isValidCid, cidEquals } from "./util/cid.ts";
export { nextTid, tidFromTime, parseTid, isValidTid, resetClockId } from "./util/tid.ts";

// ── cbor ──────────────────────────────────────────────────────────
export { encode as cborEncode, decode as cborDecode, cidLink, isCidLink, cidFromLink } from "./cbor/dag-cbor.ts";

// ── crypto ────────────────────────────────────────────────────────
export { signerFromKeypair, signerFromPrivateKeyHex, createVerifier, verifierFromKeypair } from "./crypto/signer.ts";
export { signServiceAuth } from "./crypto/service-auth.ts";
export type { ServiceAuthOptions } from "./crypto/service-auth.ts";

// ── storage ───────────────────────────────────────────────────────
export { MemoryStorage } from "./storage/memory.ts";
export { DenoKvStorage } from "./storage/deno-kv.ts";
export { IndexedDbStorage } from "./storage/indexeddb.ts";

// ── mst ───────────────────────────────────────────────────────────
export { createMst, diff } from "./mst/mst.ts";

// ── repo ──────────────────────────────────────────────────────────
export { Repo } from "./repo/repo.ts";
export { exportCar, importCar } from "./repo/car.ts";

// ── firehose ──────────────────────────────────────────────────────
export { FirehoseSequencer } from "./firehose/sequencer.ts";
export { createSubscribeHandler } from "./firehose/subscribe.ts";

// ── lexicons ──────────────────────────────────────────────────────
export { getLexicon } from "./lexicons/index.ts";
