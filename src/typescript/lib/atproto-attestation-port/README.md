# @atproto/attestation

Deno TypeScript bindings for AT Protocol record attestation.

Mirrors the [`atproto-attestation`](https://crates.io/crates/atproto-attestation) Rust crate v0.14.5.

## Features

- Create inline attestations (embedded signatures)
- Create remote attestations (proof records with strongRefs)
- Verify record signatures (inline + remote)
- DAG-CBOR CID generation
- ECDSA signature normalization (low-S form)
- P-256 key support via WebCrypto API

## Installation

```ts
// deno.json imports
{
  "imports": {
    "@atproto/attestation": "jsr:@atproto/attestation"
  }
}
```

## Quick Start

```ts
import {
  createInlineAttestation,
  verifyRecord,
  AnyInput,
} from "@atproto/attestation";

// Generate a P-256 key pair
const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

// Create key data
const privateKey: KeyData = {
  keyType: "P256Private",
  keyBytes: new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  ),
};

// Attest a record
const record = { $type: "app.example.post", text: "Hello ATProto!" };
const metadata = { $type: "com.example.attestation", description: "Verified" };

const signed = await createInlineAttestation(
  AnyInput.serialize(record),
  AnyInput.serialize(metadata),
  "did:plc:example",
  privateKey,
);

console.log(signed);
```

## API Reference

### Attestation Functions

- `createInlineAttestation(record, metadata, repo, key)` — Create signed record
- `createRemoteAttestation(record, metadata, repo, attestationRepo)` — Create proof record
- `createSignature(record, attestation, repo, key)` — Low-level signature creation
- `appendInlineAttestation(record, attestation, repo, resolver)` — Validate & append
- `appendRemoteAttestation(record, metadata, repo, uri)` — Validate & append proof
- `verifyRecord(record, repo, keyResolver, recordResolver)` — Full verification

### CID Functions

- `createDagCborCid(value)` — Generate DAG-CBOR CIDv1
- `createAttestationCid(record, metadata, repo)` — Generate attestation CID
- `validateDagCborCid(value, cid)` — Validate CID matches content

### Types

- `AnyInput<T>` — Flexible input (JSON string or serializable type)
- `KeyData` — AT Protocol key representation
- `KeyResolver` — DID-to-key resolution interface
- `RecordResolver` — AT-URI record resolution interface

## License

MIT
