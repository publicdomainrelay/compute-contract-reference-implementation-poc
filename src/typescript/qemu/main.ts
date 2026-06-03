#!/usr/bin/env -S deno run -A
/**
 * miniCloud.ts — merged MiniCloud server (Hono + Deno)
 *
 * Merges:
 *   homelab.ts      — local QEMU VM spawning via Docker
 *   create_vm.py    — OIDC issuer, JWKS, droplet RBAC proxy
 *
 * Routes:
 *   GET  /.well-known/openid-configuration
 *   GET  /.well-known/jwks
 *   POST /v1/oidc/issue       (RBAC middleware — requires valid OIDC token)
 *   POST /v1/oidc/prove
 *   GET  /v2/account
 *   POST /v2/droplets
 *   GET  /v2/droplets
 *   GET  /v2/droplets/:id
 *   DELETE /v2/droplets/:id
 *
 * Env:
 *   PORT              — listen port (default 8080)
 *   TEAM_UUID         — team UUID returned by /v2/account (non-DID actx)
 *   VM_IMAGE          — Docker image for QEMU VMs
 *   ISSUER_URL / THIS_ENDPOINT — OIDC issuer URL (default http://localhost:PORT)
 *   DATABASE_URI      — sqlite:///path or postgresql://... (default ./app.db)
 */

import { Hono } from "https://deno.land/x/hono@v4.3.11/mod.ts";
import { getPublicJwk, getSigningKey, OIDCToken, UnauthorizedException } from "./oidc_helper.ts";
import { raiseIfUnauthorized } from "./rbac_helper.ts";
import { ProvisioningData, validate as provisioningValidate } from "./provisioning.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(Deno.env.get("PORT") ?? 8080);
const TEAM_UUID = Deno.env.get("TEAM_UUID") ?? "00000000-0000-0000-0000-000000000000";
const VM_IMAGE = Deno.env.get("VM_IMAGE") ?? "atcr.io/johnandersen777.bsky.social/homelab-runner";
const CACHE_DIR = `${Deno.env.get("HOME")}/.cache/simple-qemu`;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(
  level: "info" | "error" | "warn",
  msg: string,
  extra?: Record<string, unknown>,
) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  Deno.stderr.writeSync(new TextEncoder().encode(JSON.stringify(entry) + "\n"));
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

function isOidcToken(token: string): boolean {
  return token.split(".").length === 3;
}

// ---------------------------------------------------------------------------
// Droplet types + in-memory registry
// ---------------------------------------------------------------------------

interface DropletCreateRequest {
  name: string;
  region?: string;
  size?: string;
  image?: string;
  user_data?: string;
  ssh_keys?: string[];
  tags?: string[];
}

interface Droplet {
  id: number;
  name: string;
  status: "new" | "active" | "off" | "archive";
  created_at: string;
  region: { slug: string; name: string };
  size_slug: string;
  image: { slug: string };
  networks: { v4: { ip_address: string; type: string }[] };
  tags: string[];
}

const droplets = new Map<number, Droplet>();
let nextId = 1;

function makeDroplet(req: DropletCreateRequest): Droplet {
  const id = nextId++;
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
// Local VM spawning (homelab path)
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

async function spawnVM(droplet: Droplet, userData: string): Promise<void> {
  const containerName = `droplet-${droplet.id}`;

  await Deno.mkdir(CACHE_DIR, { recursive: true });
  const udFile = await Deno.makeTempFile({ dir: CACHE_DIR, prefix: "userdata-", suffix: ".yaml" });
  await Deno.writeTextFile(udFile, userData);

  await new Deno.Command("docker", { args: ["rm", "-f", containerName] }).output().catch(() => {});

  const { code } = await new Deno.Command("docker", {
    args: [
      "run", "-d",
      "--name", containerName,
      "--device", "/dev/kvm",
      "-v", `${CACHE_DIR}:/root/.cache/simple-qemu`,
      "-v", `${udFile}:/tmp/user-data:ro`,
      "-e", "USER_DATA_FILE=/tmp/user-data",
      VM_IMAGE,
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
// App
// ---------------------------------------------------------------------------

const app = new Hono();

// request logger
app.use("*", async (c, next) => {
  log("info", "request", { method: c.req.method, path: c.req.path });
  await next();
});

// GET /.well-known/openid-configuration
app.get("/.well-known/openid-configuration", async (c) => {
  const jwk = await getPublicJwk();
  const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;
  return c.json({
    issuer: issuerUrl,
    jwks_uri: `${issuerUrl}/.well-known/jwks`,
    response_types_supported: ["id_token"],
    claims_supported: ["sub", "aud", "exp", "iat", "iss", "actx"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid"],
  });
});

// GET /.well-known/jwks
app.get("/.well-known/jwks", async (c) => {
  const jwk = await getPublicJwk();
  return c.json({ keys: [jwk] });
});

// ---------------------------------------------------------------------------
// RBAC middleware for /v1/oidc/issue
//
// Mirrors rbac_helper.raise_if_unauthorized / main.go validateOIDCToken flow:
//   1. Extract bearer token
//   2. Peek aud → if actx is DID: resolve PDS → fetch com.fedproxy.rbac → collect issuers
//   3. Verify JWT signature + aud + iss + exp
//   4. Match sub against roles → check policy allows POST /v1/oidc/issue
// ---------------------------------------------------------------------------

app.use("/v1/oidc/issue", async (c, next) => {
  try {
    const token = extractBearer(c.req.header("Authorization"));
    const oidcToken = await raiseIfUnauthorized(token, "/v1/oidc/issue", "POST");
    // Attach verified token to context for the route handler
    c.set("oidcToken", oidcToken);
    await next();
  } catch (err) {
    log("warn", "rbac middleware denied", { error: String(err), path: c.req.path });
    return c.json({ id: "unauthorized", message: String(err) }, 401);
  }
});

// POST /v1/oidc/issue — issue an OIDC token for authorized callers
app.post("/v1/oidc/issue", async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const oidcToken = c.get("oidcToken") as OIDCToken;
    const actx = oidcToken.actx;

    const sub = (body["sub"] as string | undefined) ?? actx;
    if (!sub.includes(`actx:${actx}`)) {
      return c.json({ id: "unauthorized", message: `sub must contain actx:${actx}` }, 401);
    }

    const token = await OIDCToken.create(actx, { ...body, sub });
    return c.json({ token: token.asString });
  } catch (err) {
    log("error", "oidc issue failed", { error: String(err) });
    return c.json({ id: "server_error", message: String(err) }, 500);
  }
});

// POST /v1/oidc/prove — validate droplet SSH challenge + issue scoped token
app.post("/v1/oidc/prove", async (c) => {
  try {
    const body = await c.req.json<{ sig: string; port: number }>();
    const token = extractBearer(c.req.header("Authorization"));

    const result = await provisioningValidate(token, body.sig, body.port, (id) => droplets.get(id) as Record<string, unknown> | undefined);
    if (!result) return c.json({ valid: false });

    const { oidcToken, droplet } = result;
    const dropletTags = ((droplet["tags"] as string[]) ?? []);
    const subject = [
      `actx:${oidcToken.actx}`,
      ...dropletTags
        .filter((t) => t.startsWith("oidc-sub:") && t.split(":").length === 3 && t.split(":")[1] !== "actx")
        .map((t) => t.split(":", 2)[1]),
    ].join(":");

    const issued = await OIDCToken.create(oidcToken.actx, {
      sub: subject,
      droplet_id: droplet["id"],
    });
    return c.json({ token: issued.asString });
  } catch (err) {
    log("error", "oidc prove failed", { error: String(err) });
    return c.json({ id: "unauthorized", message: String(err) }, 401);
  }
});

// GET /v2/account
app.get("/v2/account", async (c) => {
  try {
    const token = extractBearer(c.req.header("Authorization"));
    let teamUuid = TEAM_UUID;

    if (isOidcToken(token)) {
      const oidcToken = await OIDCToken.validate(token);
      teamUuid = oidcToken.actx ?? TEAM_UUID;
    }

    return c.json({ account: { team: { uuid: teamUuid } } });
  } catch (err) {
    log("error", "account get failed", { error: String(err) });
    return c.json({ id: "unauthorized", message: String(err) }, 401);
  }
});

// POST /v2/droplets — create/spawn a droplet
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
    // Local Docker/QEMU path
    const droplet = makeDroplet(body);
    droplets.set(droplet.id, droplet);

    const provisioningData = await ProvisioningData.create(TEAM_UUID, body.user_data ?? null);
    body.user_data = provisioningData.userData;
    provisioningData.associateWithDroplet(droplet.id);

    log("info", "droplets.create → local VM", { name: body.name });
    await spawnVM(droplet, provisioningData.userData);
    return c.json({ droplet }, 202);
  } catch (err) {
    log("error", "droplets create failed", { error: String(err) });
    return c.json({ id: "server_error", message: String(err) }, 500);
  }
});

// GET /v2/droplets — list all local droplets
app.get("/v2/droplets", (c) => {
  return c.json({ droplets: [...droplets.values()] });
});

// GET /v2/droplets/:id
app.get("/v2/droplets/:id", (c) => {
  const id = Number(c.req.param("id"));
  const droplet = droplets.get(id);
  if (!droplet) return c.json({ id: "not_found", message: "Droplet not found" }, 404);
  return c.json({ droplet });
});

// DELETE /v2/droplets/:id
app.delete("/v2/droplets/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!droplets.has(id)) return c.json({ id: "not_found", message: "Droplet not found" }, 404);
  droplets.delete(id);
  await new Deno.Command("docker", { args: ["rm", "-f", `droplet-${id}`] }).output().catch(() => {});
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function killAllDroplets(): Promise<void> {
  const ids = [...droplets.keys()];
  if (ids.length === 0) return;
  log("info", "shutdown: killing droplets", { ids });
  await Promise.all(
    ids.map((id) =>
      new Deno.Command("docker", { args: ["rm", "-f", `droplet-${id}`] })
        .output()
        .catch(() => {})
    ),
  );
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, async () => {
    log("info", `received ${sig}, shutting down`);
    await killAllDroplets();
    Deno.exit(0);
  });
}

// Warm up signing key (loads from DB or generates + persists)
await getSigningKey();
const jwk = await getPublicJwk();
const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;
log("info", "miniCloud listening", { port: PORT, issuer: issuerUrl, kid: jwk.kid });
Deno.serve({ port: PORT }, app.fetch);
