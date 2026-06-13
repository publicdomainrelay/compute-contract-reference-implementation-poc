// Inter-service auth verification for market receiver endpoints.
//
// Every submit* procedure is meant to be called via PDS service-proxying
// (the atproto-proxy header), which means the receiver gets an inter-service
// auth JWT minted by the caller's PDS. We verify that token's signature, `lxm`,
// and expiry, then assert its `aud` matches this service (bare DID or one of
// the configured `did:web:HOST#<service-id>` refs). The DID key lookup is done
// through the injected IdResolver, so callers share one identity layer.

import { verifyJwt } from "@atproto/xrpc-server";
import type { IdResolver } from "@atproto/identity";

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function extractBearer(header: string | undefined | null): string {
  const m = /^Bearer (.+)$/.exec((header ?? "").trim());
  if (!m) throw new Error("missing or malformed Authorization Bearer header");
  return m[1];
}

/** The bidder's own service DID, derived from its public hostname. */
export function serviceDidForHost(hostname: string): string {
  return `did:web:${hostname}`;
}

export type ServiceAuthResult = {
  /** Issuer DID (authority portion, fragment stripped). */
  issuerDid: string;
  /** The exact `aud` value the token carried. */
  audience: string;
  /**
   * Which configured service-id fragment the `aud` matched, or `undefined` when
   * the token targeted the bare service DID (no fragment).
   */
  serviceId?: string;
};

export type VerifyMarketServiceAuthOptions = {
  /** Raw value of the inbound Authorization header. */
  authHeader: string | undefined | null;
  /** This service's public hostname (the host of its did:web). */
  hostname: string;
  /** Expected `lxm` (lexicon method) the token must be scoped to. */
  lxm: string;
  /** Service-id fragments this endpoint will accept in the token `aud`. */
  serviceIds: string[];
  /**
   * Extra DIDs (beyond the host-derived `did:web:HOST`) this endpoint answers
   * for. Use when the service is reachable under a second identity — e.g. a
   * relay whose service is advertised in the RFP as a `did:plc#service` ref, so
   * a caller's PDS proxies to that did:plc and mints `aud: did:plc` (or
   * `did:plc#serviceId`), which would never match the bare did:web. Each entry
   * is accepted bare and with every configured `#serviceId` fragment.
   */
  extraAudienceDids?: string[];
  /** Identity resolver used to fetch the issuer's signing key. */
  idResolver: IdResolver;
};

/**
 * Verify an inter-service auth JWT for a market receiver endpoint.
 *
 * Follows the reference bidder's pattern: pass `null` as `ownDid` so
 * {@link verifyJwt} checks signature + lxm + expiry only, then assert `aud` by
 * hand to tolerate both the bare service DID and any of the configured service
 * refs. Returns the issuer DID and which service-id (if any) the `aud` matched,
 * so callers can route by service.
 *
 * @throws if the token is missing/malformed, fails verification, has an
 *   unexpected `aud`, or carries no DID issuer.
 */
export async function verifyMarketServiceAuth(
  opts: VerifyMarketServiceAuthOptions,
): Promise<ServiceAuthResult> {
  const { authHeader, hostname, lxm, serviceIds, extraAudienceDids, idResolver } = opts;
  const token = extractBearer(authHeader);
  const serviceDid = serviceDidForHost(hostname);

  const payload = await verifyJwt(token, null, lxm, (did: string) => idResolver.did.resolveAtprotoKey(did));

  // Acceptable audiences: the bare service DID, plus one ref per service id —
  // and the same matrix for every extra DID this endpoint also answers for.
  const acceptable = new Map<string, string | undefined>();
  for (const did of [serviceDid, ...(extraAudienceDids ?? [])]) {
    acceptable.set(did, undefined);
    for (const id of serviceIds) acceptable.set(`${did}#${id}`, id);
  }

  const aud = (payload as Record<string, unknown>).aud as string | undefined;
  if (aud === undefined || !acceptable.has(aud)) {
    throw new Error(`unexpected audience ${aud ?? "(none)"}; expected ${[...acceptable.keys()].join(" or ")}`);
  }

  const iss = (payload as Record<string, unknown>).iss as string | undefined;
  if (!iss || !iss.startsWith("did:")) throw new Error("service auth token missing DID issuer");

  return { issuerDid: iss.split("#")[0], audience: aud, serviceId: acceptable.get(aud) };
}

// The verification above is not actually market-specific — it takes the `lxm`
// and the accepted `serviceIds` as arguments, so it works for ANY atproto
// inter-service-auth (PDS service-proxying) endpoint. The spindle, for example,
// reuses it for its `…tangled.spindle.trigger` endpoint. These generic aliases
// say so at the call site without forcing a market vocabulary on unrelated code.
export type VerifyServiceAuthOptions = VerifyMarketServiceAuthOptions;

/**
 * Verify an atproto inter-service auth JWT for a PDS-service-proxied endpoint.
 * Generic alias for {@link verifyMarketServiceAuth}; see that function for the
 * full contract. Returns the issuer DID (fragment stripped) and which configured
 * service-id the token's `aud` matched (if any).
 */
export const verifyServiceAuth = verifyMarketServiceAuth;
