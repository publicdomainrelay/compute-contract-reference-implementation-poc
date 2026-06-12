#!/usr/bin/env -S deno run --allow-env --allow-run --allow-net --allow-sys --allow-read
// Read qemu compute-provider logs out of OpenSearch (reusing the connection +
// search helpers from ./opensearch-logs.ts) and emit a YAML report of VM
// lifecycle, grouped by the DID the VM was created on behalf of.
//
// For each DID we resolve its atproto handle (via the shared idResolver from
// @publicdomainrelay/atproto-helpers) and list every VM it created — or tried
// to create — with the VM name and how long it lived (or "alive" if running).
//
//   usage:
//     ./vm-lifecycle.ts [--since 30d] [--size 2000] [--index droplet-logs]
//
// Connection resolution is identical to opensearch-logs.ts (OPENSEARCH_* env,
// DB_CLUSTER, or sole-cluster auto-pick via doctl).
//
// Lifecycle correlation:
//   - create   : qemu msg "droplets.create → local VM"  (has name, onBehalfOfDid)
//   - assigned : qemu msg "container IP assigned"        (has droplet_id) — links
//                the create to the runtime droplet_id used by the delete request.
//   - delete   : qemu msg "request" method DELETE path /v2/droplets/<id>
// A create with no matching "container IP assigned" is reported as an attempt
// that never came up.

import { parseArgs } from "jsr:@std/cli/parse-args";
import { buildQuery, getConn, search } from "./opensearch-logs.ts";
import { idResolver } from "@publicdomainrelay/atproto-helpers";

interface Hit {
  _source: Record<string, unknown> & {
    "@timestamp"?: string;
    message?: string;
    MESSAGE?: string;
  };
}

interface QemuEvent {
  ts: string;
  msg?: string;
  service?: string;
  name?: string;
  onBehalfOfDid?: string;
  actorDid?: string;
  droplet_id?: string;
  method?: string;
  path?: string;
  [k: string]: unknown;
}

// A single VM's lifecycle, owned by onBehalfOfDid.
interface VM {
  name: string;
  ownerDid: string;
  actorDid?: string; // the actor that issued the create on the owner's behalf
  createdAt: string;
  dropletId?: string; // runtime id from "container IP assigned"
  deletedAt?: string;
  cameUp: boolean; // did it reach "container IP assigned"
}

function parseEvents(hits: Hit[]): QemuEvent[] {
  const out: QemuEvent[] = [];
  for (const h of hits) {
    const raw = h._source.message ?? h._source.MESSAGE;
    if (!raw) continue;
    let j: QemuEvent;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!j.msg) continue;
    if (!j.ts) j.ts = h._source["@timestamp"] ?? "";
    out.push(j);
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

// Correlate creates -> IP-assigned -> deletes into VM records.
function buildVMs(events: QemuEvent[]): VM[] {
  const creates = events.filter((e) => e.msg === "droplets.create → local VM");
  const assigns = events.filter((e) => e.msg === "container IP assigned");
  const deletes = events.filter(
    (e) => e.msg === "request" && e.method === "DELETE" &&
      typeof e.path === "string" && e.path.startsWith("/v2/droplets/"),
  );

  const usedAssign = new Set<number>();
  const usedDelete = new Set<number>();
  const vms: VM[] = [];

  for (const c of creates) {
    const vm: VM = {
      name: c.name ?? "(unknown)",
      ownerDid: c.onBehalfOfDid ?? "(unknown)",
      actorDid: c.actorDid,
      createdAt: c.ts,
      cameUp: false,
    };
    // Earliest unused "container IP assigned" at/after this create for the
    // same owner -> the droplet_id this VM runs as.
    let bestA = -1;
    for (let i = 0; i < assigns.length; i++) {
      if (usedAssign.has(i)) continue;
      const a = assigns[i];
      if (a.ts < c.ts) continue;
      if (a.onBehalfOfDid && c.onBehalfOfDid && a.onBehalfOfDid !== c.onBehalfOfDid) continue;
      if (bestA === -1 || a.ts < assigns[bestA].ts) bestA = i;
    }
    if (bestA !== -1) {
      usedAssign.add(bestA);
      vm.cameUp = true;
      vm.dropletId = assigns[bestA].droplet_id as string | undefined;
      // Earliest unused DELETE of that droplet_id at/after create.
      if (vm.dropletId) {
        let bestD = -1;
        for (let i = 0; i < deletes.length; i++) {
          if (usedDelete.has(i)) continue;
          const d = deletes[i];
          if (d.ts < c.ts) continue;
          if (!(d.path as string).endsWith("/" + vm.dropletId)) continue;
          if (bestD === -1 || d.ts < deletes[bestD].ts) bestD = i;
        }
        if (bestD !== -1) {
          usedDelete.add(bestD);
          vm.deletedAt = deletes[bestD].ts;
        }
      }
    }
    vms.push(vm);
  }
  return vms;
}

function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.join("");
}

// did:plc:xxx | bare "xxx" | "handle.bsky.social" -> handle (best effort).
const handleCache = new Map<string, string>();
async function resolveHandle(did: string): Promise<string> {
  if (handleCache.has(did)) return handleCache.get(did)!;
  let handle = "(unresolved)";
  try {
    if (!did.startsWith("did:")) {
      // Already a handle, or a bare plc id. Treat dotted values as handles.
      if (did.includes(".")) {
        handleCache.set(did, did);
        return did;
      }
      const full = `did:plc:${did}`;
      const doc = await idResolver.did.resolve(full);
      handle = akaHandle(doc) ?? "(unresolved)";
    } else {
      const doc = await idResolver.did.resolve(did);
      handle = akaHandle(doc) ?? "(unresolved)";
    }
  } catch {
    handle = "(unresolved)";
  }
  handleCache.set(did, handle);
  return handle;
}

function akaHandle(doc: unknown): string | undefined {
  const aka = (doc as { alsoKnownAs?: string[] } | null)?.alsoKnownAs;
  if (!aka || !aka.length) return undefined;
  return aka[0].replace(/^at:\/\//, "");
}

function yamlStr(s: string): string {
  // Quote when needed; these strings are simple but names contain no specials.
  return /[:#\-?{}\[\],&*!|>'"%@`]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

async function main() {
  const flags = parseArgs(Deno.args, {
    string: ["since", "size", "index"],
    default: {
      since: "30d",
      size: "2000",
      index: Deno.env.get("OPENSEARCH_INDEX") ?? "droplet-logs",
    },
  });

  const conn = await getConn(false);
  const body = buildQuery({
    query: "*qemu*",
    since: flags.since,
    size: Number(flags.size),
  });
  const res = await search(conn, flags.index, body, "https");
  const hits: Hit[] = res.hits?.hits ?? [];

  const events = parseEvents(hits);
  const vms = buildVMs(events);

  const now = Date.now();

  // Group by owner DID.
  const byDid = new Map<string, VM[]>();
  for (const vm of vms) {
    if (!byDid.has(vm.ownerDid)) byDid.set(vm.ownerDid, []);
    byDid.get(vm.ownerDid)!.push(vm);
  }

  // Resolve handles in parallel.
  const dids = [...byDid.keys()];
  const handles = new Map<string, string>();
  await Promise.all(
    dids.map(async (d) => handles.set(d, d === "(unknown)" ? "(unknown)" : await resolveHandle(d))),
  );

  // Emit YAML.
  const lines: string[] = [];
  lines.push(`# qemu VM lifecycle report`);
  lines.push(`window: ${yamlStr("now-" + flags.since)}`);
  lines.push(`generated: ${new Date(now).toISOString()}`);
  lines.push(`total_vms: ${vms.length}`);
  lines.push(`dids:`);
  for (const did of dids.sort()) {
    const list = byDid.get(did)!.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    lines.push(`  - did: ${yamlStr(did)}`);
    lines.push(`    handle: ${yamlStr(handles.get(did) ?? "(unresolved)")}`);
    lines.push(`    vm_count: ${list.length}`);
    lines.push(`    vms:`);
    for (const vm of list) {
      const created = Date.parse(vm.createdAt);
      let status: string;
      let alive: string;
      if (!vm.cameUp) {
        status = "attempted";
        alive = "n/a (never came up)";
      } else if (vm.deletedAt) {
        status = "deleted";
        alive = humanDuration(Date.parse(vm.deletedAt) - created);
      } else {
        status = "alive";
        alive = humanDuration(now - created) + " (still alive)";
      }
      lines.push(`      - name: ${yamlStr(vm.name)}`);
      lines.push(`        status: ${status}`);
      lines.push(`        created_at: ${yamlStr(vm.createdAt)}`);
      if (vm.dropletId) lines.push(`        droplet_id: ${yamlStr(vm.dropletId)}`);
      if (vm.deletedAt) lines.push(`        deleted_at: ${yamlStr(vm.deletedAt)}`);
      if (vm.actorDid) lines.push(`        created_by_actor: ${yamlStr(vm.actorDid)}`);
      lines.push(`        alive_for: ${yamlStr(alive)}`);
    }
  }
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  });
}
