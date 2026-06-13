// @publicdomainrelay/hono-factory-atproto-repo — TID generator
//
// TID: 13-char base32-sortable record key (atproto "rkey" for record IDs).
//
// Layout (8 bytes → 13 base32 chars):
//   bytes 0-6:  microsecond timestamp (big-endian, 7 bytes = 56 bits)
//   byte 7:     clock ID (8-bit, random, assigned at first generation)
//
// The 56-bit timestamp field holds the full microsecond value (JS max safe
// integer is 53 bits, so 56 bits covers it without loss).
//
// Uses ASCII-sortable base32 so that string comparison of TIDs matches
// the numeric order of the underlying timestamps. This is critical for
// MST key ordering. The alphabet is:
//
//   "234567abcdefghijklmnopqrstuvwxyz"  (indices 0-31 in ASCII order)
//
// Note: this is DIFFERENT from the RFC 4648 base32 used for CIDs.

import type { Tid } from "../contracts.ts";

// ── constants ─────────────────────────────────────────────────────

const TID_LEN = 13;

/** ASCII-sortable base32 alphabet. Digits first (2-7), then letters (a-z).
 * This ensures that lexicographic string comparison matches the numeric
 * order of the encoded bytes. */
const B32 = "234567abcdefghijklmnopqrstuvwxyz";

// ── clock ─────────────────────────────────────────────────────────

let clockId: number | null = null;

function getClockId(): number {
  if (clockId !== null) return clockId;
  clockId = (Math.random() * 256) | 0;
  return clockId;
}

export function resetClockId(id?: number): void {
  lastMicros = 0;
  if (id !== undefined) {
    if (id < 0 || id > 255) throw new Error("clockId must be 0-255");
    clockId = id;
  } else {
    clockId = null;
  }
}

// ── TID generation ────────────────────────────────────────────────

let lastMicros = 0;

export function nextTid(): Tid {
  const clock = getClockId();

  let micros: number;
  try {
    micros = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  } catch {
    micros = Date.now() * 1000;
  }

  if (micros <= lastMicros) {
    micros = lastMicros + 1;
  }
  lastMicros = micros;

  return packTid(micros, clock);
}

export function tidFromTime(micros: number, clock?: number): Tid {
  return packTid(micros, clock ?? getClockId());
}

// ── ASCII-sortable base32 encode/decode (local, not shared with CID) ──

function b32encode(bytes: Uint8Array): string {
  let s = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      s += B32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    s += B32[(value << (5 - bits)) & 0x1f];
  }
  return s;
}

function b32decode(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < s.length; i++) {
    const idx = B32.indexOf(s[i]);
    if (idx === -1) throw new Error(`b32decode: invalid character '${s[i]}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ── pack / unpack ─────────────────────────────────────────────────

function packTid(micros: number, clock: number): Tid {
  const HI_MUL = 0x100000000; // 2^32
  const hi = Math.floor(micros / HI_MUL);
  const lo = micros % HI_MUL;

  const buf = new Uint8Array(8);
  // High 24 bits → bytes 0-2
  buf[0] = (hi >>> 16) & 0xff;
  buf[1] = (hi >>> 8) & 0xff;
  buf[2] = hi & 0xff;
  // Low 32 bits → bytes 3-6
  buf[3] = (lo >>> 24) & 0xff;
  buf[4] = (lo >>> 16) & 0xff;
  buf[5] = (lo >>> 8) & 0xff;
  buf[6] = lo & 0xff;
  // Byte 7: clock ID
  buf[7] = clock & 0xff;

  const encoded = b32encode(buf);
  return encoded.padEnd(TID_LEN, "2").slice(0, TID_LEN) as Tid;
}

export function parseTid(tid: Tid): { micros: number; clockId: number } {
  const buf = b32decode(tid);
  if (buf.length < 8) throw new Error("parseTid: decoded TID too short");

  const HI_MUL = 0x100000000;
  const hi = (buf[0] << 16) | (buf[1] << 8) | buf[2];
  const lo = ((buf[3] << 24) | (buf[4] << 16) | (buf[5] << 8) | buf[6]) >>> 0;
  const micros = hi * HI_MUL + lo;
  const clockId = buf[7];

  return { micros, clockId };
}

export function isValidTid(s: string): s is Tid {
  if (s.length !== TID_LEN) return false;
  for (let i = 0; i < s.length; i++) {
    if (!B32.includes(s[i])) return false;
  }
  return true;
}
