// @publicdomainrelay/event-bus — a tiny, typed, synchronous fan-out bus.
//
// Isomorphic (Deno + browser): no runtime deps, no Node built-ins.
//
// One producer publishes; every current subscriber receives the message
// synchronously in subscription order. `subscribe` returns a disposer, which
// matches the SubscribeHandler contract in @publicdomainrelay/xrpc-relay:
//
//   subscribe: (sub, emit) => bus.subscribe(emit)
//
// Intentionally minimal. Extend (replay buffer, async backpressure, filtering,
// per-topic channels) as consumers need it — see lib/hono-factory-atproto-repo
// PLAN.md, which builds its firehose sequencer on top of this.

export type BusListener<T> = (message: T) => void;

export class EventBus<T = unknown> {
  #listeners = new Set<BusListener<T>>();

  /** Register a listener. Returns a disposer that removes it. */
  subscribe(listener: BusListener<T>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Deliver a message to every current listener, in subscription order. */
  publish(message: T): void {
    for (const listener of this.#listeners) listener(message);
  }

  /** Number of active listeners. */
  get size(): number {
    return this.#listeners.size;
  }

  /** Drop all listeners. */
  clear(): void {
    this.#listeners.clear();
  }
}
