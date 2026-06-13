// @publicdomainrelay/hono-factory-atproto-repo — deterministic DAG-CBOR
//
// Implements the IPLD DAG-CBOR spec:
// - CBOR subset: no floats, no indefinite-length, no non-string map keys
// - Tag 42 for CID links (encoded as byte strings)
// - Deterministic map key ordering (length-first, then lexicographic)
// - Integers use minimal encoding
//
// This is the correctness keystone for the entire repo system.
// Wrong canonical ordering ⇒ wrong CIDs ⇒ nothing verifies.

import type { Bytes, Cid } from "../contracts.ts";
import { cidToBytes } from "../util/cid.ts";

// ── CBOR major types ──────────────────────────────────────────────

const MAJOR_UINT = 0;
const MAJOR_NEG = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_SIMPLE = 7;

// ── additional info ───────────────────────────────────────────────

const AI_1BYTE = 24; // next 1 byte holds the value
const AI_2BYTE = 25;
const AI_4BYTE = 26;
const AI_8BYTE = 27;

// ── simple values ─────────────────────────────────────────────────

const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;

// ── tag constants ─────────────────────────────────────────────────

const TAG_CID = 42;

// ── encoder helpers ───────────────────────────────────────────────

function writeHeader(out: number[], major: number, value: number): void {
  if (value < 24) {
    out.push((major << 5) | value);
  } else if (value < 0x100) {
    out.push((major << 5) | AI_1BYTE, value);
  } else if (value < 0x10000) {
    out.push((major << 5) | AI_2BYTE, (value >>> 8) & 0xff, value & 0xff);
  } else if (value < 0x100000000) {
    out.push(
      (major << 5) | AI_4BYTE,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  } else {
    // 8-byte — not needed for atproto values but included for correctness
    const hi = Math.floor(value / 0x100000000);
    const lo = value % 0x100000000;
    out.push(
      (major << 5) | AI_8BYTE,
      (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    );
  }
}

function encodeValue(val: unknown, out: number[]): void {
  if (val === null) {
    writeHeader(out, MAJOR_SIMPLE, SIMPLE_NULL);
    return;
  }
  if (val === true) {
    writeHeader(out, MAJOR_SIMPLE, SIMPLE_TRUE);
    return;
  }
  if (val === false) {
    writeHeader(out, MAJOR_SIMPLE, SIMPLE_FALSE);
    return;
  }
  if (typeof val === "number") {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) {
      if (val >= 0) {
        writeHeader(out, MAJOR_UINT, val);
      } else {
        writeHeader(out, MAJOR_NEG, -1 - val);
      }
    } else {
      throw new Error("DAG-CBOR: floats not allowed");
    }
    return;
  }
  if (typeof val === "string") {
    const encoded = new TextEncoder().encode(val);
    writeHeader(out, MAJOR_TEXT, encoded.length);
    for (let i = 0; i < encoded.length; i++) out.push(encoded[i]);
    return;
  }
  if (val instanceof Uint8Array) {
    writeHeader(out, MAJOR_BYTES, val.length);
    for (let i = 0; i < val.length; i++) out.push(val[i]);
    return;
  }
  if (Array.isArray(val)) {
    writeHeader(out, MAJOR_ARRAY, val.length);
    for (const item of val) encodeValue(item, out);
    return;
  }
  if (typeof val === "object") {
    // Check for CID link: { $link: "bafy..." }
    if ("$link" in val && typeof (val as Record<string, unknown>).$link === "string") {
      const cid = (val as { $link: Cid }).$link;
      const cidBytes = cidToBytes(cid);
      // Tag 42 (CID) wrapping a byte string with 0x00 prefix
      // The 0x00 prefix is required by the atproto data model for
      // historical reasons. Without it, every MST node CID differs.
      writeHeader(out, MAJOR_TAG, TAG_CID);
      writeHeader(out, MAJOR_BYTES, cidBytes.length + 1); // +1 for 0x00 prefix
      out.push(0x00); // required 0x00 prefix byte
      for (let i = 0; i < cidBytes.length; i++) out.push(cidBytes[i]);
      return;
    }
    // Regular map
    const keys = Object.keys(val);
    // Deterministic key sort: length-first, then lexicographic
    keys.sort((a, b) => {
      const aLen = new TextEncoder().encode(a).length;
      const bLen = new TextEncoder().encode(b).length;
      if (aLen !== bLen) return aLen - bLen;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    writeHeader(out, MAJOR_MAP, keys.length);
    for (const key of keys) {
      encodeValue(key, out);
      encodeValue((val as Record<string, unknown>)[key], out);
    }
    return;
  }
  throw new Error(`DAG-CBOR: unsupported type ${typeof val}`);
}

// ── decoder helpers ───────────────────────────────────────────────

class Decoder {
  #buf: Uint8Array;
  #pos = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
  }

  #readByte(): number {
    if (this.#pos >= this.#buf.length) throw new Error("DAG-CBOR: unexpected end of input");
    return this.#buf[this.#pos++];
  }

  #readHeader(): { major: number; value: number } {
    const b = this.#readByte();
    const major = b >> 5;
    const ai = b & 0x1f;
    let value: number;
    if (ai < 24) {
      value = ai;
    } else if (ai === AI_1BYTE) {
      value = this.#readByte();
    } else if (ai === AI_2BYTE) {
      value = (this.#readByte() << 8) | this.#readByte();
    } else if (ai === AI_4BYTE) {
      value = (this.#readByte() << 24) | (this.#readByte() << 16) |
        (this.#readByte() << 8) | this.#readByte();
    } else if (ai === AI_8BYTE) {
      const hi = (this.#readByte() << 24) | (this.#readByte() << 16) |
        (this.#readByte() << 8) | this.#readByte();
      const lo = (this.#readByte() << 24) | (this.#readByte() << 16) |
        (this.#readByte() << 8) | this.#readByte();
      value = hi * 0x100000000 + lo;
      if (!Number.isSafeInteger(value)) {
        throw new Error("DAG-CBOR: 8-byte integer out of safe range");
      }
    } else {
      throw new Error(`DAG-CBOR: unsupported additional info ${ai}`);
    }
    return { major, value };
  }

  decode(): unknown {
    const { major, value } = this.#readHeader();
    switch (major) {
      case MAJOR_UINT: return value;
      case MAJOR_NEG: return -1 - value;
      case MAJOR_BYTES: {
        const out = new Uint8Array(value);
        for (let i = 0; i < value; i++) out[i] = this.#readByte();
        return out;
      }
      case MAJOR_TEXT: {
        const bytes = new Uint8Array(value);
        for (let i = 0; i < value; i++) bytes[i] = this.#readByte();
        return new TextDecoder().decode(bytes);
      }
      case MAJOR_ARRAY: {
        const arr: unknown[] = [];
        for (let i = 0; i < value; i++) arr.push(this.decode());
        return arr;
      }
      case MAJOR_MAP: {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < value; i++) {
          const key = this.decode();
          if (typeof key !== "string") {
            throw new Error("DAG-CBOR: map keys must be strings");
          }
          obj[key] = this.decode();
        }
        return obj;
      }
      case MAJOR_TAG: {
        if (value === TAG_CID) {
          // CID tag: next value must be a byte string
          const next = this.#readHeader();
          if (next.major !== MAJOR_BYTES) {
            throw new Error("DAG-CBOR: tag 42 must wrap a byte string");
          }
          const bytes = new Uint8Array(next.value);
          for (let i = 0; i < next.value; i++) bytes[i] = this.#readByte();
          // Strip leading 0x00 prefix (required by atproto spec)
          // The first byte of a CID tag 42 payload is always 0x00
          if (bytes.length > 0 && bytes[0] === 0x00) {
            return cidLink(bytes.subarray(1));
          }
          return cidLink(bytes);
        }
        throw new Error(`DAG-CBOR: unsupported tag ${value}`);
      }
      case MAJOR_SIMPLE: {
        switch (value) {
          case SIMPLE_FALSE: return false;
          case SIMPLE_TRUE: return true;
          case SIMPLE_NULL: return null;
          default: throw new Error(`DAG-CBOR: unsupported simple value ${value}`);
        }
      }
      default:
        throw new Error(`DAG-CBOR: unsupported major type ${major}`);
    }
  }

  get remaining(): number {
    return this.#buf.length - this.#pos;
  }
}

// ── CID link helpers ──────────────────────────────────────────────

/**
 * Encode a CID string as a DAG-CBOR CID link: `{ $link: "bafy..." }`.
 * In CBOR this is tag 42 wrapping the raw CID bytes.
 */
export function cidLink(cidOrBytes: Cid | Bytes): { $link: Cid } {
  if (typeof cidOrBytes === "string") {
    return { $link: cidOrBytes };
  }
  // Re-encode bytes to CID string
  const base32Encode = (b: Uint8Array): string => {
    const ALPH = "abcdefghijklmnopqrstuvwxyz234567";
    let s = "";
    let bits = 0;
    let value = 0;
    for (let i = 0; i < b.length; i++) {
      value = (value << 8) | b[i];
      bits += 8;
      while (bits >= 5) {
        s += ALPH[(value >>> (bits - 5)) & 0x1f];
        bits -= 5;
      }
    }
    if (bits > 0) s += ALPH[(value << (5 - bits)) & 0x1f];
    return s;
  };
  return { $link: ("b" + base32Encode(cidOrBytes)) as Cid };
}

/** Check if a value is a CID link object. */
export function isCidLink(val: unknown): val is { $link: Cid } {
  return typeof val === "object" && val !== null &&
    "$link" in val && typeof (val as Record<string, unknown>).$link === "string";
}

/** Extract the raw CID string from a link object. */
export function cidFromLink(link: { $link: Cid }): Cid {
  return link.$link;
}

// ── public API ────────────────────────────────────────────────────

/** Encode a value to deterministic DAG-CBOR bytes. */
export function encode(val: unknown): Bytes {
  const out: number[] = [];
  encodeValue(val, out);
  return new Uint8Array(out);
}

/** Decode DAG-CBOR bytes to a value. */
export function decode(buf: Bytes): unknown {
  const dec = new Decoder(buf);
  const val = dec.decode();
  // There may be trailing bytes in a stream; that's ok for our use case
  return val;
}
