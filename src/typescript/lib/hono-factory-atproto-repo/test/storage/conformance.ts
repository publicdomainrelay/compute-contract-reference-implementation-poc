// @publicdomainrelay/hono-factory-atproto-repo — storage conformance test suite
//
// Run these tests against any Storage backend to verify basic correctness.
// Usage:
//   import { runStorageTests } from "./conformance.ts";
//   runStorageTests("MyBackend", () => new MyBackend());

import { assertEquals } from "@std/assert";
import type { Storage } from "../../contracts.ts";

export function runStorageTests(
  name: string,
  createStore: () => Promise<Storage>,
) {
  Deno.test(`${name}: put and get a block`, async () => {
    const store = await createStore();
    const cid = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put(cid, bytes);
    const got = await store.get(cid);
    assertEquals(got, bytes);
  });

  Deno.test(`${name}: has a block`, async () => {
    const store = await createStore();
    const cid = "bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const bytes = new Uint8Array([4, 5, 6]);
    assertEquals(await store.has(cid), false);
    await store.put(cid, bytes);
    assertEquals(await store.has(cid), true);
  });

  Deno.test(`${name}: get missing block returns null`, async () => {
    const store = await createStore();
    const cid = "bafyreicccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const got = await store.get(cid);
    assertEquals(got, null);
  });

  Deno.test(`${name}: overwrite a block`, async () => {
    const store = await createStore();
    const cid = "bafyreidddddddddddddddddddddddddddddddddddddddddddddddddddd";
    await store.put(cid, new Uint8Array([1]));
    await store.put(cid, new Uint8Array([2]));
    const got = await store.get(cid);
    assertEquals(got, new Uint8Array([2]));
  });

  Deno.test(`${name}: set and get head`, async () => {
    const store = await createStore();
    const did = "did:plc:test";
    const head = {
      commit: "bafyreieeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      rev: "3jq6uqwb3jq6u",
    };
    await store.setHead(did, head);
    const got = await store.getHead(did);
    assertEquals(got, head);
  });

  Deno.test(`${name}: get missing head returns null`, async () => {
    const store = await createStore();
    const did = "did:plc:missing";
    const got = await store.getHead(did);
    assertEquals(got, null);
  });

  Deno.test(`${name}: overwrite head`, async () => {
    const store = await createStore();
    const did = "did:plc:overwrite";
    await store.setHead(did, {
      commit: "bafyreiffffffffffffffffffffffffffffffffffffffffffffffffffff",
      rev: "3jq6uqwb3jq6v",
    });
    await store.setHead(did, {
      commit: "bafyreigggggggggggggggggggggggggggggggggggggggggggggggggggg",
      rev: "3jq6uqwb3jq6w",
    });
    const got = await store.getHead(did);
    assertEquals(got, {
      commit: "bafyreigggggggggggggggggggggggggggggggggggggggggggggggggggg",
      rev: "3jq6uqwb3jq6w",
    });
  });
}
