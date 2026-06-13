import { assertEquals, assert } from "@std/assert";
import {
  cidFromDigest,
  cidToBytes,
  cidDigest,
  isValidCid,
  cidEquals,
  SHA256_DIGEST_LEN,
} from "../../util/cid.ts";
import { hexDecode } from "../../util/bytes.ts";

// Known atproto test vector:
// sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
// CIDv1 dag-cbor should be: bafyreide... (derived)
// Let's compute a known one manually.

Deno.test("cid: build from digest", () => {
  const digest = new Uint8Array(SHA256_DIGEST_LEN).fill(0x42);
  const cid = cidFromDigest(digest);
  assertEquals(typeof cid, "string");
  assertEquals(cid.startsWith("b"), true);
  // Should be ~59 chars (b + 52 base32 chars)
  assert(cid.length > 50 && cid.length < 65);
});

Deno.test("cid: round-trip bytes", () => {
  const digest = crypto.getRandomValues(new Uint8Array(SHA256_DIGEST_LEN));
  const cid = cidFromDigest(digest);
  assertEquals(cidDigest(cid), digest);
});

Deno.test("cid: isValidCid", () => {
  const digest = new Uint8Array(SHA256_DIGEST_LEN).fill(0x11);
  const cid = cidFromDigest(digest);
  assertEquals(isValidCid(cid), true);
  assertEquals(isValidCid("not-a-cid"), false);
  assertEquals(isValidCid(""), false);
});

Deno.test("cid: cidEquals", () => {
  const digest = new Uint8Array(SHA256_DIGEST_LEN).fill(0xaa);
  const cid1 = cidFromDigest(digest);
  const cid2 = cidFromDigest(digest);
  assertEquals(cidEquals(cid1, cid2), true);
});

Deno.test("cid: known sha256 vector", () => {
  // sha256 of empty is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  const knownDigest = hexDecode("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const cid = cidFromDigest(knownDigest);
  // Re-extract digest
  const extracted = cidDigest(cid);
  assertEquals(extracted, knownDigest);
});
