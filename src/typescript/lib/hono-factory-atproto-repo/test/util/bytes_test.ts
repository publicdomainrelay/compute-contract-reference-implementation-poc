import { assertEquals, assertThrows } from "@std/assert";
import {
  hexEncode, hexDecode,
  base64Encode, base64Decode,
  base32Encode, base32Decode,
  utf8Encode, utf8Decode,
  concat, bytesEqual,
} from "../../util/bytes.ts";

Deno.test("bytes: utf8 round-trip", () => {
  const s = "hello world 🚀";
  assertEquals(utf8Decode(utf8Encode(s)), s);
});

Deno.test("bytes: hex round-trip", () => {
  const bytes = new Uint8Array([0x00, 0xff, 0xab, 0x12, 0x34]);
  const encoded = hexEncode(bytes);
  assertEquals(encoded, "00ffab1234");
  assertEquals(hexDecode(encoded), bytes);
});

Deno.test("bytes: hex odd length throws", () => {
  assertThrows(() => hexDecode("abc"));
});

Deno.test("bytes: base64 round-trip", () => {
  const bytes = new Uint8Array([0x00, 0xff, 0xab, 0x12, 0x34]);
  const encoded = base64Encode(bytes);
  const decoded = base64Decode(encoded);
  assertEquals(bytesEqual(bytes, decoded), true);
});

Deno.test("bytes: base32 round-trip", () => {
  const bytes = new Uint8Array(32).map((_, i) => i);
  const encoded = base32Encode(bytes);
  const decoded = base32Decode(encoded);
  assertEquals(bytesEqual(bytes, decoded), true);
});

Deno.test("bytes: base32 known vector", () => {
  // Empty bytes → empty string
  assertEquals(base32Encode(new Uint8Array(0)), "");

  // Single byte
  assertEquals(base32Encode(new Uint8Array([0x00])), "aa");
});

Deno.test("bytes: concat", () => {
  const a = new Uint8Array([1, 2]);
  const b = new Uint8Array([3, 4, 5]);
  const c = concat(a, b);
  assertEquals(c.length, 5);
  assertEquals(Array.from(c), [1, 2, 3, 4, 5]);
});

Deno.test("bytes: bytesEqual", () => {
  assertEquals(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assertEquals(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assertEquals(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});
