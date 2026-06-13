import { assertEquals, assert } from "@std/assert";
import { nextTid, tidFromTime, parseTid, isValidTid, resetClockId } from "../../util/tid.ts";

Deno.test("tid: nextTid produces valid 13-char TID", () => {
  resetClockId(0);
  const tid = nextTid();
  assertEquals(tid.length, 13);
  assertEquals(isValidTid(tid), true);
});

Deno.test("tid: strictly increasing", () => {
  resetClockId(0);
  const tids: string[] = [];
  for (let i = 0; i < 10; i++) {
    tids.push(nextTid());
  }
  for (let i = 1; i < tids.length; i++) {
    assert(tids[i] > tids[i - 1], `TID ${tids[i]} should be > ${tids[i - 1]}`);
  }
});

Deno.test("tid: tidFromTime deterministic", () => {
  resetClockId(0);
  const tid = tidFromTime(1000000, 42);
  assertEquals(isValidTid(tid), true);
  assertEquals(tid.length, 13);
  // Same inputs → same output
  assertEquals(tidFromTime(1000000, 42), tid);
});

Deno.test("tid: parseTid round-trip", () => {
  resetClockId(0);
  const tid = tidFromTime(1700000000000, 123); // clock ID must be < 256
  const parsed = parseTid(tid);
  assertEquals(parsed.micros, 1700000000000);
  assertEquals(parsed.clockId, 123);
});

Deno.test("tid: isValidTid rejects bad strings", () => {
  assertEquals(isValidTid(""), false);
  assertEquals(isValidTid("abc123"), false); // too short
  assertEquals(isValidTid("234567abcdefg"), true); // valid base32, 13 chars
  assertEquals(isValidTid("ABCDEFGHIJKLM"), false); // uppercase
  assertEquals(isValidTid("0000000000000"), false); // '0' not in alphabet
  assertEquals(isValidTid("1111111111111"), false); // '1' not in alphabet
});
