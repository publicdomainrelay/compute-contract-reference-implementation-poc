// @publicdomainrelay/hono-factory-atproto-repo — Merkle Search Tree
//
// Byte-exact port of the atproto MST specification:
// - Depth = leading 2-bit zero groups of sha256(key) → ~4 fanout
// - Node CBOR: { l: CID|null, e: [{ p: int, k: bytes, v: CID, t: CID|null }] }
// - Key prefix compression within nodes (elide shared prefix bytes)
// - Root at the HIGHEST numeric layer (most leading-zero pairs)
// - Deterministic: same entries → identical root CID, regardless of insertion order
//
// Reference: https://atproto.com/specs/repository#mst-structure

import type { Bytes, Cid } from "../contracts.ts";
import { encode as cborEncode, decode as cborDecode } from "../cbor/dag-cbor.ts";
import { cidFromDigest, SHA256_DIGEST_LEN } from "../util/cid.ts";
import { bytesEqual } from "../util/bytes.ts";

// ── CBOR node schemas ────────────────────────────────────────────────
//
// Atproto MST node (CBOR map):
//   {
//     l: CID | null     — left subtree (keys sorting before this node's entries)
//     e: [              — array of entries, sorted by key
//       {
//         p: int        — prefix bytes shared with previous key
//         k: bytes      — key suffix (remainder after p bytes of previous key)
//         v: CID        — record value (CID link)
//         t: CID | null — right subtree (keys between this entry and next)
//       }
//     ]
//   }
//

interface TreeNodeEntry {
  p: number;       // prefix length
  k: Uint8Array;   // key suffix bytes
  v: Cid;          // value CID
  t: Cid | null;   // right subtree
}

interface TreeNodeData {
  l: Cid | null;   // left subtree
  e: TreeNodeEntry[];
}

// ── BlockStore interface ──────────────────────────────────────────────

export interface BlockStore {
  get(cid: Cid): Promise<Bytes | null>;
  put(cid: Cid, bytes: Bytes): Promise<void>;
  has(cid: Cid): Promise<boolean>;
}

// ── crypto & layer helpers ────────────────────────────────────────────

async function sha256(data: Bytes): Promise<Bytes> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength),
  );
  return new Uint8Array(digest);
}

/**
 * Count leading 2-bit zero groups in the SHA-256 hash of a key.
 * This is the atproto depth/layer function (~4 fanout per layer).
 *
 * Algorithm: for each byte of the hash, count how many 2-bit groups
 * from the top are zero. Stop at the first non-zero group.
 *
 *   byte < 64  → top 2 bits are 0 (0b00xxxxxx) → +1
 *   byte < 16  → top 4 bits are 0 (0b0000xxxx) → +2
 *   byte < 4   → top 6 bits are 0 (0b000000xx) → +3
 *   byte == 0  → all 8 bits are 0              → +4, continue to next byte
 */
async function leadingZerosOnHash(key: string | Uint8Array): Promise<number> {
  const keyBytes = typeof key === "string"
    ? new TextEncoder().encode(key)
    : key;
  const hash = await sha256(keyBytes);
  let leadingZeros = 0;
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i];
    if (byte < 64) leadingZeros++;
    if (byte < 16) leadingZeros++;
    if (byte < 4) leadingZeros++;
    if (byte === 0) {
      leadingZeros++;
    } else {
      break;
    }
  }
  return leadingZeros;
}

// ── string ↔ bytes (ASCII, used for key encoding in CBOR) ────────────

function toAscii(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function fromAscii(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i);
  }
  return bytes;
}

function countPrefixLen(a: string, b: string): number {
  let i = 0;
  for (i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) break;
  }
  return i;
}

// ── key validation ────────────────────────────────────────────────────

const VALID_MST_KEY_RE = /^[a-zA-Z0-9_~\-:./]*$/;

function isValidMstKey(key: string): boolean {
  const parts = key.split("/");
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    parts.length === 2 &&
    parts[0].length > 0 &&
    parts[1].length > 0 &&
    VALID_MST_KEY_RE.test(key)
  );
}

function ensureValidMstKey(key: string): void {
  if (!isValidMstKey(key)) {
    throw new Error(`Not a valid MST key: ${key}`);
  }
}

// ── node serialization ────────────────────────────────────────────────

/**
 * Serialize entries to a TreeNodeData ready for CBOR encoding.
 * Implements key prefix compression and l/t pointer placement.
 */
function serializeNodeData(entries: NodeEntry[]): TreeNodeData {
  const data: TreeNodeData = { l: null, e: [] };
  let i = 0;

  // If first entry is a subtree, it becomes the `l` pointer
  if (entries[0] && entries[0] instanceof MstNode) {
    data.l = entries[0].pointer;
    i++;
  }

  let lastKey = "";
  while (i < entries.length) {
    const leaf = entries[i];
    const next = entries[i + 1];

    if (!(leaf instanceof LeafNode)) {
      throw new Error("Not a valid node: two subtrees next to each other");
    }
    i++;

    let subtree: Cid | null = null;
    if (next instanceof MstNode) {
      subtree = next.pointer;
      i++;
    }

    ensureValidMstKey(leaf.key);
    const prefixLen = countPrefixLen(lastKey, leaf.key);
    data.e.push({
      p: prefixLen,
      k: fromAscii(leaf.key.slice(prefixLen)),
      v: leaf.value,
      t: subtree,
    });

    lastKey = leaf.key;
  }

  return data;
}

function encodeNodeData(data: TreeNodeData): Bytes {
  const obj: Record<string, unknown> = {};

  // l: CID link or null
  if (data.l !== null) {
    obj.l = { $link: data.l };
  } else {
    obj.l = null;
  }

  // e: array of entry objects
  const eArr: Record<string, unknown>[] = [];
  for (const entry of data.e) {
    const eObj: Record<string, unknown> = {
      p: entry.p,
      k: entry.k,
      v: { $link: entry.v },
    };
    if (entry.t !== null) {
      eObj.t = { $link: entry.t };
    } else {
      eObj.t = null;
    }
    eArr.push(eObj);
  }
  obj.e = eArr;

  return cborEncode(obj);
}

function decodeNodeData(bytes: Bytes): TreeNodeData {
  const obj = cborDecode(bytes) as Record<string, unknown>;

  // Parse l
  let l: Cid | null = null;
  if (obj.l !== null && obj.l !== undefined) {
    const link = obj.l as { $link: Cid };
    l = link.$link;
  }

  // Parse e
  const eArr = (obj.e as Array<Record<string, unknown>>) ?? [];
  const entries: TreeNodeEntry[] = [];
  for (const raw of eArr) {
    const p = raw.p as number;
    const k = raw.k as Uint8Array;
    const vLink = raw.v as { $link: Cid };
    let t: Cid | null = null;
    if (raw.t !== null && raw.t !== undefined) {
      t = (raw.t as { $link: Cid }).$link;
    }
    entries.push({ p, k, v: vLink.$link, t });
  }

  return { l, e: entries };
}

async function cidForNodeData(data: TreeNodeData): Promise<Cid> {
  const bytes = encodeNodeData(data);
  const digest = await sha256(bytes);
  return cidFromDigest(digest);
}

// ── leaf / tree node types ────────────────────────────────────────────

type NodeEntry = LeafNode | MstNode;

class LeafNode {
  constructor(public key: string, public value: Cid) {}

  isLeaf(): boolean { return true; }
  isTree(): boolean { return false; }
}

const EMPTY_NODE_CID_PLACEHOLDER = "" as Cid;

class MstNode {
  layer: number;
  pointer: Cid;
  /** In-memory children. Null until lazy-loaded. */
  private _entries: NodeEntry[] | null;

  constructor(layer: number, pointer: Cid, entries: NodeEntry[] | null) {
    this.layer = layer;
    this.pointer = pointer;
    this._entries = entries;
  }

  // ── factory ──────────────────────────────────────────────────────

  static async create(
    entries: NodeEntry[] = [],
    layer = 0,
  ): Promise<MstNode> {
    // Resolve any child nodes with stale pointers before serializing.
    // newTree() creates nodes with EMPTY_NODE_CID_PLACEHOLDER; we must
    // compute real CIDs before serializeNodeData reads child pointers.
    for (const e of entries) {
      if (e instanceof MstNode && e.pointer === EMPTY_NODE_CID_PLACEHOLDER) {
        await e.serialize(); // recursively resolves descendants
      }
    }
    const data = serializeNodeData(entries);
    const cid = await cidForNodeData(data);
    return new MstNode(layer, cid, entries);
  }

  // ── entries (lazy load from pointer) ─────────────────────────────

  async getEntries(): Promise<NodeEntry[]> {
    if (this._entries) return [...this._entries];
    throw new Error("MstNode: entries not loaded — use fromData to deserialize");
  }

  // ── simple ops ───────────────────────────────────────────────────

  private newTree(entries: NodeEntry[]): MstNode {
    // Create a new MstNode with the same layer but stale pointer.
    // The pointer gets recomputed on serialize/pointer access.
    const node = new MstNode(this.layer, EMPTY_NODE_CID_PLACEHOLDER, entries);
    return node;
  }

  async atIndex(index: number): Promise<NodeEntry | null> {
    const e = await this.getEntries();
    return e[index] ?? null;
  }

  async slice(start?: number, end?: number): Promise<NodeEntry[]> {
    const e = await this.getEntries();
    return e.slice(start, end);
  }

  async spliceIn(entry: NodeEntry, index: number): Promise<MstNode> {
    const e = await this.getEntries();
    const update = [...e.slice(0, index), entry, ...e.slice(index)];
    return this.newTree(update);
  }

  async removeEntry(index: number): Promise<MstNode> {
    const e = await this.getEntries();
    return this.newTree([...e.slice(0, index), ...e.slice(index + 1)]);
  }

  async updateEntry(index: number, entry: NodeEntry): Promise<MstNode> {
    const e = await this.getEntries();
    return this.newTree([...e.slice(0, index), entry, ...e.slice(index + 1)]);
  }

  async append(entry: NodeEntry): Promise<MstNode> {
    const e = await this.getEntries();
    return this.newTree([...e, entry]);
  }

  async prepend(entry: NodeEntry): Promise<MstNode> {
    const e = await this.getEntries();
    return this.newTree([entry, ...e]);
  }

  // ── find insertion point ─────────────────────────────────────────

  async findGtOrEqualLeafIndex(key: string): Promise<number> {
    const e = await this.getEntries();
    const idx = e.findIndex(
      (entry) => entry instanceof LeafNode && entry.key >= key,
    );
    return idx >= 0 ? idx : e.length;
  }

  // ── children ─────────────────────────────────────────────────────

  async createChild(): Promise<MstNode> {
    return MstNode.create([], this.layer - 1);
  }

  async createParent(): Promise<MstNode> {
    const parent = await MstNode.create([this], this.layer + 1);
    return parent;
  }

  // ── splitAround ──────────────────────────────────────────────────

  /** Recursively split tree around a key. Returns [left, right]. */
  async splitAround(key: string): Promise<[MstNode | null, MstNode | null]> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const leftData = await this.slice(0, index);
    const rightData = await this.slice(index);
    let left: MstNode | null = this.newTree(leftData);
    let right: MstNode | null = this.newTree(rightData);

    // If far right of left side is a subtree, split it too
    const lastInLeft = leftData[leftData.length - 1];
    if (lastInLeft instanceof MstNode) {
      left = await left.removeEntry(leftData.length - 1);
      const split = await lastInLeft.splitAround(key);
      if (split[0]) left = await left.append(split[0]);
      if (split[1]) right = await right.prepend(split[1]);
    }

    return [
      (await left.getEntries()).length > 0 ? left : null,
      (await right.getEntries()).length > 0 ? right : null,
    ];
  }

  // ── appendMerge ──────────────────────────────────────────────────

  async appendMerge(toMerge: MstNode): Promise<MstNode> {
    if (this.layer !== toMerge.layer) {
      throw new Error("Trying to merge two nodes from different layers");
    }
    const thisE = await this.getEntries();
    const mergeE = await toMerge.getEntries();
    const lastInLeft = thisE[thisE.length - 1];
    const firstInRight = mergeE[0];

    if (lastInLeft instanceof MstNode && firstInRight instanceof MstNode) {
      const merged = await lastInLeft.appendMerge(firstInRight);
      return this.newTree([
        ...thisE.slice(0, thisE.length - 1),
        merged,
        ...mergeE.slice(1),
      ]);
    }
    return this.newTree([...thisE, ...mergeE]);
  }

  // ── trimTop ──────────────────────────────────────────────────────

  /** If root only points to a single subtree, promote that subtree. */
  async trimTop(): Promise<MstNode> {
    const entries = await this.getEntries();
    if (entries.length === 1 && entries[0] instanceof MstNode) {
      return entries[0].trimTop();
    }
    return this;
  }

  // ── add / get / update / delete ──────────────────────────────────

  async add(key: string, value: Cid, knownZeros?: number): Promise<MstNode> {
    ensureValidMstKey(key);
    const keyZeros = knownZeros ?? (await leadingZerosOnHash(key));
    const layer = await this.getLayer();
    const newLeaf = new LeafNode(key, value);

    if (keyZeros === layer) {
      // Belongs in this layer
      const index = await this.findGtOrEqualLeafIndex(key);
      const found = await this.atIndex(index);
      if (found instanceof LeafNode && found.key === key) {
        throw new Error(`There is already a value at key: ${key}`);
      }
      const prevNode = await this.atIndex(index - 1);
      if (!prevNode || prevNode instanceof LeafNode) {
        return this.spliceIn(newLeaf, index);
      } else {
        const splitSubTree = await prevNode.splitAround(key);
        return this.replaceWithSplit(
          index - 1, splitSubTree[0], newLeaf, splitSubTree[1],
        );
      }
    } else if (keyZeros < layer) {
      // Belongs on a lower layer
      const index = await this.findGtOrEqualLeafIndex(key);
      const prevNode = await this.atIndex(index - 1);
      if (prevNode instanceof MstNode) {
        const newSub = await prevNode.add(key, value, keyZeros);
        return this.updateEntry(index - 1, newSub);
      } else {
        const child = await this.createChild();
        const newSub = await child.add(key, value, keyZeros);
        return this.spliceIn(newSub, index);
      }
    } else {
      // Belongs on a higher layer → new root
      const split = await this.splitAround(key);
      let left: MstNode | null = split[0];
      let right: MstNode | null = split[1];
      const currentLayer = await this.getLayer();
      const extraLayers = keyZeros - currentLayer;
      for (let i = 1; i < extraLayers; i++) {
        if (left) left = await left.createParent();
        if (right) right = await right.createParent();
      }
      const updated: NodeEntry[] = [];
      if (left) updated.push(left);
      updated.push(new LeafNode(key, value));
      if (right) updated.push(right);
      return MstNode.create(updated, keyZeros);
    }
  }

  async get(key: string): Promise<Cid | null> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found instanceof LeafNode && found.key === key) return found.value;
    const prev = await this.atIndex(index - 1);
    if (prev instanceof MstNode) return prev.get(key);
    return null;
  }

  async update(key: string, value: Cid): Promise<MstNode> {
    ensureValidMstKey(key);
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found instanceof LeafNode && found.key === key) {
      return this.updateEntry(index, new LeafNode(key, value));
    }
    const prev = await this.atIndex(index - 1);
    if (prev instanceof MstNode) {
      const updated = await prev.update(key, value);
      return this.updateEntry(index - 1, updated);
    }
    throw new Error(`Could not find a record with key: ${key}`);
  }

  async delete(key: string): Promise<MstNode> {
    const altered = await this.deleteRecurse(key);
    return altered.trimTop();
  }

  private async deleteRecurse(key: string): Promise<MstNode> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found instanceof LeafNode && found.key === key) {
      const prev = await this.atIndex(index - 1);
      const next = await this.atIndex(index + 1);
      if (prev instanceof MstNode && next instanceof MstNode) {
        const merged = await prev.appendMerge(next);
        return this.newTree([
          ...await this.slice(0, index - 1),
          merged,
          ...await this.slice(index + 2),
        ]);
      } else {
        return this.removeEntry(index);
      }
    }
    const prev = await this.atIndex(index - 1);
    if (prev instanceof MstNode) {
      const sub = await prev.deleteRecurse(key);
      const subEntries = await sub.getEntries();
      if (subEntries.length === 0) {
        return this.removeEntry(index - 1);
      } else {
        return this.updateEntry(index - 1, sub);
      }
    }
    throw new Error(`Could not find a record with key: ${key}`);
  }

  // ── replaceWithSplit ─────────────────────────────────────────────

  async replaceWithSplit(
    index: number,
    left: MstNode | null,
    leaf: LeafNode,
    right: MstNode | null,
  ): Promise<MstNode> {
    const update = await this.slice(0, index);
    if (left) update.push(left);
    update.push(leaf);
    if (right) update.push(right);
    update.push(...await this.slice(index + 1));
    return this.newTree(update);
  }

  // ── layer resolution ─────────────────────────────────────────────

  async getLayer(): Promise<number> {
    return this.layer;
  }

  // ── serialize & persist ──────────────────────────────────────────

  async serialize(): Promise<{ cid: Cid; bytes: Uint8Array }> {
    const entries = await this.getEntries();
    // Recursively resolve child pointers
    for (const e of entries) {
      if (e instanceof MstNode && e.pointer === EMPTY_NODE_CID_PLACEHOLDER) {
        await e.serialize();
      }
    }
    const data = serializeNodeData(entries);
    const bytes = encodeNodeData(data);
    const cid = await cidForNodeData(data);
    this.pointer = cid;
    return { cid, bytes };
  }

  /** Collect all blocks (this node + descendants) that need to be stored. */
  async collectBlocks(
    existing: Set<Cid>,
    blocks: Map<Cid, Bytes>,
  ): Promise<void> {
    const { cid, bytes } = await this.serialize();
    if (!existing.has(cid)) {
      blocks.set(cid, bytes);
    }
    const entries = await this.getEntries();
    for (const e of entries) {
      if (e instanceof MstNode) {
        await e.collectBlocks(existing, blocks);
      }
    }
  }

  // ── traversal ────────────────────────────────────────────────────

  async *walkLeaves(): AsyncIterable<LeafNode> {
    const entries = await this.getEntries();
    for (const e of entries) {
      if (e instanceof LeafNode) {
        yield e;
      } else {
        yield* e.walkLeaves();
      }
    }
  }

  async leafCount(): Promise<number> {
    let count = 0;
    for await (const _ of this.walkLeaves()) count++;
    return count;
  }

  // ── collect all CIDs reachable from this node ────────────────────

  async collectCids(cids: Set<Cid>): Promise<void> {
    cids.add(this.pointer);
    const entries = await this.getEntries();
    for (const e of entries) {
      if (e instanceof LeafNode) {
        cids.add(e.value);
      } else {
        await e.collectCids(cids);
      }
    }
  }
}

// ── public API ────────────────────────────────────────────────────────

export class Mst {
  #store: BlockStore;
  #root: Cid | null;
  #tree: MstNode | null; // in-memory tree (null until init)
  /** Flat cache for fast lookups. */
  #all: Map<string, Cid>;

  constructor(store: BlockStore, root: Cid | null) {
    this.#store = store;
    this.#root = root;
    this.#tree = null;
    this.#all = new Map();
  }

  get root(): Cid | null {
    return this.#root;
  }

  get size(): number {
    return this.#all.size;
  }

  /** Load the tree from the block store. Must be called before get/set/delete. */
  async init(): Promise<void> {
    if (this.#root === null) {
      // Empty tree: single empty node
      this.#tree = await MstNode.create([], 0);
      return;
    }
    this.#tree = await loadTree(this.#store, this.#root);
    // Populate flat cache
    for await (const leaf of this.#tree.walkLeaves()) {
      this.#all.set(leaf.key, leaf.value);
    }
  }

  async get(key: string): Promise<Cid | null> {
    // Use flat cache for O(1) lookup
    const cached = this.#all.get(key);
    if (cached !== undefined) return cached;
    // Fallback: search tree (though init() populates cache)
    if (!this.#tree) return null;
    return this.#tree.get(key);
  }

  async set(key: string, value: Cid): Promise<Cid> {
    if (!this.#tree) {
      this.#tree = await MstNode.create([], 0);
    }
    // Use flat cache to determine if key exists (avoids masking errors)
    const exists = this.#all.has(key);
    if (exists) {
      this.#tree = await this.#tree.update(key, value);
    } else {
      this.#tree = await this.#tree.add(key, value);
    }
    this.#all.set(key, value);

    // Persist new blocks
    const existing = new Set<Cid>();
    if (this.#root) existing.add(this.#root);
    const blocks = new Map<Cid, Bytes>();
    await this.#tree.collectBlocks(existing, blocks);
    for (const [cid, bytes] of blocks) {
      await this.#store.put(cid, bytes);
    }
    // Root is the tree's pointer after serialization
    const { cid } = await this.#tree.serialize();
    this.#root = cid;
    return cid;
  }

  async delete(key: string): Promise<Cid | null> {
    if (!this.#tree) return null;
    if (!this.#all.has(key)) return this.#root; // key not found, no-op
    try {
      this.#tree = await this.#tree.delete(key);
    } catch {
      // If tree delete fails (e.g., key in tree but not in cache),
      // just remove from cache and continue
      this.#all.delete(key);
      return this.#root;
    }
    this.#all.delete(key);

    // Persist new blocks
    const existing = new Set<Cid>();
    if (this.#root) existing.add(this.#root);
    const blocks = new Map<Cid, Bytes>();
    await this.#tree.collectBlocks(existing, blocks);
    for (const [cid, bytes] of blocks) {
      await this.#store.put(cid, bytes);
    }

    const entries = await this.#tree.getEntries();
    if (entries.length === 0) {
      this.#root = null;
      return null;
    }
    const { cid } = await this.#tree.serialize();
    this.#root = cid;
    return cid;
  }

  async *entries(): AsyncIterable<{ key: string; value: Cid }> {
    const sorted = [...this.#all.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, value] of sorted) {
      yield { key, value };
    }
  }
}

// ── tree loading from storage ─────────────────────────────────────────

async function loadTree(store: BlockStore, cid: Cid): Promise<MstNode> {
  const bytes = await store.get(cid);
  if (!bytes) throw new Error(`MST node not found: ${cid}`);
  const data = decodeNodeData(bytes);
  return deserializeNodeData(store, data);
}

async function deserializeNodeData(
  store: BlockStore,
  data: TreeNodeData,
  layer?: number,
): Promise<MstNode> {
  const entries: NodeEntry[] = [];

  if (data.l !== null) {
    const child = await loadTree(store, data.l);
    entries.push(child);
  }

  let lastKey = "";
  for (const entry of data.e) {
    const keyStr = toAscii(entry.k);
    const key = lastKey.slice(0, entry.p) + keyStr;
    ensureValidMstKey(key);
    entries.push(new LeafNode(key, entry.v));
    lastKey = key;
    if (entry.t !== null) {
      const child = await loadTree(store, entry.t);
      entries.push(child);
    }
  }

  // Determine layer from the first leaf
  let resolvedLayer = layer ?? 0;
  for (const e of entries) {
    if (e instanceof LeafNode) {
      resolvedLayer = await leadingZerosOnHash(e.key);
      break;
    }
  }

  const cid = await cidForNodeData(data);
  return new MstNode(resolvedLayer, cid, entries);
}

// ── diff ──────────────────────────────────────────────────────────────

export async function diff(
  store: BlockStore,
  oldRoot: Cid | null,
  newRoot: Cid | null,
): Promise<Cid[]> {
  const oldCids = new Set<Cid>();
  const newCids = new Set<Cid>();

  async function collect(cid: Cid | null, set: Set<Cid>): Promise<void> {
    if (cid === null) return;
    if (set.has(cid)) return;
    set.add(cid);
    const bytes = await store.get(cid);
    if (!bytes) return; // missing block — ignore
    const data = decodeNodeData(bytes);
    if (data.l !== null) await collect(data.l, set);
    for (const e of data.e) {
      if (e.t !== null) await collect(e.t, set);
    }
  }

  await collect(oldRoot, oldCids);
  await collect(newRoot, newCids);

  return [...newCids].filter((c) => !oldCids.has(c));
}

// ── factory ───────────────────────────────────────────────────────────

export function createMst(store: BlockStore, root?: Cid | null): Mst {
  return new Mst(store, root ?? null);
}
