#!/usr/bin/env -S deno run -A
// allow-access.ts — CLI to grant a DID access via
// com.publicdomainrelay.temp.auth.allowlist.rbacDid
//
// Creates a com.publicdomainrelay.temp.auth.allowlist.rbacDid record in the
// operator's repo (if no record already protects the given service+scope)
// allowing the given handles (resolved to DIDs) to call
// raiseIfUnauthorizedServiceAuth-protected routes for that service+scope.
//
// Usage:
//   deno run -A allow-access.ts --service=<service> --scope=<scope> \
//     --handle=<handle> [--handle=<handle> ...]
//
// Example:
//   deno run -A allow-access.ts \
//     --service=https://mini-cloud-0001.fedfork.com --scope=account.auth \
//     --handle=alice.bsky.social --handle=bob.bsky.social
//
// Env vars:
//   ATPROTO_PDS_URL   PDS base URL (default: https://bsky.social)
//   ATPROTO_HANDLE    Operator ATProto handle
//   ATPROTO_PASSWORD  Operator ATProto password

const HELP = `allow-access.ts — grant DIDs access via ${"com.publicdomainrelay.temp.auth.allowlist.rbacDid"}

Usage:
  deno run -A allow-access.ts --service=<service> --scope=<scope> \\
    --handle=<handle> [--handle=<handle> ...]

Flags:
  --service=<service>   Service identifier the allowlist record protects
                        (e.g. --service=https://mini-cloud-0001.fedfork.com)
  --scope=<scope>       Scope the allowlist record protects (e.g. account.auth)
  --handle=<handle>     ATProto handle or DID to allow (repeatable)
  --help, -h            Show this help message

Example:
  deno run -A allow-access.ts \\
    --service=https://mini-cloud-0001.fedfork.com --scope=account.auth \\
    --handle=alice.bsky.social --handle=did:plc:abc123

Env vars:
  ATPROTO_PDS_URL   PDS base URL (default: https://bsky.social)
  ATPROTO_HANDLE    Operator ATProto handle
  ATPROTO_PASSWORD  Operator ATProto password
`;

import { Agent, CredentialSession } from "npm:@atproto/api";
import { IdResolver } from "npm:@atproto/identity";

const ALLOWLIST_NSID = "com.publicdomainrelay.temp.auth.allowlist.rbacDid";

interface ServiceAllowlistRecord {
  protects: Record<string, { service: string; scope?: string }>;
  allowed: Record<string, string[]>;
  createdAt: string;
}

function parseArgs(args: string[]): { service: string; scope: string; handles: string[] } {
  let service = "";
  let scope = "";
  const handles: string[] = [];

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      Deno.exit(0);
    }
    let m = arg.match(/^--service=(.+)$/);
    if (m) { service = m[1]; continue; }
    m = arg.match(/^--scope=(.+)$/);
    if (m) { scope = m[1]; continue; }
    m = arg.match(/^--handle=(.+)$/);
    if (m) { handles.push(m[1]); continue; }
  }

  if (!service) throw new Error("missing required --service=<service>");
  if (!scope) throw new Error("missing required --scope=<scope>");
  if (handles.length === 0) throw new Error("missing required --handle=<handle> (may be repeated)");

  return { service, scope, handles };
}

async function handlesToDids(idResolver: IdResolver, handles: string[]): Promise<string[]> {
  const dids: string[] = [];
  for (const handle of handles) {
    if (handle.startsWith("did:")) {
      dids.push(handle);
      continue;
    }
    const did = await idResolver.handle.resolve(handle);
    if (!did) throw new Error(`unable to resolve handle: ${handle}`);
    dids.push(did);
  }
  return dids;
}

async function alreadyAllowedDids(
  agent: Agent,
  repo: string,
  service: string,
  scope: string,
): Promise<Set<string>> {
  const allowed = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const res = await agent.com.atproto.repo.listRecords({
      repo,
      collection: ALLOWLIST_NSID,
      limit: 100,
      cursor,
    });
    for (const rec of res.data.records) {
      const value = rec.value as ServiceAllowlistRecord;
      let protectsThis = false;
      for (const protects of Object.values(value.protects ?? {})) {
        if (
          (protects.service === service || protects.service === "*") &&
          (protects.scope === scope || protects.scope === "*" || (!protects.scope && !scope))
        ) {
          protectsThis = true;
          break;
        }
      }
      if (!protectsThis) continue;
      for (const dids of Object.values(value.allowed ?? {})) {
        for (const did of dids) allowed.add(did);
      }
    }
    if (!res.data.cursor) break;
    cursor = res.data.cursor;
  }
  return allowed;
}

async function main() {
  const { service, scope, handles } = parseArgs(Deno.args);

  const pdsUrl = Deno.env.get("ATPROTO_PDS_URL") ?? "https://bsky.social";
  const handle = Deno.env.get("ATPROTO_HANDLE") ?? "";
  const password = Deno.env.get("ATPROTO_PASSWORD") ?? "";
  if (!handle || !password) throw new Error("ATPROTO_HANDLE and ATPROTO_PASSWORD are required");

  const session = new CredentialSession(new URL(pdsUrl));
  await session.login({ identifier: handle, password });
  const agent = new Agent(session);
  const operatorDid = agent.assertDid;

  const idResolver = new IdResolver();
  const allowedDids = await handlesToDids(idResolver, handles);

  const alreadyAllowed = await alreadyAllowedDids(agent, operatorDid, service, scope);
  if (allowedDids.every((did) => alreadyAllowed.has(did))) {
    console.log(`All of [${allowedDids.join(", ")}] are already allowed for service=${service} scope=${scope}; not creating a new record.`);
    return;
  }

  const rkey = `${service}-${scope}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const record: ServiceAllowlistRecord = {
    protects: {
      [rkey]: { service, scope },
    },
    allowed: {
      [rkey]: allowedDids,
    },
    createdAt: new Date().toISOString(),
  };

  const res = await agent.com.atproto.repo.createRecord({
    repo: operatorDid,
    collection: ALLOWLIST_NSID,
    record,
  });

  console.log(`Created ${ALLOWLIST_NSID} record ${res.data.uri} allowing [${allowedDids.join(", ")}] for service=${service} scope=${scope}`);
}

if (import.meta.main) {
  await main();
}
