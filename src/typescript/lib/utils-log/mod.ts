// @publicdomainrelay/utils-log — shared structured JSON logging with DID context.
//
// Canonical source. Other packages should import from here:
//   import { createLogger, ON_BEHALF_OF_HEADER } from "@publicdomainrelay/utils-log";
//
// The original utils/log.ts re-exports from here for backward compatibility.

import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogContext {
  actorDid?: string;
  onBehalfOfDid?: string;
}

export const ON_BEHALF_OF_HEADER = "x-on-behalf-of-did";

const als = new AsyncLocalStorage<LogContext>();

export function currentLogContext(): LogContext {
  return als.getStore() ?? {};
}

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return als.run({ ...currentLogContext(), ...ctx }, fn);
}

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
  service: string;
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
