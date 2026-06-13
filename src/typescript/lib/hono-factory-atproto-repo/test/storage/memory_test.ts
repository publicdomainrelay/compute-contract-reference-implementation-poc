// @publicdomainrelay/hono-factory-atproto-repo — MemoryStorage conformance tests

import { runStorageTests } from "./conformance.ts";
import { MemoryStorage } from "../../storage/memory.ts";

runStorageTests("MemoryStorage", async () => new MemoryStorage());
