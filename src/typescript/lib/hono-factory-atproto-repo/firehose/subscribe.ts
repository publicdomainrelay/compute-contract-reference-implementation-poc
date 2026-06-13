// @publicdomainrelay/hono-factory-atproto-repo — SubscribeHandler for the firehose
//
// Bridges the Sequencer into the xrpc-relay's SubscribeHandler contract:
//
//   type SubscribeHandler = (sub, emit) => (() => void) | void
//
// Reuses @publicdomainrelay/event-bus for live fan-out; adds backfill
// from the sequencer's backlog for cursor-based resume.

import type { Sequencer, SequencedFrame } from "../contracts.ts";
import type { SubscribeHandler, Subscription } from "@publicdomainrelay/xrpc-relay";

export function createSubscribeHandler(sequencer: Sequencer): SubscribeHandler {
  return (sub: Subscription, emit: (message: unknown) => void): (() => void) | void => {
    // Only handle subscribeRepos
    if (sub.nsid !== "com.atproto.sync.subscribeRepos") {
      emit({
        $type: "com.atproto.sync.subscribeRepos#error",
        error: "UnknownCollection",
        message: `unknown subscription nsid: ${sub.nsid}`,
      });
      return;
    }

    let cancelled = false;
    const cursor = sub.params?.cursor ? parseInt(sub.params.cursor, 10) : undefined;

    // Run backfill + live in background
    (async () => {
      try {
        // Backfill: replay events since cursor
        for await (const frame of sequencer.backfill(cursor)) {
          if (cancelled) return;
          emit(frame);
        }

        // Live: stream new events
        for await (const frame of sequencer.live()) {
          if (cancelled) return;
          emit(frame);
        }
      } catch (err) {
        if (!cancelled) {
          emit({
            $type: "com.atproto.sync.subscribeRepos#error",
            error: "InternalError",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    // Return disposer
    return () => {
      cancelled = true;
    };
  };
}
