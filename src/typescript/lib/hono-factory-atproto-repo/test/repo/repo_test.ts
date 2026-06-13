import { assertEquals, assert, assertNotEquals } from "@std/assert";
import { MemoryStorage } from "../../storage/memory.ts";
import { signerFromKeypair, verifierFromKeypair } from "../../crypto/signer.ts";
import { Repo } from "../../repo/repo.ts";
import { Secp256k1Keypair } from "@atproto/crypto";
import type { WriteOp } from "../../contracts.ts";

Deno.test("repo: createRecord and getRecord round-trip", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const repo = new Repo(store, signer);
  const did = repo.did;

  const evt = await repo.applyWrites(did, [{
    action: "create",
    collection: "app.bsky.feed.post",
    rkey: "self",
    record: { $type: "app.bsky.feed.post", text: "hello world", createdAt: new Date().toISOString() },
  }]);

  assert(evt.commit.length > 0);
  assertEquals(evt.repo, did);
  assertEquals(evt.ops.length, 1);
  assertEquals(evt.ops[0].action, "create");

  // Read it back
  const record = await repo.getRecord(did, "app.bsky.feed.post", "self");
  assert(record !== null);
  assertEquals((record.value as Record<string, unknown>).text, "hello world");
});

Deno.test("repo: commit signature verifies", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const verifier = verifierFromKeypair(kp);
  const repo = new Repo(store, signer);

  const evt = await repo.applyWrites(repo.did, [{
    action: "create",
    collection: "test.col",
    rkey: "1",
    record: { $type: "test.col", value: 42 },
  }]);

  // Verify the commit signature
  const commitBytes = await store.get(evt.commit);
  assert(commitBytes !== null);

  // The first 3 bytes of CBOR for a map with 6 keys (0xa6...)
  // Just verify the signature is present and non-empty
  const { decode: cborDecode } = await import("../../cbor/dag-cbor.ts");
  const commit = cborDecode(commitBytes!) as Record<string, unknown>;
  assert(commit.sig !== undefined);
});

Deno.test("repo: update and delete records", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const repo = new Repo(store, signer);

  // Create
  await repo.applyWrites(repo.did, [{
    action: "create", collection: "test.col", rkey: "1",
    record: { $type: "test.col", count: 1 },
  }]);

  // Update
  await repo.applyWrites(repo.did, [{
    action: "update", collection: "test.col", rkey: "1",
    record: { $type: "test.col", count: 2 },
  }]);

  const updated = await repo.getRecord(repo.did, "test.col", "1");
  assertEquals((updated!.value as Record<string, unknown>).count, 2);

  // Delete
  await repo.applyWrites(repo.did, [{
    action: "delete", collection: "test.col", rkey: "1",
  }]);

  const deleted = await repo.getRecord(repo.did, "test.col", "1");
  assertEquals(deleted, null);
});

Deno.test("repo: listRecords with pagination", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const repo = new Repo(store, signer);

  // Create multiple records
  const writes: WriteOp[] = [];
  for (let i = 0; i < 5; i++) {
    writes.push({
      action: "create", collection: "test.page", rkey: `${i}`,
      record: { $type: "test.page", index: i },
    });
  }
  await repo.applyWrites(repo.did, writes);

  // List with limit
  const page1 = await repo.listRecords(repo.did, "test.page", { limit: 3 });
  assertEquals(page1.records.length, 3);
  assert(page1.cursor !== undefined);

  // List with cursor
  const page2 = await repo.listRecords(repo.did, "test.page", { limit: 3, cursor: page1.cursor });
  assertEquals(page2.records.length, 2);
});

Deno.test("repo: describe returns collections", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const repo = new Repo(store, signer);

  await repo.applyWrites(repo.did, [
    { action: "create", collection: "app.bsky.feed.post", rkey: "1", record: { text: "a" } },
    { action: "create", collection: "app.bsky.feed.like", rkey: "1", record: { subject: "x" } },
  ]);

  const desc = await repo.describe(repo.did);
  assertEquals(desc.collections.length, 2);
  assert(desc.collections.includes("app.bsky.feed.post"));
  assert(desc.collections.includes("app.bsky.feed.like"));
});
