# @publicdomainrelay/hono-factory-did-plc-directory

Hono factory for local [did:plc](https://web.plc.directory/spec/v0.1/did-plc) Directory Server.

Implements the [PLC Directory REST API](https://web.plc.directory/api/plc-server-openapi3.yaml) — operation submission, DID resolution, audit logs, and bulk export.

## Usage

```ts
import { createPlcDirectoryFactory, MemoryPlcStore } from "@publicdomainrelay/hono-factory-did-plc-directory";

const store = new MemoryPlcStore();
const { app } = createPlcDirectoryFactory({ store, version: "0.1.0" });

Deno.serve({ port: 2583 }, app.fetch);
```

## API

### `createPlcDirectoryFactory(opts?)`

Returns `{ app, store }`.

| Option | Default | Description |
|--------|---------|-------------|
| `store` | `MemoryPlcStore` | Operation log backend |
| `version` | `"0.1.0"` | Server version (returned by `/health`) |
| `verifySig` | `undefined` | Signature verifier. Omit for permissive mode (no sig check). |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server version |
| `GET` | `/{did}` | Resolve DID document |
| `GET` | `/{did}/log` | Current operation chain |
| `GET` | `/{did}/log/audit` | Full audit log (incl. nullified forks) |
| `POST` | `/{did}` | Submit signed PLC operation |
| `GET` | `/export` | Paginated bulk export (`?after=&count=`) |

## Exports

- `createPlcDirectoryFactory` — factory function
- `MemoryPlcStore` — in-memory `PlcStore` implementation
- `validateOperationStructure`, `verifyOperationSignature`, `validatePrevChain`, `validateRotationKeyAuth`, `computeOperationCid` — validation utilities
- `resolveDidDocument` — DID document resolution from operation chain
- Types: `PlcDirectoryOptions`, `PlcDirectoryFactory`, `PlcStore`

## Dependencies

- `@hono/hono` (jsr) — HTTP framework
- `@publicdomainrelay/did-plc` (workspace) — types and genesis utilities
- `@ipld/dag-cbor` (npm) — CBOR encoding
- `multiformats` (npm) — base32 encoding for CIDs
