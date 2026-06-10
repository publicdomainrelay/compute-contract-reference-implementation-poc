# ADR 0005 — Replace ad-hoc in-memory + JSON-file state with a store interface

**Status:** Proposed · **Relates to:** THREATS T6 · operational correctness

## Context

Critical state is held in module-level `Map`s, some mirrored to JSON files written
on every mutation:

- `spindle/main.ts`: `runs`, `runWaiters`, `preRunLogs`, `secretsStore`,
  `subscribers`, `eventLog`, plus `spindle-db.json` / `spindle-logs-db.json` /
  `spindle-events-db.json` written via `Deno.writeTextFileSync` (whole-file rewrite,
  no locking).
- `bidder/main.ts`: `activeContracts` (receipt → droplet/rbac) — **in-memory only**.

Consequences observed in code:

- `activeContracts` is lost on bidder restart, so a `vm.delete` after a restart hits
  "unknown receipt" and the droplet + its RBAC grant **leak** (real money / standing
  authorization). The teardown path silently can't run.
- The JSON files are full-rewrite-per-write with no atomic-rename or locking; a
  crash mid-write corrupts them (the loaders swallow the error and start empty,
  silently dropping run/cursor/event history).
- `secretsStore` is plaintext in memory with no eviction and (today) no reader.
- These files are the ones T6 had to `.gitignore` because they can contain
  short-lived signed material and run state.

## Proposal

Define a small async `Store` interface (get/set/delete/list, namespaced) and back
it with one implementation (SQLite is already a dependency in `qemu/database.ts`,
which does this correctly with parameterized statements). Move `runs`, `secrets`,
`events`, and especially the bidder's `activeContracts` behind it.

- Persist `activeContracts` so teardown survives restarts (stops droplet/RBAC
  leaks).
- Atomic writes (temp file + rename) or a real DB; surface load failures instead of
  silently resetting.
- Keep the in-memory `Map` as a write-through cache if the latency matters.

## Consequences

- (+) Provisioned resources are reliably reclaimable; no silent history loss; one
  place to reason about durability and concurrency.
- (+) Aligns the spindle/bidder with the pattern qemu already uses.
- (−) Introduces a storage dependency for services that are currently file-only;
  migration of existing JSON state needed (one-time loader).
