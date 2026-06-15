# Datastore Abstraction

Pluggable storage backends behind a common `PackageStore` interface, with three implementations (PDS, local FS, remote git) that are interchangeable at runtime.

## Where used

- `lib/datastore-package/mod.ts` — `PackageStore` interface + `PackageEntry`/`PackageVersion` types
- `lib/datastore-pds/mod.ts` — `createPdsStore()` — AT Protocol PDS-backed store
- `lib/datastore-local-fs/mod.ts` — `createLocalFsStore()` — filesystem-backed store
- `lib/datastore-remote-git/mod.ts` — `createRemoteGitStore()` — git repository-backed store
- `ephemeral-package-registry/main.ts` — consumer, switches store at runtime

## Interface

```ts
// lib/datastore-package/mod.ts (conceptual)
interface PackageStore {
  list(): Promise<PackageEntry[]>;
  get(name: string, version?: string): Promise<PackageVersion>;
}

interface PackageEntry {
  name: string;
  versions: string[];
  description?: string;
}

interface PackageVersion {
  name: string;
  version: string;
  files: Record<string, Uint8Array>;  // path → content
  metadata?: Record<string, unknown>;
}
```

## Runtime backend selection

```ts
// ephemeral-package-registry/main.ts
let store: PackageStore;

if (STORE_MODE === "git") {
  store = createRemoteGitStore({ url: gitUrl });
} else if (STORE_MODE === "local") {
  store = createLocalFsStore({ baseDir });
} else {
  store = createPdsStore({ api, repoDid: did });
}
// store used identically regardless of backend
```

Selection via `--store` CLI flag or `PACKAGE_REGISTRY_STORE` env var (env cascade pattern from cliffy-cli).

## Backend implementations

### PDS store (`datastore-pds`)

Stores packages as AT Protocol records on the service's own PDS repo:
- Package listing stored as repo records
- Deterministic rkey derivation from name/version for idempotent writes
- Uses `createRepoFactory` for AT Protocol API access

### Local FS store (`datastore-local-fs`)

Directory layout: `$baseDir/<package>/<version>/<files...>`
- `@scope/name` packages stored as `$baseDir/@scope/name/version/`
- `walkDir()` recursively builds files map
- Zero network dependency

### Remote Git store (`datastore-remote-git`)

Monorepo-aware git backend:
- Bare clone with incremental fetch
- Package discovery: scans `deno.json` files per tag
- Semver tag parsing: `v?major.minor.patch`
- Branch-as-version: `0.1.0-<branchname>` pseudo-semver
- Fallback mode: whole repo as single package when no `deno.json` subpackages
- `resolveRef()` handles SHA, branch, and tag resolution

## Key design decisions

1. **Interface-first** — all backends implement same `PackageStore`. Consumer code never branches on backend type after initialization.

2. **Factory functions** — each backend has a `createXxxStore(opts)` factory, not a class constructor. Follows the overall hono-factory convention.

3. **Uint8Array files** — file contents are raw bytes, not strings. Caller decides encoding.

4. **Version resolution** — `get(name, version?)` returns latest if version omitted.

## When to use

- Need swappable storage backends for the same data model
- Development: local FS for speed, production: PDS for persistence
- Testing: inject a stub `PackageStore` to avoid network

## Don't use for

- Relational data with joins across entities
- Write-heavy workloads with concurrent writers (PDS store has no locking)
- Large files (>10MB — AT Protocol records have size limits)
