import { BIDDER_REGISTRATION_NSID, BIDDER_DISCOVERY_NSID } from "@publicdomainrelay/lexicons";
import { TID } from "@atproto/common";
import { IdResolver } from "@atproto/identity";
import { getPdsEndpoint } from "@atproto/common-web";
import { Agent } from "@atproto/api";
import type { createRepoFactory } from "@publicdomainrelay/hono-factory-atproto-repo";

export interface IndexEntry {
  bidderDid: string;
  appliesTo: string[];
  indexedAt: string;
}

export interface BidderDiscovery {
  endpointUrl: string;
  appliesTo: string[];
  updatedAt: string;
  createdAt: string;
}

export interface RegistrationStore {
  register(params: { bidderDid: string; appliesTo: string[] }): Promise<{ uri: string; cid: string }>;
  listBidders(params: { payloadNsid?: string; maxResults?: number; cursor?: string }): Promise<{ bidders: IndexEntry[]; cursor?: string }>;
  removeBidder(bidderDid: string): Promise<void>;
  getAll(): Promise<Array<IndexEntry & { uri: string; rkey: string }>>;

  /**
   * Fetch a bidder's discovery record from their PDS. Returns null if not found
   * or if the record's updatedAt is older than staleThresholdMs (default 5 min).
   */
  fetchDiscovery(bidderDid: string, staleThresholdMs?: number): Promise<BidderDiscovery | null>;
}

export function createRegistrationStore(
  api: ReturnType<typeof createRepoFactory>["api"],
  repoDid: string,
): RegistrationStore {

  function entryKey(bidderDid: string, appliesTo: string): string {
    const sanitizedDid = bidderDid.replace(/:/g, "-").toLowerCase();
    const sanitizedNsid = appliesTo.replace(/\./g, "-");
    return `${sanitizedDid}-${sanitizedNsid}`;
  }

  return {
    async register({ bidderDid, appliesTo }) {
      const rkey = entryKey(bidderDid, appliesTo[0]);
      const nowIso = new Date().toISOString();

      // Check for existing entry (re-registration)
      let exists = false;
      try {
        await api.getRecord(repoDid, BIDDER_REGISTRATION_NSID, rkey);
        exists = true;
      } catch { /* not found */ }

      const record = {
        $type: BIDDER_REGISTRATION_NSID,
        bidderDid,
        appliesTo,
        indexedAt: nowIso,
      };

      if (exists) {
        await api.applyWrites(repoDid, [
          { action: "update", collection: BIDDER_REGISTRATION_NSID, rkey, record },
        ]);
      } else {
        await api.applyWrites(repoDid, [
          { action: "create", collection: BIDDER_REGISTRATION_NSID, rkey, record },
        ]);
      }

      const rec = await api.getRecord(repoDid, BIDDER_REGISTRATION_NSID, rkey);
      return { uri: `at://${repoDid}/${BIDDER_REGISTRATION_NSID}/${rkey}`, cid: rec?.cid ?? "" };
    },

    async listBidders({ payloadNsid, maxResults = 50, cursor }) {
      const all = await api.listRecords(repoDid, BIDDER_REGISTRATION_NSID, { limit: maxResults, cursor });
      let entries = (all?.records ?? []).map(r => r.value as IndexEntry);

      if (payloadNsid) {
        entries = entries.filter(e => e.appliesTo.includes(payloadNsid));
      }

      return { bidders: entries, cursor: all?.cursor };
    },

    async removeBidder(bidderDid) {
      const all = await api.listRecords(repoDid, BIDDER_REGISTRATION_NSID, { limit: 100 });
      const matches = (all?.records ?? []).filter(r => (r.value as IndexEntry).bidderDid === bidderDid);

      if (matches.length > 0) {
        await api.applyWrites(repoDid, matches.map(r => ({
          action: "delete" as const,
          collection: BIDDER_REGISTRATION_NSID,
          rkey: r.uri.split("/").pop()!,
        })));
      }
    },

    async getAll() {
      const all = await api.listRecords(repoDid, BIDDER_REGISTRATION_NSID, { limit: 100 });
      return (all?.records ?? []).map(r => ({
        ...(r.value as IndexEntry),
        uri: r.uri,
        rkey: r.uri.split("/").pop()!,
      }));
    },

    async fetchDiscovery(bidderDid: string, staleThresholdMs = 300_000): Promise<BidderDiscovery | null> {
      const idResolver = new IdResolver();
      try {
        const doc = await idResolver.did.resolve(bidderDid);
        if (!doc) return null;
        const pds = getPdsEndpoint(doc);
        if (!pds) return null;

        const agent = new Agent(new URL(pds));
        const res = await agent.com.atproto.repo.listRecords({
          repo: bidderDid,
          collection: BIDDER_DISCOVERY_NSID,
          limit: 1,
        });

        const record = res.data.records?.[0];
        if (!record) return null;

        const discovery = record.value as unknown as BidderDiscovery;
        const ageMs = Date.now() - new Date(discovery.updatedAt).getTime();
        if (ageMs > staleThresholdMs) return null;

        return discovery;
      } catch {
        return null;
      }
    },
  };
}
