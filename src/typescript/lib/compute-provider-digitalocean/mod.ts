// compute-provider-digitalocean — provisions real DigitalOcean droplets via
// the DO v2 REST API. Implements ComputeProvider so the bidder never branches
// on "where to provision".
//
// Auth: standard DO API token (Bearer auth). No ATProto service auth, no
// RBAC, no OIDC, no HCL policies, no git operations — just REST calls.

import { parse as yamlParse, stringify as yamlStringify } from "npm:yaml@^2.7.0";
import type {
  ComputeProvider,
  ComputeProviderCtx,
  DropletSpec,
  ProvisionResult,
  StrongRef,
  VM,
} from "@publicdomainrelay/compute-provider";
import { dropletSpecFromEnv } from "@publicdomainrelay/compute-provider";

// ── types ───────────────────────────────────────────────────────────────

export interface ComputeProviderDigitalOceanCtx extends ComputeProviderCtx {
  /** DigitalOcean API token (from DIGITALOCEAN_TOKEN env var). */
  apiToken: string;
  /** DO API base URL. Default: https://api.digitalocean.com. */
  apiBaseUrl?: string;
  /** Path inside VM where the accept bundle is written. */
  acceptPathVm?: string;
  /** Creates an atproto record in the bidder's repo (for createBidConfig). */
  createRecord: (
    collection: string,
    record: Record<string, unknown>,
  ) => Promise<StrongRef>;
}

const COMPUTE_CONFIG_WIF_SIMPLE_NSID =
  "com.publicdomainrelay.temp.compute.config.wif.simple";

const DEFAULT_API_BASE = "https://api.digitalocean.com";
const DEFAULT_ACCEPT_PATH_VM =
  "/root/secrets/publicdomainrelay.com/market/accept.json";

// ── factory ─────────────────────────────────────────────────────────────

export function createDigitalOceanComputeProvider(
  ctx: ComputeProviderDigitalOceanCtx,
): ComputeProvider {
  const { log, parseAtUri, createRecord } = ctx;
  const API_BASE = (ctx.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const API_TOKEN = ctx.apiToken;
  const ACCEPT_PATH_VM = ctx.acceptPathVm ?? DEFAULT_ACCEPT_PATH_VM;

  // ── helpers ─────────────────────────────────────────────────────────

  async function doFetch(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const url = `${API_BASE}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    let json: unknown;
    try { json = await res.json(); } catch { json = await res.text(); }
    return { status: res.status, json };
  }

  // ── provision ───────────────────────────────────────────────────────

  async function provision(
    vm: VM,
    requesterDid: string,
    spec?: DropletSpec,
  ): Promise<ProvisionResult> {
    const ds = spec ?? dropletSpecFromEnv();
    const requesterPlc = requesterDid.split(":").pop() ?? "unknown";
    const rfpRkey = (vm._uri ?? "").split("/")[4] ?? "unknown";
    const name = `${requesterPlc}-${rfpRkey}-${(vm._cid ?? "").slice(0, 8)}`;

    const body = {
      name,
      region: ds.region ?? "sfo3",
      size: ds.size ?? "s-1vcpu-512mb-10gb",
      image: ds.image ?? "ubuntu-24-04-x64",
      user_data: vm.user_data,
      with_droplet_agent: true,
      tags: [
        "pdr-contract",
        `requester:${requesterPlc}`,
        `role:${vm.role}`,
      ],
    };

    log("info", "creating droplet", { name, region: body.region, size: body.size });

    const { status, json } = await doFetch("POST", "/v2/droplets", body);

    if (status >= 400) {
      throw new Error(
        `DO /v2/droplets ${status}: ${JSON.stringify(json)}`,
      );
    }

    const droplet = (json as Record<string, unknown>)?.droplet as
      | Record<string, unknown>
      | undefined;
    const dropletId = droplet?.id as number | string | undefined;

    log("info", "droplet created", { dropletId, name, status });

    return {
      providerId: dropletId ?? 0,
      metadata: json as Record<string, unknown>,
    };
  }

  // ── destroy ─────────────────────────────────────────────────────────

  async function destroy(id: string | number): Promise<void> {
    log("info", "deleting droplet", { dropletId: id });
    const { status, json } = await doFetch("DELETE", `/v2/droplets/${id}`);
    if (status >= 400 && status !== 404) {
      log("error", "DO delete droplet failed", {
        dropletId: id,
        status,
        body: json,
      });
      return;
    }
    log("info", "droplet deleted", { dropletId: id });
  }

  // ── createBidConfig ─────────────────────────────────────────────────

  async function createBidConfig(nowIso: string): Promise<StrongRef> {
    return createRecord(COMPUTE_CONFIG_WIF_SIMPLE_NSID, {
      $type: COMPUTE_CONFIG_WIF_SIMPLE_NSID,
      provider: "digitalocean",
      api_base_url: API_BASE,
      accept_path: ACCEPT_PATH_VM,
      createdAt: nowIso,
    });
  }

  // ── injectAcceptBundle ──────────────────────────────────────────────

  function injectAcceptBundle(
    userData: string,
    bundle: Record<string, unknown>,
  ): string {
    const parent = ACCEPT_PATH_VM.split("/").slice(0, -1).join("/");

    let obj: Record<string, unknown> = {};
    try {
      const parsed = userData
        ? yamlParse(userData.replace(/^#cloud-config\s*/i, ""))
        : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through with empty obj */
    }

    const writeFiles = (obj.write_files ??= []) as Record<string, unknown>[];
    writeFiles.push({
      path: ACCEPT_PATH_VM,
      owner: "root:root",
      permissions: "0600",
      content: JSON.stringify(bundle, null, 2),
    });

    const runcmd = (obj.runcmd ??= []) as unknown[];
    runcmd.unshift([
      "sh",
      "-c",
      `install -d -m 0700 -o root -g root ${parent}`,
    ]);

    return "#cloud-config\n" + yamlStringify(obj, { lineWidth: 0 });
  }

  // ── return ──────────────────────────────────────────────────────────

  return {
    name: "digitalocean",
    provision,
    destroy,
    createBidConfig,
    injectAcceptBundle,
  };
}
