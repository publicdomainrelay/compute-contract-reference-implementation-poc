import type { SubscribeReposFrame } from "./types.ts";

/**
 * Build a rotating synthetic subscribeRepos frame.
 * Cycles through #commit → #identity → #account(active) → #account(suspended) → #info.
 */
export function buildSyntheticEvent(seq: number): SubscribeReposFrame {
  const now = new Date().toISOString();
  const repoDid = `did:plc:${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;

  switch (seq % 5) {
    case 0:
      return {
        seq,
        repo: repoDid,
        commit: { $link: `bafyreib${seq}mockcommitcid` },
        rev: `3j${Date.now().toString(36)}`,
        since: seq > 1 ? `3j${(Date.now() - 1000).toString(36)}` : null,
        blocks: new ArrayBuffer(0),
        ops: [{ action: "create", path: `app.bsky.feed.post/${seq}`, cid: { $link: `bafyreib${seq}mockcid` }, prev: null }],
        blobs: [],
        time: now,
      };
    case 1:
      return { seq, did: repoDid, time: now, handle: `user${seq}.bsky.social` };
    case 2:
      return { seq, did: repoDid, time: now, active: true };
    case 3:
      return { seq, did: repoDid, time: now, active: false, status: "suspended" };
    default: // 4
      return { name: "OutdatedCursor", message: "consumer cursor is behind, but continuing" };
  }
}

export function inferFrameType(frame: Record<string, unknown>): string {
  if (frame.repo && frame.seq != null) return "#commit";
  if (frame.name && typeof frame.name === "string") return "#info";
  if (frame.did && frame.active != null) return "#account";
  if (frame.did && frame.handle !== undefined) return "#identity";
  if (frame.did && frame.blocks && !frame.repo) return "#sync";
  return "#unknown";
}

export function summarizeFrame(frame: Record<string, unknown>, type: string): Record<string, unknown> {
  const summary: Record<string, unknown> = { _type: type };
  if (frame.seq != null) summary.seq = frame.seq;
  if (frame.repo) summary.repo = frame.repo;
  if (frame.did) summary.did = frame.did;
  if (frame.rev) summary.rev = frame.rev;
  if (frame.since != null) summary.since = frame.since;
  if (frame.handle) summary.handle = frame.handle;
  if (frame.active != null) summary.active = frame.active;
  if (frame.status) summary.status = frame.status;
  if (frame.name) summary.name = frame.name;
  if (frame.message) summary.message = frame.message;
  if (typeof frame.ops === "number") summary.ops_count = frame.ops;
  if (Array.isArray(frame.ops)) summary.ops_count = frame.ops.length;
  if (typeof frame.blocks === "string" && (frame.blocks as string).length < 100) {
    summary.blocks = (frame.blocks as string).slice(0, 40) + "...";
  }
  return summary;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
