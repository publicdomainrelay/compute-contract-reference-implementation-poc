import { assertEquals, assert, assertNotEquals } from "@std/assert";
import { createMst, diff, BlockStore } from "../../mst/mst.ts";
import type { Bytes, Cid } from "../../contracts.ts";
import { cidFromDigest, SHA256_DIGEST_LEN } from "../../util/cid.ts";

// In-memory block store for testing
class MemBlockStore implements BlockStore {
  #blocks = new Map<Cid, Bytes>();
  async get(cid: Cid): Promise<Bytes | null> { return this.#blocks.get(cid) ?? null; }
  async put(cid: Cid, bytes: Bytes): Promise<void> { this.#blocks.set(cid, bytes); }
  async has(cid: Cid): Promise<boolean> { return this.#blocks.has(cid); }
}

function dummyCid(n: number): Cid {
  const digest = new Uint8Array(SHA256_DIGEST_LEN);
  // Use a hash-like value so CIDs look reasonable
  digest[0] = (n >>> 24) & 0xff;
  digest[1] = (n >>> 16) & 0xff;
  digest[2] = (n >>> 8) & 0xff;
  digest[3] = n & 0xff;
  return cidFromDigest(digest);
}

/** Valid MST keys are collection/rkey format. */
function mkKey(name: string): string {
  return `com.example.test/${name}`;
}

Deno.test("mst: empty tree has no root", async () => {
  const store = new MemBlockStore();
  const mst = createMst(store);
  await mst.init();
  assertEquals(mst.root, null);
  assertEquals(mst.size, 0);
});

Deno.test("mst: set and get single entry", async () => {
  const store = new MemBlockStore();
  const mst = createMst(store);
  await mst.init();

  const root = await mst.set(mkKey("hello"), dummyCid(1));
  assert(root !== null);

  const val = await mst.get(mkKey("hello"));
  assertEquals(val, dummyCid(1));

  // Missing key returns null
  assertEquals(await mst.get(mkKey("missing")), null);
});

Deno.test("mst: set multiple entries", async () => {
  const store = new MemBlockStore();
  const mst = createMst(store);
  await mst.init();

  for (let i = 0; i < 10; i++) {
    await mst.set(mkKey(`key${i}`), dummyCid(i));
  }

  assertEquals(mst.size, 10);
  for (let i = 0; i < 10; i++) {
    assertEquals(await mst.get(mkKey(`key${i}`)), dummyCid(i));
  }
});

Deno.test("mst: update existing key", async () => {
  const store = new MemBlockStore();
  const mst = createMst(store);
  await mst.init();

  const k = mkKey("key");
  await mst.set(k, dummyCid(1));
  const root1 = mst.root;
  await mst.set(k, dummyCid(2));
  const root2 = mst.root;

  assertNotEquals(root1, root2);
  assertEquals(await mst.get(k), dummyCid(2));
  assertEquals(mst.size, 1);
});

Deno.test("mst: delete entry", async () => {
  const store = new MemBlockStore();
  const mst = createMst(store);
  await mst.init();

  const k = mkKey("key");
  await mst.set(k, dummyCid(1));
  assertEquals(mst.size, 1);

  await mst.delete(k);
  assertEquals(mst.size, 0);
  assertEquals(await mst.get(k), null);
  assertEquals(mst.root, null);
});

Deno.test("mst: entries iteration sorted", async () => {
  const store = new MemBlockStore();
  const mst = createMst(store);
  await mst.init();

  const keys = ["c", "a", "b", "d"];
  for (const k of keys) {
    await mst.set(mkKey(k), dummyCid(keys.indexOf(k)));
  }

  const result: string[] = [];
  for await (const { key } of mst.entries()) {
    result.push(key);
  }
  assertEquals(result, keys.sort().map(mkKey));
});

Deno.test("mst: deterministic root CID", async () => {
  // Same entries in same order → same root CID
  const store1 = new MemBlockStore();
  const mst1 = createMst(store1);
  await mst1.init();
  for (let i = 0; i < 20; i++) {
    await mst1.set(mkKey(`key${i.toString().padStart(2, "0")}`), dummyCid(i));
  }
  const root1 = mst1.root;

  const store2 = new MemBlockStore();
  const mst2 = createMst(store2);
  await mst2.init();
  // Same entries, different insertion order
  for (let i = 19; i >= 0; i--) {
    await mst2.set(mkKey(`key${i.toString().padStart(2, "0")}`), dummyCid(i));
  }
  const root2 = mst2.root;

  assertEquals(root1, root2);
});

Deno.test("mst: diff finds new blocks", async () => {
  const store = new MemBlockStore();
  const mst = createMst(store);
  await mst.init();

  await mst.set(mkKey("a"), dummyCid(1));
  const root1 = mst.root;

  await mst.set(mkKey("b"), dummyCid(2));
  const root2 = mst.root;

  assert(root1 !== null && root2 !== null);
  const changed = await diff(store, root1, root2);
  // There should be new blocks added
  assert(changed.length > 0);
});

Deno.test("mst: larger entry set (valid keys)", async () => {
  const store = new MemBlockStore();
  const mst = createMst(store);
  await mst.init();

  const n = 200;
  for (let i = 0; i < n; i++) {
    await mst.set(mkKey(`key${i.toString().padStart(5, "0")}`), dummyCid(i));
  }

  assertEquals(mst.size, n);
  // Check that all entries are still accessible
  for (let i = 0; i < n; i++) {
    const key = mkKey(`key${i.toString().padStart(5, "0")}`);
    assertEquals(await mst.get(key), dummyCid(i));
  }

  assert(mst.root !== null);
});
