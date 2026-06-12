// Shared structured logging for the spindle / bidder / qemu services.
//
// Goal: every JSON log line states *which DID is doing the operation*
// (`actorDid`) and, when the work is being performed on behalf of another
// party, *whose* request it ultimately serves (`onBehalfOfDid`).
//
// The "on behalf of" DID is carried through the async call tree via an
// AsyncLocalStorage context so individual log call sites don't each have to
// thread it manually — once a request handler binds it (runWithLogContext /
// setLogContext) every nested log line picks it up, including lines emitted by
// library code that was handed one of these loggers.
//
// It does NOT cross process / network boundaries: when one service calls
// another (e.g. the bidder provisioning a VM on qemu), the caller must forward
// the DID over the wire (see ON_BEHALF_OF_HEADER) so the callee can rebind it
// into its own log context.

import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogContext {
  // The DID performing the operation in the current async scope. When unset a
  // logger falls back to the service's own DID.
  actorDid?: string;
  // The DID this work is ultimately being performed on behalf of (e.g. the
  // author of the market.accept that triggered a VM provision).
  onBehalfOfDid?: string;
}

// HTTP header services use to forward the originating principal across the
// network so the downstream service can log it on its side.
export const ON_BEHALF_OF_HEADER = "x-on-behalf-of-did";

const als = new AsyncLocalStorage<LogContext>();

export function currentLogContext(): LogContext {
  return als.getStore() ?? {};
}

// Run `fn` with the given DID context layered over whatever is already active.
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return als.run({ ...currentLogContext(), ...ctx }, fn);
}

// Mutate the active context in place (e.g. after auth resolves the caller DID
// partway through a request that is already inside an als.run scope).
export function setLogContext(ctx: Partial<LogContext>): void {
  const store = als.getStore();
  if (store) Object.assign(store, ctx);
}

export type Logger = (
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

const enc = new TextEncoder();

export interface LoggerOptions {
  // Stable service identifier emitted on every line ("spindle"/"bidder"/"qemu").
  service: string;
  // The service's own DID, used as actorDid when nothing more specific is bound
  // in the async context. A function so it can be read lazily (some services
  // only learn their DID after async login).
  selfDid?: () => string | undefined;
}

export function createLogger(opts: LoggerOptions): Logger {
  return (level, msg, fields = {}) => {
    const ctx = als.getStore() ?? {};
    const actorDid = ctx.actorDid ?? opts.selfDid?.();
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: opts.service,
    };
    if (actorDid) entry.actorDid = actorDid;
    if (ctx.onBehalfOfDid) entry.onBehalfOfDid = ctx.onBehalfOfDid;
    entry.msg = msg;
    Object.assign(entry, fields);
    Deno.stderr.writeSync(enc.encode(JSON.stringify(entry) + "\n"));
  };
}
