// The bidder's settlement abstraction.
//
// The core market protocol is settlement-agnostic: a market.accept carries an
// opaque `payload` strongRef and submitAccept doesn't care what it is. A
// `Settlement` binds that contract to a concrete mechanism — paying via x402
// (./bids_x402.ts) or granting for free (./bids_free.ts). Both mint a
// bidder-authored receipt that the accept payload references, so the
// provisioning logic in main.ts is identical no matter which is wired in.
//
// main.ts selects one at startup (see settlementModeFromEnv) and never branches
// on the mode again.

import type { Agent } from "@atproto/api";
import type { Logger, RecordResolver, StrongRef } from "@publicdomainrelay/market";
import type { MarketBidsFactoryOptions } from "@publicdomainrelay/hono-factory-market-bids";

/** Cross-cutting deps every settlement implementation is built from. */
export interface SettlementCtx {
  /** Bidder's authenticated agent — a getter, since login resolves after wiring. */
  getAgent: () => Agent;
  /** Shared record resolver (the same one injected into the market handlers). */
  resolve: RecordResolver;
  log: Logger;
  /** Bidder's public base URL (its did:web origin); may be empty in dev. */
  baseUrl: string;
}

/** A pluggable way to settle a market.accept (the bid payload + receipt flow). */
export interface Settlement {
  /** Human-readable label for logs / startup banner. */
  readonly mode: SettlementMode;
  /** NSID of the bid payload record this layer mints (bids.x402 / bids.free). */
  readonly bidPayloadNsid: string;
  /**
   * The receipt-endpoint URL advertised in the bid payload and GET-ed by the
   * buyer to obtain its receipt. Prefers the configured baseUrl, falling back to
   * the inbound request origin.
   */
  receiptUrl(reqUrl: string): string;
  /** Mint the bid payload record (bids.x402 / bids.free) advertising `receiptUrl`. */
  createBidPayload(receiptUrl: string, nowIso: string): Promise<StrongRef>;
  /** Options to pass to createMarketBidsFactory() to mount receipt endpoints. */
  bidsFactoryOptions(): MarketBidsFactoryOptions;
  /**
   * Verify a market.accept's payload is a receipt this bidder issued, before
   * provisioning. Throws (with an HTTP `status`) on any failure.
   */
  verifyAcceptPayload(payment: StrongRef | undefined): Promise<void>;
}

export type SettlementMode = "x402" | "free";

/**
 * Pick the settlement mode from env: `SETTLEMENT=free|x402`. `X402_MAKE_FREE=1`
 * is honored as a back-compat alias for `free`. Defaults to `x402`.
 */
export function settlementModeFromEnv(): SettlementMode {
  const explicit = Deno.env.get("SETTLEMENT")?.toLowerCase();
  if (explicit === "free" || explicit === "x402") return explicit;
  if (Deno.env.has("X402_MAKE_FREE")) return "free";
  return "x402";
}

/** Helper for `receiptUrl`: `<baseUrl|reqOrigin>/<path>`. */
export function receiptUrlFor(baseUrl: string, reqUrl: string, path: string): string {
  const base = baseUrl || new URL(reqUrl).origin;
  return `${base.replace(/\/+$/, "")}/${path}`;
}
