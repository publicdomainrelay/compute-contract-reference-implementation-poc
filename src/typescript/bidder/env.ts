// Tiny env helpers shared by main.ts and the settlement modules, so each part
// reads only the variables it actually needs (e.g. the x402 settlement requires
// CDP keys, the free settlement requires none).

import { createLogger } from "@publicdomainrelay/utils-log";

const log = createLogger({ service: "bidder" });

/** Read a required env var, exiting with a clear message if it is unset. */
export function reqEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    log("error", "required env var not set", { name });
    Deno.exit(1);
  }
  return v;
}

/** Read an optional env var, trimming trailing slashes (for URLs/base paths). */
export function optUrl(name: string, fallback = ""): string {
  return (Deno.env.get(name) ?? fallback).replace(/\/+$/, "");
}
