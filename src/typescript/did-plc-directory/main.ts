// did:plc Directory Server
//
// Local PLC directory — stores and validates did:plc operations,
// resolves DID documents, and exposes the standard REST API.
//
// Usage:
//   PORT=2583 deno run -A main.ts

import {
  createPlcDirectoryFactory,
  MemoryPlcStore,
} from "@publicdomainrelay/hono-factory-did-plc-directory";

const PORT = parseInt(Deno.env.get("PORT") ?? "2583");

const store = new MemoryPlcStore();
const { app } = createPlcDirectoryFactory({ store });

Deno.serve({ port: PORT }, app.fetch);
