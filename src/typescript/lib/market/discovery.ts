// Shared bidder discovery: merges registry-based and vouch-based discovery.
//
// Consumers (spindle, xrpc-relay-pds) call `discoverBiddersFromRegistries()`
// alongside their existing vouch discovery, then pass all DIDs through the
// same offering lookup + submitRfp pipeline.
//
// Two paths into the same function:
//   - Pass `marketClient` (spindle) — uses PDS service-proxying via the Agent.
//   - Pass `callListBidders` (xrpc-relay-pds) — signs a service-auth JWT and
//     calls the registry directly via fetch.

import { LIST_BIDDERS_NSID } from "@publicdomainrelay/lexicons";
import type { MarketClient } from "./client.ts";
import { noopLogger, type Logger } from "./types.ts";

// ── default registries ─────────────────────────────────────────────────

/**
 * Default registry endpoints consulted when the caller doesn't supply
 * explicit registries. These are stable did:web refs (fedproxy tunnel URLs).
 */
export const DEFAULT_REGISTRY_ENDPOINTS: string[] = [
  "did:web:market-registry--johnandersen777-bsky-social.fedproxy.com#pdr_temp_market",
];

/** Env var name for overriding the default registry list (comma-separated). */
export const REGISTRY_ENDPOINTS_ENV = "REGISTRY_ENDPOINTS";

// ── types ──────────────────────────────────────────────────────────────

export interface RegistryBidder {
  /** DID of the registered bidder. */
  bidderDid: string;
  /** Payload NSIDs the bidder declared it handles. */
  appliesTo: string[];
}

/**
 * Low-level callback signature for callers that don't have a MarketClient.
 * Given a resolved endpoint URL and payload NSID, return the list of bidders.
 *
 * Implementations typically resolve a DID ref to an HTTP base URL, sign a
 * service-auth JWT for `lxm=LIST_BIDDERS_NSID`, then GET the registry's
 * listBidders endpoint.
 */
export type CallListBidders = (
  endpointUrl: string,
  payloadNsid: string,
) => Promise<RegistryBidder[]>;

export interface DiscoverFromRegistriesOptions {
  /** Filter registries to bidders that handle this payload NSID. */
  payloadNsid: string;
  /**
   * Registry endpoints to query. Each entry is a service DID ref
   * (e.g. `did:web:HOST#pdr_temp_market`) or a raw URL. When omitted,
   * reads the {@link REGISTRY_ENDPOINTS_ENV} env var (comma-separated list)
   * falling back to {@link DEFAULT_REGISTRY_ENDPOINTS}.
   */
  registryEndpoints?: string[];
  /** Optional structured logger. */
  log?: Logger;
  /**
   * MarketClient wired to the caller's PDS agent — used for PDS-proxied
   * registry queries (the spindle path). Mutually exclusive with
   * `callListBidders`.
   */
  marketClient?: MarketClient;
  /**
   * Raw call function for direct registry queries (the xrpc-relay-pds path).
   * Mutually exclusive with `marketClient`.
   */
  callListBidders?: CallListBidders;
}

// ── helpers ────────────────────────────────────────────────────────────

function parseEnvList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── public API ─────────────────────────────────────────────────────────

/**
 * Query every configured registry for bidders that handle `payloadNsid`.
 * Returns a deduplicated set of bidder DIDs suitable for feeding into the
 * existing offering-lookup + submitRfp pipeline.
 *
 * Merges results from all configured registries; a single failing registry
 * is logged and skipped — it never causes the whole call to throw.
 */
export async function discoverBiddersFromRegistries(
  opts: DiscoverFromRegistriesOptions,
): Promise<Set<string>> {
  const log = opts.log ?? noopLogger;
  const endpoints =
    opts.registryEndpoints ??
    parseEnvList(Deno.env.get(REGISTRY_ENDPOINTS_ENV) ?? "");
  const effectiveEndpoints =
    endpoints.length > 0 ? endpoints : DEFAULT_REGISTRY_ENDPOINTS;

  if (effectiveEndpoints.length === 0) {
    log("info", "registry discovery: no endpoints configured");
    return new Set();
  }

  const dids = new Set<string>();

  await Promise.all(
    effectiveEndpoints.map(async (endpoint) => {
      try {
        log("info", "registry discovery: querying", { endpoint, payloadNsid: opts.payloadNsid });

        let bidders: RegistryBidder[];

        if (opts.marketClient) {
          // Spindle path: PDS service-proxying via MarketClient.
          const res = await opts.marketClient.listBidders(endpoint, {
            payloadNsid: opts.payloadNsid,
          });
          bidders = res.bidders.map((b) => ({
            bidderDid: b.bidderDid ?? (b as unknown as { did: string }).did ?? "",
            appliesTo: b.appliesTo ?? [],
          }));
        } else if (opts.callListBidders) {
          // xrpc-relay-pds path: direct service-auth fetch.
          bidders = await opts.callListBidders(endpoint, opts.payloadNsid);
        } else {
          log("warn", "registry discovery: no call mechanism configured", { endpoint });
          return;
        }

        for (const b of bidders) {
          if (b.bidderDid) dids.add(b.bidderDid);
        }
        log("info", "registry discovery: result", { endpoint, count: bidders.length });
      } catch (err) {
        log("warn", "registry discovery: query failed", { endpoint, err: String(err) });
      }
    }),
  );

  log("info", "registry discovery: total unique bidders", { count: dids.size });
  return dids;
}
