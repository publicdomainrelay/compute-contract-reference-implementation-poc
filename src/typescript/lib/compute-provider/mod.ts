// Compute provider abstraction — the provisioning counterpart to market-settlement.
//
// The core market protocol is provisioning-agnostic: a market.accept just carries
// opaque strongRefs. A `ComputeProvider` binds the accept to a concrete backend —
// local Docker/QEMU containers or real DigitalOcean droplets. Both satisfy the
// same interface, so the bidder provisioning logic is identical no matter which
// is wired in.
//
// The bidder selects one at startup (see computeProviderModeFromEnv) and never
// branches on the mode again.

import type { Logger } from "@publicdomainrelay/utils-log";

// ── shared types ────────────────────────────────────────────────────────

export type StrongRef = { $type: "com.atproto.repo.strongRef"; uri: string; cid: string };

/** VM spec from the marketplace RFP payload — provider-agnostic. */
export type VM = {
  cpus: number;
  mem: string;
  disk: string;
  network: string;
  role: string;
  user_data: string;
  location?: { country?: string; region?: string };
  _uri?: string;
  _cid?: string;
};

/** Per-provision overrides (region, size, image). Falls back to env vars. */
export interface DropletSpec {
  region?: string;
  size?: string;
  image?: string;
}

export interface ProvisionResult {
  /** Provider-specific identifier (Docker container ID, DO droplet ID, etc.). */
  providerId: string | number;
  /** Provider-specific response metadata. */
  metadata: Record<string, unknown>;
}

// ── context & interface ─────────────────────────────────────────────────

/** Cross-cutting deps every compute provider is built from. */
export interface ComputeProviderCtx {
  log: Logger;
  parseAtUri: (uri: string) => { repo: string; collection: string; rkey: string };
}

/**
 * A pluggable way to provision compute (the "provision on accept" side).
 *
 * Implementations:
 *   - `compute-provider-local`  — Docker/QEMU containers on this host
 *   - `compute-provider-digitalocean` — real DigitalOcean droplets via API
 */
export interface ComputeProvider {
  /** Human-readable label for logs / startup banner. */
  readonly name: string;

  /** Provision a compute instance. Returns the provider-specific ID. */
  provision(
    vm: VM,
    requesterDid: string,
    spec?: DropletSpec,
  ): Promise<ProvisionResult>;

  /** Destroy a compute instance by its provider-specific ID. */
  destroy(id: string | number): Promise<void>;

  /** Create the bid-config record embedded in the bid (NSID varies by provider). */
  createBidConfig(nowIso: string): Promise<StrongRef>;

  /** Inject the accept provenance bundle into cloud-init user_data. */
  injectAcceptBundle(
    userData: string,
    bundle: Record<string, unknown>,
  ): string;

  /** One-time setup before first provision. No-op for providers that don't need it. */
  setup?(): Promise<void>;

  /** Clean up artifacts after teardown. No-op for providers that don't need it. */
  teardown?(): Promise<void>;
}

// ── mode selection ──────────────────────────────────────────────────────

export type ComputeProviderMode = "local" | "digitalocean";

/**
 * Pick the compute provider from env or CLI flag.
 *
 *   COMPUTE_PROVIDER=local|digitalocean
 *   --provider local|digitalocean (CLI sets COMPUTE_PROVIDER_CLI before import)
 *
 * Defaults to "local".
 */
export function computeProviderModeFromEnv(): ComputeProviderMode {
  const env = Deno.env.get("COMPUTE_PROVIDER")?.toLowerCase();
  if (env === "local" || env === "digitalocean") return env;
  const cli = Deno.env.get("COMPUTE_PROVIDER_CLI")?.toLowerCase();
  if (cli === "local" || cli === "digitalocean") return cli;
  return "local";
}

// ── env var helpers ─────────────────────────────────────────────────────

/** Read a required env var, exiting with a message if unset. */
export function reqEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`env var ${name} is required`);
    Deno.exit(1);
  }
  return v;
}

/** Read an optional URL env var, stripping trailing slashes. */
export function optUrl(name: string, fallback: string): string {
  const v = Deno.env.get(name);
  return (v ?? fallback).replace(/\/+$/, "");
}

/** Read the droplet spec from env vars with defaults. */
export function dropletSpecFromEnv(): DropletSpec {
  return {
    region: Deno.env.get("COMPUTE_PROVIDER_REGION") ?? "sfo3",
    size: Deno.env.get("COMPUTE_PROVIDER_SIZE") ?? "s-1vcpu-512mb-10gb",
    image: Deno.env.get("COMPUTE_PROVIDER_IMAGE") ?? "ubuntu",
  };
}
