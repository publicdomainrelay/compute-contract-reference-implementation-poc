# did-plc-directory

Local [did:plc](https://web.plc.directory/spec/v0.1/did-plc) Directory Server.

Runs a standalone PLC directory that accepts and validates did:plc operations,
resolves DID documents, and exposes the standard REST API. In-memory storage
by default — suitable for local dev/testing.

## Quick start

```sh
PORT=2583 deno run -A main.ts
```

```sh
# Health check
curl http://localhost:2583/health

# Post a genesis operation
curl -X POST http://localhost:2583/did:plc:mynewdid \
  -H "Content-Type: application/json" \
  -d '{"type":"plc_operation","rotationKeys":[...],"verificationMethods":{...},"alsoKnownAs":[],"services":{},"prev":null,"sig":"..."}'

# Resolve DID document
curl http://localhost:2583/did:plc:mynewdid
```

## Config

| Env | Default | Description |
|-----|---------|-------------|
| `PORT` | `2583` | HTTP listen port |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server version |
| `GET` | `/{did}` | Resolve DID document |
| `GET` | `/{did}/log` | Current operation chain |
| `GET` | `/{did}/log/audit` | Full audit log (incl. nullified forks) |
| `POST` | `/{did}` | Submit signed PLC operation |
| `GET` | `/export` | Paginated bulk export |

## Dependencies

- `@publicdomainrelay/hono-factory-did-plc-directory` — factory library
- `@hono/hono` (jsr) — HTTP framework
