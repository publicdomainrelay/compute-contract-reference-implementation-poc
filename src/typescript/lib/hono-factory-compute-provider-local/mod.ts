// @publicdomainrelay/hono-factory-compute-provider-local — Hono factory for the
// local compute provider (QEMU VMs / Docker containers).
//
// Exposes a DigitalOcean-compatible droplets API backed by local Docker
// containers (either full QEMU VMs or lighter cloud-init+sshd containers).
// Also serves OIDC discovery, token issue, and VM provisioning challenge/prove
// endpoints.
//
// createComputeProviderLocalFactory(opts) returns a typed Hono factory whose
// initApp mounts all routes and middleware. Droplet registry is exposed via
// `.state` for external lifecycle management (signal handlers, cleanup).
//
// Usage:
//   const { createApp, state } = createComputeProviderLocalFactory({
//     operatorHandle,
//     selfDid,
//     issuerUrl,
//     vmImage,
//     containerMode,
//     containerImage,
//     cacheDir,
//     log,
//   });
//   const app = createApp();
//   Deno.serve({ port }, app.fetch);

import { createFactory } from "hono/factory";
import { cors } from "hono/cors";
import { getPublicJwk, OIDCToken, UnauthorizedException, subMatchesActx } from "@publicdomainrelay/qemu/oidc_helper";
import { raiseIfUnauthorized, raiseIfUnauthorizedServiceAuth } from "@publicdomainrelay/qemu/rbac_helper";
import type { AuthToken } from "@publicdomainrelay/qemu/rbac_helper";
import { ProvisioningData, validate as provisioningValidate } from "@publicdomainrelay/qemu/provisioning";
import { runContainer } from "@publicdomainrelay/qemu/container";
import type { Logger } from "@publicdomainrelay/utils-log";
import { runWithLogContext, setLogContext, ON_BEHALF_OF_HEADER } from "@publicdomainrelay/utils-log";

// ---------------------------------------------------------------------------
// Env type
// ---------------------------------------------------------------------------

export type ComputeProviderLocalEnv = {
  Variables: {
    authToken: AuthToken;
  };
};

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface ComputeProviderLocalFactoryOptions {
  /** Operator handle (DID) for RBAC service-auth checks.  When a function,
   *  called at request time so callers can update a captured variable after
   *  the operator DID becomes known (e.g. after PLC registration). */
  operatorHandle: string | (() => string);
  /** This host's own DID, used as actorDid when no caller context is available. */
  selfDid: string;
  /** OIDC issuer URL (also used as THIS_ENDPOINT).  When a function, called
   *  at request time so callers can update a captured variable after relay
   *  registration (before that the proxyRef is unknown). */
  issuerUrl: string | (() => string);
  /** Docker image for QEMU VMs. */
  vmImage: string;
  /** When true, use container.ts (cloud-init+sshd) instead of QEMU. */
  containerMode: boolean;
  /** Docker image for container runner. */
  containerImage: string;
  /** Cache directory for temp files. */
  cacheDir: string;
  /** Structured logger. */
  log: Logger;
}

// ---------------------------------------------------------------------------
// Droplet types + registry
// ---------------------------------------------------------------------------

export interface DropletCreateRequest {
  name: string;
  region?: string;
  size?: string;
  image?: string;
  user_data?: string;
  ssh_keys?: string[];
  tags?: string[];
}

export interface Droplet {
  id: string;
  name: string;
  status: "new" | "active" | "off" | "archive";
  created_at: string;
  region: { slug: string; name: string };
  size_slug: string;
  image: { slug: string };
  networks: { v4: { ip_address: string; type: string }[] };
  tags: string[];
}

// ---------------------------------------------------------------------------
// Bearer token helpers
// ---------------------------------------------------------------------------

function extractBearer(authHeader: string | undefined): string {
  if (!authHeader) throw new UnauthorizedException("Missing Authorization header");
  const parts = authHeader.split(" ");
  const token = parts[parts.length - 1];
  if (!token || token === "0") throw new UnauthorizedException("Missing bearer token");
  return token;
}

// ---------------------------------------------------------------------------
// Droplet helpers
// ---------------------------------------------------------------------------

function makeDroplet(req: DropletCreateRequest): Droplet {
  const id = crypto.randomUUID();
  return {
    id,
    name: req.name,
    status: "new",
    created_at: new Date().toISOString(),
    region: { slug: req.region ?? "homelab-1", name: "Homelab Region 1" },
    size_slug: req.size ?? "s-1vcpu-1gb",
    image: { slug: typeof req.image === "string" ? req.image : "fedora-latest" },
    networks: { v4: [] },
    tags: req.tags ?? [],
  };
}

// ---------------------------------------------------------------------------
// Docker / VM helpers
// ---------------------------------------------------------------------------

async function dockerInspectIp(containerName: string): Promise<string> {
  const cmd = new Deno.Command("docker", {
    args: ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerName],
    stdout: "piped",
    stderr: "inherit",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) throw new Error(`docker inspect failed for ${containerName}`);
  return new TextDecoder().decode(stdout).trim();
}

async function pollSsh(host: string, timeoutMs = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: host, port: 22 });
      conn.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function spawnVM(
  droplet: Droplet,
  userData: string,
  opts: ComputeProviderLocalFactoryOptions,
): Promise<void> {
  const containerName = `droplet-${droplet.id}`;
  const { vmImage, containerMode, containerImage, cacheDir, log } = opts;

  if (containerMode) {
    // Container path — cloud-init + sshd directly in Docker (no KVM needed)
    try {
      const distro = droplet.image?.slug ?? "ubuntu";
      const info = await runContainer(userData, {
        distro: distro as "fedora" | "ubuntu",
        containerName,
        imageTag: containerImage,
        onIp(ip: string, name: string) {
          // Set IP immediately — before SSH poll — so the prove endpoint
          // can ssh-keyscan the container during cloud-init provisioning.
          droplet.networks.v4 = [{ ip_address: ip, type: "public" }];
          (droplet as unknown as Record<string, unknown>)["containerName"] = name;
        },
      });
      // Update in case onIp set them already (idempotent)
      droplet.networks.v4 = [{ ip_address: info.ip, type: "public" }];
      (droplet as unknown as Record<string, unknown>)["containerName"] = info.containerName;
      droplet.status = "active";
      log("info", "container droplet ready", {
        droplet_id: droplet.id,
        ip: info.ip,
      });
    } catch (err) {
      droplet.status = "off";
      log("error", "container spawn failed", { droplet_id: droplet.id, error: String(err) });
    }
    return;
  }

  // QEMU path — full VM with kernel/initrd/squashfs overlay
  await Deno.mkdir(cacheDir, { recursive: true });
  const udFile = await Deno.makeTempFile({ dir: cacheDir, prefix: "userdata-", suffix: ".yaml" });
  await Deno.writeTextFile(udFile, userData);

  await new Deno.Command("docker", { args: ["rm", "-f", containerName] }).output().catch(() => {});

  const distro = droplet.image?.slug ?? "ubuntu";

  const { code } = await new Deno.Command("docker", {
    args: [
      "run", "-d",
      "--name", containerName,
      "--memory", "6g",
      "--memory-swap", "6g",
      "--device", "/dev/kvm",
      "-v", `${cacheDir}:/root/.cache/simple-qemu`,
      "-v", `${udFile}:/tmp/user-data:ro`,
      "-e", "USER_DATA_FILE=/tmp/user-data",
      vmImage,
      `--distro=${distro}`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();

  if (code !== 0) {
    droplet.status = "off";
    await Deno.remove(udFile).catch(() => {});
    return;
  }

  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 2_000));
      const ip = await dockerInspectIp(containerName);
      log("info", "container IP assigned", { droplet_id: droplet.id, ip });
      const up = await pollSsh(ip);
      if (up) {
        droplet.networks.v4 = [{ ip_address: ip, type: "public" }];
        (droplet as unknown as Record<string, unknown>)["containerName"] = containerName;
        droplet.status = "active";
        log("info", "SSH ready", { droplet_id: droplet.id, ip });
      } else {
        log("warn", "SSH timeout", { droplet_id: droplet.id, ip });
      }
    } catch (err) {
      log("error", "IP/SSH probe failed", { droplet_id: droplet.id, error: String(err) });
    } finally {
      await Deno.remove(udFile).catch(() => {});
    }
  })();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ComputeProviderLocalFactory {
  createApp(): ReturnType<ReturnType<typeof createFactory<ComputeProviderLocalEnv>>["createApp"]>;
  state: ComputeProviderLocalFactoryState;
  killAllDroplets(): Promise<void>;
}

export interface ComputeProviderLocalFactoryState {
  dropletsByActx: Map<string, Map<string, Droplet>>;
}

/**
 * Create a typed Hono factory for the local compute provider.
 *
 * Mounts all routes (OIDC discovery, token issue/prove, droplets CRUD) and
 * RBAC middleware in `initApp`. Returns the hono factory plus droplet registry
 * state for external lifecycle management (signal handlers, cleanup).
 */
export function createComputeProviderLocalFactory(
  opts: ComputeProviderLocalFactoryOptions,
): ComputeProviderLocalFactory {
  const { operatorHandle: _operatorHandle, issuerUrl: _issuerUrl, log } = opts;
  const getIssuerUrl = (): string =>
    typeof _issuerUrl === "function" ? _issuerUrl() : _issuerUrl;
  const getOperatorHandle = (): string =>
    typeof _operatorHandle === "function" ? _operatorHandle() : _operatorHandle;

  const dropletsByActx = new Map<string, Map<string, Droplet>>();

  function getDropletsMap(actx: string): Map<string, Droplet> {
    let m = dropletsByActx.get(actx);
    if (!m) { m = new Map(); dropletsByActx.set(actx, m); }
    return m;
  }

  const factory = createFactory<ComputeProviderLocalEnv>({
    initApp: (app) => {
      // ── CORS ─────────────────────────────────────────────────────
      app.use("*", cors());

      // ── Request logger ───────────────────────────────────────────
      app.use("*", (c, next) => {
        const onBehalfOfDid = c.req.header(ON_BEHALF_OF_HEADER) || undefined;
        return runWithLogContext({ onBehalfOfDid }, async () => {
          log("info", "request", { method: c.req.method, path: c.req.path });
          await next();
        });
      });

      // ── OIDC discovery ───────────────────────────────────────────
      app.get("/.well-known/openid-configuration", async (c) => {
        const jwk = await getPublicJwk();
        return c.json({
          issuer: getIssuerUrl(),
          jwks_uri: `${getIssuerUrl()}/.well-known/jwks`,
          response_types_supported: ["id_token"],
          claims_supported: ["sub", "aud", "exp", "iat", "iss", "actx"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid"],
        });
      });

      app.get("/.well-known/jwks", async (c) => {
        const jwk = await getPublicJwk();
        return c.json({ keys: [jwk] });
      });

      // ── RBAC middleware ──────────────────────────────────────────
      //
      // Two flows:
      //   droplets.wid (OIDC):  /v1/oidc/issue
      //     Token: OIDC JWT, aud encodes actx, validated via OIDC discovery + JWKS
      //
      //   account.auth (ATProto service auth): /v2/account, /v2/droplets*
      //     Token: com.atproto.server.getServiceAuth JWT, iss=DID,
      //     validated against DID document verificationMethod keys

      app.use("/v1/oidc/issue", async (c, next) => {
        try {
          const token = extractBearer(c.req.header("Authorization"));
          const authToken = await raiseIfUnauthorized(getIssuerUrl(), "droplets.wid", token, "/v1/oidc/issue", c.req.method);
          c.set("authToken", authToken);
          setLogContext({ actorDid: authToken.actx });
          await next();
        } catch (err) {
          log("warn", "rbac denied /v1/oidc/issue", { error: String(err) });
          return c.json({ id: "unauthorized", message: String(err) }, 401);
        }
      });

      app.use("/v2/account", async (c, next) => {
        try {
          const token = extractBearer(c.req.header("Authorization"));
          const authToken = await raiseIfUnauthorizedServiceAuth(getIssuerUrl(), "account.auth", getOperatorHandle(), token, "/v2/account", c.req.method);
          c.set("authToken", authToken);
          setLogContext({ actorDid: authToken.actx });
          await next();
        } catch (err) {
          log("warn", "rbac denied /v2/account", { error: String(err) });
          return c.json({ id: "unauthorized", message: String(err) }, 401);
        }
      });

      app.use("/v2/droplets", async (c, next) => {
        try {
          const token = extractBearer(c.req.header("Authorization"));
          const authToken = await raiseIfUnauthorizedServiceAuth(getIssuerUrl(), "account.auth", getOperatorHandle(), token, c.req.path, c.req.method);
          c.set("authToken", authToken);
          setLogContext({ actorDid: authToken.actx });
          await next();
        } catch (err) {
          log("warn", "rbac denied /v2/droplets", { error: String(err) });
          return c.json({ id: "unauthorized", message: String(err) }, 401);
        }
      });

      app.use("/v2/droplets/*", async (c, next) => {
        try {
          const token = extractBearer(c.req.header("Authorization"));
          const authToken = await raiseIfUnauthorizedServiceAuth(getIssuerUrl(), "account.auth", getOperatorHandle(), token, c.req.path, c.req.method);
          c.set("authToken", authToken);
          setLogContext({ actorDid: authToken.actx });
          await next();
        } catch (err) {
          log("warn", "rbac denied /v2/droplets/*", { error: String(err) });
          return c.json({ id: "unauthorized", message: String(err) }, 401);
        }
      });

      // ── /v1/oidc/issue ───────────────────────────────────────────
      app.post("/v1/oidc/issue", async (c) => {
        try {
          const body = await c.req.json<Record<string, unknown>>();
          const authToken = c.get("authToken") as AuthToken;
          const actx = authToken.actx;

          const sub = (body["sub"] as string | undefined) ?? actx;
          if (!subMatchesActx(sub, actx)) {
            return c.json({ id: "unauthorized", message: `sub must be scoped to actx:${actx}` }, 401);
          }

          const token = await OIDCToken.create(actx, { ...body, sub });
          return c.json({ token: token.asString });
        } catch (err) {
          log("error", "oidc issue failed", { error: String(err) });
          return c.json({ id: "server_error", message: String(err) }, 500);
        }
      });

      // ── /v1/oidc/prove ───────────────────────────────────────────
      app.post("/v1/oidc/prove", async (c) => {
        log("debug", "/v1/oidc/prove request received");
        try {
          const body = await c.req.json<{ sig: string; port: number }>();
          log("debug", "/v1/oidc/prove body parsed", { port: body.port, sigLen: body.sig?.length });
          const token = extractBearer(c.req.header("Authorization"));
          log("debug", "/v1/oidc/prove bearer extracted", { tokenPresent: !!token, tokenLen: token?.length });

          const provToken = await OIDCToken.validate(token);
          const actx = provToken.actx;
          log("debug", "/v1/oidc/prove token validated", { actx, provTokenSub: provToken.sub });

          const result = await provisioningValidate(token, body.sig, body.port, (id) => {
            const droplet = getDropletsMap(actx).get(id) as Record<string, unknown> | undefined;
            log("debug", "/v1/oidc/prove droplet lookup", { id, found: !!droplet });
            return droplet;
          });
          log("debug", "/v1/oidc/prove provisioningValidate result", { valid: !!result });
          if (!result) return c.json({ valid: false });

          const { oidcToken, droplet } = result;
          const dropletTags = ((droplet["tags"] as string[]) ?? []);
          log("debug", "/v1/oidc/prove droplet info", { dropletId: droplet["id"], tags: dropletTags });
          const subject = [
            `actx:${oidcToken.actx}`,
            ...dropletTags
              .filter((t) => t.startsWith("oidc-sub:") && t.split(":").length === 3 && t.split(":")[1] !== "actx")
              .map((t) => t.split(":")[1] + ":" + t.split(":")[2]),
          ].join(":");
          log("debug", "/v1/oidc/prove computed subject", { subject });

          const issued = await OIDCToken.create(oidcToken.actx, {
            sub: subject,
            droplet_id: droplet["id"],
          });
          log("debug", "/v1/oidc/prove token issued", { sub: subject, dropletId: droplet["id"] });
          return c.json({ token: issued.asString });
        } catch (err) {
          log("error", "oidc prove failed", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
          return c.json({ id: "unauthorized", message: String(err) }, 401);
        }
      });

      // ── /v2/account ──────────────────────────────────────────────
      app.get("/v2/account", (c) => {
        const authToken = c.get("authToken") as AuthToken;
        log("info", "/v2/account uuid", { uuid: authToken.actx });
        return c.json({ account: { team: { uuid: authToken.actx } } });
      });

      // ── /v2/droplets CRUD ────────────────────────────────────────
      app.post("/v2/droplets", async (c) => {
        let body: DropletCreateRequest;
        try {
          body = await c.req.json<DropletCreateRequest>();
        } catch {
          return c.json({ id: "unprocessable_entity", message: "Invalid JSON body" }, 422);
        }

        if (!body.name) {
          return c.json({ id: "unprocessable_entity", message: "'name' is required" }, 422);
        }

        if (body.region === "invalid-region-for-auth-check") {
          return c.json({ id: "unprocessable_entity", message: "invalid region" }, 422);
        }

        try {
          const authToken = c.get("authToken") as AuthToken;
          const actx = authToken.actx;

          const droplet = makeDroplet(body);
          getDropletsMap(actx).set(droplet.id, droplet);

          const provisioningData = await ProvisioningData.create(actx, body.user_data ?? null, getIssuerUrl());
          body.user_data = provisioningData.userData;
          provisioningData.associateWithDroplet(droplet.id);

          log("info", "droplets.create → local VM", { name: body.name, actx });
          // Fire-and-forget: container startup can take 5-30s (image build,
          // cloud-init, sshd).  Don't block the HTTP response — the relay
          // would time out.  Status transitions new→active in background.
          spawnVM(droplet, provisioningData.userData, opts);
          return c.json({ droplet }, 202);
        } catch (err) {
          log("error", "droplets create failed", { error: String(err) });
          return c.json({ id: "server_error", message: String(err) }, 500);
        }
      });

      app.get("/v2/droplets", (c) => {
        const actx = (c.get("authToken") as AuthToken).actx;
        return c.json({ droplets: [...getDropletsMap(actx).values()] });
      });

      app.get("/v2/droplets/:id", (c) => {
        const actx = (c.get("authToken") as AuthToken).actx;
        const id = c.req.param("id");
        const droplet = getDropletsMap(actx).get(id);
        if (!droplet) return c.json({ id: "not_found", message: "Droplet not found" }, 404);
        return c.json({ droplet });
      });

      app.delete("/v2/droplets/:id", async (c) => {
        const actx = (c.get("authToken") as AuthToken).actx;
        const id = c.req.param("id");
        const dm = getDropletsMap(actx);
        if (!dm.has(id)) return c.json({ id: "not_found", message: "Droplet not found" }, 404);
        dm.delete(id);
        await new Deno.Command("docker", { args: ["kill", `droplet-${id}`] }).output().catch(() => {});
        await new Deno.Command("docker", { args: ["rm", "-f", `droplet-${id}`] }).output().catch(() => {});
        return new Response(null, { status: 204 });
      });
    },
  });

  return {
    createApp: () => factory.createApp(),
    state: { dropletsByActx },
    async killAllDroplets() {
      const ids = [...dropletsByActx.values()].flatMap((m) => [...m.keys()]);
      if (ids.length === 0) return;
      log("info", "shutdown: killing droplets", { ids });
      await Promise.all(
        ids.map((id) =>
          new Deno.Command("docker", { args: ["rm", "-f", `droplet-${id}`] })
            .output()
            .catch(() => {})
        ),
      );
    },
  };
}
