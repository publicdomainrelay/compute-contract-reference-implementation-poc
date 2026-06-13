// @publicdomainrelay/hono-factory-atproto-repo — Event sequencer
//
// Assigns monotonic `seq` numbers, builds subscribeRepos `#commit` frames,
// keeps a bounded in-memory backlog for cursor-based backfill, and
// emits live frames via `@publicdomainrelay/event-bus`.
//
// The Sequencer interface from contracts.ts:
//   append(evt) → SequencedFrame
//   backfill(since?) → AsyncIterable<SequencedFrame>
//   live() → AsyncIterable<SequencedFrame>
//
// Persistence: in-memory only for v1. Persistent cursor store is a follow-up.

import type { CommitEvent, SequencedFrame, Sequencer } from "../contracts.ts";
import { encode as cborEncode } from "../cbor/dag-cbor.ts";
import { EventBus } from "@publicdomainrelay/event-bus";

// ── config ────────────────────────────────────────────────────────

/** Maximum backlog size. Older events are evicted. */
const MAX_BACKLOG = 10_000;

// ── implementation ────────────────────────────────────────────────

export class FirehoseSequencer implements Sequencer {
  #seq = 0;
  #backlog: SequencedFrame[] = [];
  #bus = new EventBus<SequencedFrame>();

  // ── Sequencer interface ────────────────────────────────────────

  append(evt: CommitEvent): SequencedFrame {
    const seq = ++this.#seq;
    const frame: SequencedFrame = {
      $type: "com.atproto.sync.subscribeRepos#commit",
      seq,
      repo: evt.repo,
      commit: evt.commit,
      rev: evt.rev,
      since: evt.since,
      blocks: evt.blocks, // already CAR bytes
      ops: evt.ops.map((op) => ({
        action: op.action,
        path: op.path,
        cid: op.cid,
      })),
      time: new Date().toISOString(),
    };

    this.#backlog.push(frame);
    if (this.#backlog.length > MAX_BACKLOG) {
      this.#backlog.shift();
    }
    this.#bus.publish(frame);
    return frame;
  }

  async *backfill(since?: number): AsyncIterable<SequencedFrame> {
    for (const frame of this.#backlog) {
      const seq = frame.seq as number;
      if (since === undefined || seq > since) {
        yield frame;
      }
    }
  }

  async *live(): AsyncIterable<SequencedFrame> {
    // We use a push-to-pull adapter: queue events, then yield them
    const queue: SequencedFrame[] = [];
    let resolveNext: ((value: SequencedFrame | null) => void) | null = null;

    const disposer = this.#bus.subscribe((frame) => {
      if (resolveNext) {
        resolveNext(frame);
        resolveNext = null;
      } else {
        queue.push(frame);
      }
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          const frame = await new Promise<SequencedFrame | null>((resolve) => {
            resolveNext = resolve;
          });
          if (frame === null) break;
          yield frame;
        }
      }
    } finally {
      disposer();
    }
  }

  // ── extras ─────────────────────────────────────────────────────

  /** Number of events in the backlog. */
  get backlogSize(): number {
    return this.#backlog.length;
  }

  /** Latest seq number. */
  get currentSeq(): number {
    return this.#seq;
  }

  /** Get the event bus for external subscribers. */
  get bus(): EventBus<SequencedFrame> {
    return this.#bus;
  }
}
