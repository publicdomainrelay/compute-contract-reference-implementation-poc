// @publicdomainrelay/hono-factory-atproto-repo — CAR v1 export/import
//
// Content-Addressable Archive format for transporting repo blocks.
// CARv1: {header: {roots: CID[], version: 1}} | block* | [optional index]
// Each block: [CID bytes, data bytes] with varint length prefix.

import type { Bytes, Cid } from "../contracts.ts";
import { encode as cborEncode, decode as cborDecode } from "../cbor/dag-cbor.ts";
import { cidFromDigest } from "../util/cid.ts";
import { base32Decode, base32Encode, concat } from "../util/bytes.ts";
import type { BlockStore } from "../mst/mst.ts";

// ── varint ────────────────────────────────────────────────────────

function varintEncode(n: number): Bytes {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n & 0x7f);
  return new Uint8Array(out);
}

function readVarint(buf: Bytes, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buf.length) {
    const b = buf[offset + bytesRead];
    bytesRead++;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error("CAR: varint too long");
  }
  return { value, bytesRead };
}

// ── CID raw bytes ─────────────────────────────────────────────────

function cidToRawBytes(cid: Cid): Bytes {
  if (!cid.startsWith("b")) throw new Error("CID must start with 'b'");
  return base32Decode(cid.slice(1));
}

function cidFromRawBytes(bytes: Bytes): Cid {
  return "b" + base32Encode(bytes);
}

// ── collect all blocks from MST ───────────────────────────────────

async function collectAllBlocks(
  store: BlockStore,
  rootCid: Cid,
  seen: Set<Cid> = new Set(),
): Promise<{ cid: Cid; bytes: Bytes }[]> {
  if (seen.has(rootCid)) return [];
  seen.add(rootCid);

  const bytes = await store.get(rootCid);
  if (!bytes) throw new Error(`CAR: block not found: ${rootCid}`);

  const result: { cid: Cid; bytes: Bytes }[] = [{ cid: rootCid, bytes }];

  // Parse the block to find child CIDs (MST nodes and record values)
  try {
    const obj = cborDecode(bytes) as Record<string, unknown>;
    // MST node: { l: CID link?, e: [{k, v: CID}] }
    if (obj.l && typeof obj.l === "object" && "$link" in obj.l) {
      const childCid = (obj.l as { $link: Cid }).$link;
      const childBlocks = await collectAllBlocks(store, childCid, seen);
      result.push(...childBlocks);
    }
    if (Array.isArray(obj.e)) {
      for (const entry of obj.e as Array<{ v: { $link: Cid } }>) {
        if (entry.v && typeof entry.v === "object" && "$link" in entry.v) {
          const valCid = entry.v.$link;
          const valBlocks = await collectAllBlocks(store, valCid, seen);
          result.push(...valBlocks);
        }
      }
    }
  } catch {
    // Not a CBOR node we can parse — skip recursive traversal
  }

  return result;
}

// ── public API ────────────────────────────────────────────────────

/**
 * Export the full repo as a CARv1 byte array.
 * Includes the root commit, all MST nodes, and all record blocks.
 */
export async function exportCar(
  store: BlockStore,
  rootCid: Cid,
): Promise<Bytes> {
  const blocks = await collectAllBlocks(store, rootCid);
  const parts: Bytes[] = [];

  // CARv1 header: { roots: [rootCid], version: 1 }
  const header = cborEncode({ roots: [cidToRawBytes(rootCid)], version: 1 });
  parts.push(varintEncode(header.length), header);

  for (const block of blocks) {
    const cidBytes = cidToRawBytes(block.cid);
    const combined = concat(cidBytes, block.bytes);
    parts.push(varintEncode(combined.length), combined);
  }

  // Concatenate all parts
  return concat(...parts);
}

/** Represents a single block from a CAR file. */
export interface CarBlock {
  cid: Cid;
  bytes: Bytes;
}

/**
 * Import blocks from a CARv1 byte array.
 * Returns the list of root CIDs and all blocks.
 */
export async function importCar(
  carBytes: Bytes,
): Promise<{ roots: Cid[]; blocks: CarBlock[] }> {
  let offset = 0;

  // Read header length varint
  const { value: headerLen, bytesRead: hdrVarintLen } = readVarint(carBytes, offset);
  offset += hdrVarintLen;

  // Read header
  const headerBytes = carBytes.slice(offset, offset + headerLen);
  offset += headerLen;
  const header = cborDecode(headerBytes) as { roots?: Uint8Array[]; version: number };
  const roots: Cid[] = (header.roots ?? []).map((r) => cidFromRawBytes(r));

  // Read blocks
  const blocks: CarBlock[] = [];
  while (offset < carBytes.length) {
    const { value: blockLen, bytesRead: blkVarintLen } = readVarint(carBytes, offset);
    offset += blkVarintLen;
    if (blockLen === 0) continue;

    const blockData = carBytes.slice(offset, offset + blockLen);
    offset += blockLen;

    // First part is the CID (variable length based on CID format)
    // CIDv1 has 36 bytes of raw bytes (4 header + 32 sha256)
    // But we need to determine the CID length from the data.
    // For dag-cbor sha256 CIDv1: 36 bytes
    const CIDV1_LEN = 36;
    if (blockData.length < CIDV1_LEN) {
      throw new Error(`CAR: block too short for CID: ${blockData.length} bytes`);
    }
    const cidBytes = blockData.slice(0, CIDV1_LEN);
    const data = blockData.slice(CIDV1_LEN);
    const cid = cidFromRawBytes(cidBytes);
    blocks.push({ cid, bytes: data });
  }

  return { roots, blocks };
}
