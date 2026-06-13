// @publicdomainrelay/hono-factory-atproto-repo — DenoKvStorage conformance tests
//
// Skip if Deno.openKv is not available (non-Deno environment).

import { runStorageTests } from "./conformance.ts";
import { DenoKvStorage } from "../../storage/deno-kv.ts";

const kvAvailable = typeof Deno !== "undefined" &&
  typeof Deno.openKv === "function";

if (kvAvailable) {
  runStorageTests("DenoKvStorage", () => DenoKvStorage.create());
} else {
  Deno.test("DenoKvStorage: skipped (Deno.openKv not available)", () => {
    console.log("Skipping Deno KV tests — Deno.openKv is not available");
  });
}
