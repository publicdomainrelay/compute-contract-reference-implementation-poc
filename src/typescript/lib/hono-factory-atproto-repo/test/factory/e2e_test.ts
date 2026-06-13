// @publicdomainrelay/hono-factory-atproto-repo — End-to-end test
//
// Build factory with memory storage → drive app.fetch() for create/get/list
// → assert a matching firehose frame delivered to a subscribe consumer.
// No relay required (in-process).

import { assertEquals, assert } from "@std/assert";
import { MemoryStorage } from "../../storage/memory.ts";
import { signerFromKeypair } from "../../crypto/signer.ts";
import { createRepoFactory } from "../../factory/factory.ts";
import { Secp256k1Keypair } from "@atproto/crypto";

Deno.test("e2e: factory app.fetch createRecord + getRecord", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const factory = createRepoFactory({ storage: store, signer });
  const did = signer.did();

  // ── createRecord via app.fetch ─────────────────────────────────
  const createBody = JSON.stringify({
    collection: "app.bsky.feed.post",
    record: { $type: "app.bsky.feed.post", text: "hello e2e", createdAt: new Date().toISOString() },
  });
  const createReq = new Request("https://pds.local/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: createBody,
  });
  const createRes = await factory.app.fetch(createReq);
  assertEquals(createRes.status, 200);
  const createJson = await createRes.json() as { uri: string; cid: string };
  assert(createJson.uri.startsWith("at://"), `uri: ${createJson.uri}`);
  assert(createJson.cid.length > 0);

  // Extract rkey from URI
  const uriParts = createJson.uri.split("/");
  const rkey = uriParts[uriParts.length - 1];
  const collection = uriParts[uriParts.length - 2];

  // ── getRecord via app.fetch ────────────────────────────────────
  const getUrl = `https://pds.local/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
  const getReq = new Request(getUrl);
  const getRes = await factory.app.fetch(getReq);
  assertEquals(getRes.status, 200);
  const getJson = await getRes.json() as { uri: string; cid: string; value: { text: string } };
  assertEquals(getJson.uri, createJson.uri);
  assertEquals(getJson.value.text, "hello e2e");
});

Deno.test("e2e: factory listRecords with pagination", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const factory = createRepoFactory({ storage: store, signer });

  // Create 5 records via the API (programmatic)
  for (let i = 0; i < 5; i++) {
    const body = JSON.stringify({
      collection: "test.page",
      record: { $type: "test.page", index: i },
    });
    const req = new Request("https://pds.local/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const res = await factory.app.fetch(req);
    assertEquals(res.status, 200, `create ${i} should return 200`);
  }

  // List with limit
  const listUrl = `https://pds.local/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(signer.did())}&collection=test.page&limit=3`;
  const listRes = await factory.app.fetch(new Request(listUrl));
  assertEquals(listRes.status, 200);
  const listJson = await listRes.json() as { records: unknown[]; cursor?: string };
  assertEquals(listJson.records.length, 3);
  assert(listJson.cursor !== undefined);

  // Page 2
  const listUrl2 = listUrl + `&cursor=${encodeURIComponent(listJson.cursor!)}`;
  const listRes2 = await factory.app.fetch(new Request(listUrl2));
  assertEquals(listRes2.status, 200);
  const listJson2 = await listRes2.json() as { records: unknown[]; cursor?: string };
  assertEquals(listJson2.records.length, 2);
});

Deno.test("e2e: firehose subscribe receives commit frame", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const factory = createRepoFactory({ storage: store, signer });

  // Collect frames delivered to subscribe
  const frames: unknown[] = [];
  const sub = { subscriptionId: "test-1", nsid: "com.atproto.sync.subscribeRepos", params: {} };
  const dispose = factory.subscribe(sub, (msg) => {
    frames.push(msg);
  });

  // Let the async loop in subscribeHandler reach sequencer.live()
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Create a record (trigger the sequencer)
  const body = JSON.stringify({
    collection: "app.bsky.feed.post",
    record: { $type: "app.bsky.feed.post", text: "firehose test", createdAt: new Date().toISOString() },
  });
  const req = new Request("https://pds.local/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await factory.app.fetch(req);

  // Wait a tick for async delivery
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Should have received at least one commit frame
  assert(frames.length >= 1, `expected >= 1 frames, got ${frames.length}`);
  const frame = frames[0] as Record<string, unknown>;
  assertEquals(frame.$type, "com.atproto.sync.subscribeRepos#commit");
  assert(typeof frame.seq === "number", `seq should be number, got ${typeof frame.seq}`);
  assertEquals(frame.repo, signer.did());

  if (typeof dispose === "function") dispose();
});

Deno.test("e2e: _health endpoint", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const factory = createRepoFactory({ storage: store, signer: signerFromKeypair(kp) });

  const res = await factory.app.fetch(new Request("https://pds.local/xrpc/_health"));
  assertEquals(res.status, 200);
  const json = await res.json() as { status: string };
  assertEquals(json.status, "ok");
});

Deno.test("e2e: describeServer endpoint", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const factory = createRepoFactory({ storage: store, signer });

  const res = await factory.app.fetch(new Request("https://pds.local/xrpc/com.atproto.server.describeServer"));
  assertEquals(res.status, 200);
  const json = await res.json() as { did: string; version: string };
  assertEquals(json.did, signer.did());
  assert(json.version.length > 0);
});

Deno.test("e2e: well-known atproto-did endpoint", async () => {
  const store = new MemoryStorage();
  const kp = await Secp256k1Keypair.create();
  const signer = signerFromKeypair(kp);
  const factory = createRepoFactory({ storage: store, signer });

  const res = await factory.app.fetch(new Request("https://pds.local/.well-known/atproto-did"));
  assertEquals(res.status, 200);
  const text = await res.text();
  assertEquals(text, signer.did());
});
