// ---------------------------------------------------------------------------
// atproto client + identity resolver
// ---------------------------------------------------------------------------

import { Agent, CredentialSession } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { getPdsEndpoint } from "@atproto/common-web";
import { createMarketClient, type MarketClient } from "@publicdomainrelay/market";

export const idResolver = new IdResolver();
export let agent: Agent;
export let agentDid = "";
export let session: CredentialSession;
// Client wrapper for the outbound market submit* calls (built on the
// authenticated session in loginAgent). See ../lib/market.
export let marketClient: MarketClient;

export function ownServiceDidWeb(base_url: string): string {
  return `did:web:${new URL(base_url).host}`;
}

// The authority (repo DID) portion of an at:// URI. Inter-service auth for the
// market endpoints (token issuer must author the referenced record, audience
// checks, etc.) now lives in ../lib/market; this stays for the local
// payload-author checks below.
export function atUriAuthority(uri: string): string {
  return uri.replace("at://", "").split("/")[0];
}

export async function loginAgent(handle: string, password: string): Promise<void> {
  let did = handle;
  if (!did.startsWith("did:")) {
    const resolved = await idResolver.handle.resolve(handle);
    if (!resolved) throw new Error(`could not resolve handle ${handle}`);
    did = resolved;
  }
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`could not resolve did ${did}`);
  const pds = getPdsEndpoint(doc);
  if (!pds) throw new Error(`no pds for ${did}`);
  session = new CredentialSession(new URL(pds));
  await session.login({ identifier: handle, password });
  agent = new Agent(session);
  agentDid = session.did ?? did;
  // agent cannot register custom NSIDs, so the market client wraps a dedicated
  // XrpcClient on the same authenticated session for the proxied submit* calls.
  marketClient = createMarketClient(session);
  console.error(`[atproto] logged in as ${agentDid}`);
}

export function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const parts = uri.slice("at://".length).split("/");
  return { repo: parts[0], collection: parts[1], rkey: parts[2] };
}

export async function pdsForDid(did: string): Promise<string> {
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`could not resolve ${did}`);
  const pds = getPdsEndpoint(doc);
  if (!pds) throw new Error(`no pds for ${did}`);
  return pds;
}

export async function getRecord(atUri: string, cid: string): Promise<{ uri: string; cid: string; value: Record<string, unknown> }> {
  const { repo, collection, rkey } = parseAtUri(atUri);
  const pds = await pdsForDid(repo);
  const read = new Agent(new URL(pds));
  const res = await read.com.atproto.repo.getRecord({ repo, collection, rkey, cid });
  return { uri: res.data.uri, cid: res.data.cid ?? cid, value: res.data.value as Record<string, unknown> };
}

export async function resolveAs<T>(atUri: string, cid: string): Promise<T & { _uri: string; _cid: string }> {
  const r = await getRecord(atUri, cid);
  const value = r.value as Record<string, unknown>;
  const version = (value.version as string | undefined) ?? "0.0.0";
  if (version !== "0.0.0") {
    throw new Error(`unknown record version ${version}`);
  }
  return { ...(value as unknown as T), _uri: atUri, _cid: r.cid };
}
