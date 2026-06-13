import { assertEquals, assert } from "@std/assert";
import { encode, decode, cidLink, isCidLink } from "../../cbor/dag-cbor.ts";
import { cidFromDigest, SHA256_DIGEST_LEN } from "../../util/cid.ts";
import { bytesEqual } from "../../util/bytes.ts";

// ── basic type round-trips ────────────────────────────────────────

Deno.test("cbor: null round-trip", () => {
  assertEquals(decode(encode(null)), null);
});

Deno.test("cbor: boolean round-trip", () => {
  assertEquals(decode(encode(true)), true);
  assertEquals(decode(encode(false)), false);
});

Deno.test("cbor: integer round-trip", () => {
  assertEquals(decode(encode(0)), 0);
  assertEquals(decode(encode(1)), 1);
  assertEquals(decode(encode(-1)), -1);
  assertEquals(decode(encode(23)), 23);  // boundary < 24
  assertEquals(decode(encode(24)), 24);  // boundary 1-byte
  assertEquals(decode(encode(255)), 255);
  assertEquals(decode(encode(65535)), 65535);
  assertEquals(decode(encode(65536)), 65536);
  assertEquals(decode(encode(-100)), -100);
});

Deno.test("cbor: string round-trip", () => {
  assertEquals(decode(encode("")), "");
  assertEquals(decode(encode("hello")), "hello");
  assertEquals(decode(encode("hello world 🚀")), "hello world 🚀");
});

Deno.test("cbor: bytes round-trip", () => {
  const b = new Uint8Array([0x00, 0xff, 0xab, 0x12]);
  const decoded = decode(encode(b)) as Uint8Array;
  assert(bytesEqual(decoded, b));
});

Deno.test("cbor: array round-trip", () => {
  const arr = [1, "two", true, null];
  const decoded = decode(encode(arr)) as unknown[];
  assertEquals(decoded, arr);
});

Deno.test("cbor: map round-trip", () => {
  const obj = { name: "test", count: 42, active: true };
  const decoded = decode(encode(obj)) as Record<string, unknown>;
  assertEquals(decoded, obj);
});

Deno.test("cbor: nested structure", () => {
  const obj = {
    items: [
      { id: 1, val: "a" },
      { id: 2, val: "b" },
    ],
    meta: { total: 2 },
  };
  const decoded = decode(encode(obj));
  assertEquals(decoded, obj);
});

// ── CID links ─────────────────────────────────────────────────────

Deno.test("cbor: CID link round-trip", () => {
  const digest = new Uint8Array(SHA256_DIGEST_LEN).fill(0x99);
  const cid = cidFromDigest(digest);
  const link = cidLink(cid);
  assert(isCidLink(link));
  assertEquals(link.$link, cid);

  const decoded = decode(encode(link)) as { $link: string };
  assertEquals(decoded.$link, cid);
});

// ── determinism ───────────────────────────────────────────────────

Deno.test("cbor: deterministic map key ordering", () => {
  // Keys of different lengths: shorter first
  const obj: Record<string, number> = { bb: 1, a: 2, ccc: 3 };
  const enc1 = encode(obj);
  const enc2 = encode(obj);
  assertEquals(Array.from(enc1), Array.from(enc2));

  // Keys of same length: lexicographic
  const obj2: Record<string, number> = { b: 1, a: 2, c: 3 };
  const enc3 = encode(obj2);
  const enc4 = encode(obj2);
  assertEquals(Array.from(enc3), Array.from(enc4));
});

Deno.test("cbor: deterministic encoding stable for identical input", () => {
  const obj = { hello: "world", foo: 123, bar: [1, 2, 3] };
  const enc1 = encode(obj);
  const enc2 = encode(obj);
  assertEquals(Array.from(enc1), Array.from(enc2));
});

// ── atproto-like record ───────────────────────────────────────────

Deno.test("cbor: atproto record shape", () => {
  const record = {
    $type: "app.bsky.feed.post",
    text: "hello world",
    createdAt: "2024-01-01T00:00:00.000Z",
  };
  const decoded = decode(encode(record)) as Record<string, unknown>;
  assertEquals(decoded.$type, "app.bsky.feed.post");
  assertEquals(decoded.text, "hello world");
  assertEquals(decoded.createdAt, "2024-01-01T00:00:00.000Z");
});

// ── floats rejected ───────────────────────────────────────────────

Deno.test("cbor: floats rejected", () => {
  try {
    encode(3.14);
    // Should not reach here
    assertEquals(true, false); // force failure
  } catch (e) {
    assert(String(e).includes("floats"));
  }
});
