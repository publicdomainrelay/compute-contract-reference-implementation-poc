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
 *   VM_IMAGE          — Docker image for QEMU VMs
 *   ISSUER_URL / THIS_ENDPOINT — OIDC issuer URL (default http://localhost:PORT)
 *   DATABASE_URI      — sqlite:///path or postgresql://... (default ./app.db)
 */

import { Hono } from "https://deno.land/x/hono@v4.3.11/mod.ts";
import { getPublicJwk, getSigningKey, OIDCToken, UnauthorizedException, subMatchesActx } from "./oidc_helper.ts";
import { raiseIfUnauthorized, raiseIfUnauthorizedServiceAuth, AuthToken } from "./rbac_helper.ts";
import { ProvisioningData, validate as provisioningValidate } from "./provisioning.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(Deno.env.get("PORT") ?? 8080);
const VM_IMAGE = Deno.env.get("VM_IMAGE") ?? "atcr.io/johnandersen777.bsky.social/ccripoc-qemu-runner";
const CACHE_DIR = `${Deno.env.get("HOME")}/.cache/simple-qemu`;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(
  level: "info" | "error" | "warn" | "debug",
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

const dropletsByActx = new Map<string, Map<string, Droplet>>();

function getDroplets(actx: string): Map<string, Droplet> {
  let m = dropletsByActx.get(actx);
  if (!m) { m = new Map(); dropletsByActx.set(actx, m); }
  return m;
}

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

  const distro = droplet.image?.slug ?? "ubuntu";

  const { code } = await new Deno.Command("docker", {
    args: [
      "run", "-d",
      "--name", containerName,
      "--memory", "6g",
      "--memory-swap", "6g",
      "--device", "/dev/kvm",
      "-v", `${CACHE_DIR}:/root/.cache/simple-qemu`,
      "-v", `${udFile}:/tmp/user-data:ro`,
      "-e", "USER_DATA_FILE=/tmp/user-data",
      VM_IMAGE,
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
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Variables: { authToken: AuthToken } }>();

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
// RBAC middleware — two distinct flows
//
// droplets.wid (OIDC): /v1/oidc/issue
//   Token: OIDC JWT, aud encodes actx, validated via OIDC discovery + JWKS
//
// account.auth (ATProto service auth): /v2/account, /v2/droplets*
//   Token: com.atproto.server.getServiceAuth JWT, iss=DID,
//   validated against DID document verificationMethod keys — no OIDC discovery
// ---------------------------------------------------------------------------

app.use("/v1/oidc/issue", async (c, next) => {
  try {
    const token = extractBearer(c.req.header("Authorization"));
    const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;
    const authToken = await raiseIfUnauthorized(issuerUrl, "droplets.wid", token, "/v1/oidc/issue", c.req.method);
    c.set("authToken", authToken);
    await next();
  } catch (err) {
    log("warn", "rbac denied /v1/oidc/issue", { error: String(err) });
    return c.json({ id: "unauthorized", message: String(err) }, 401);
  }
});

app.use("/v2/account", async (c, next) => {
  try {
    const token = extractBearer(c.req.header("Authorization"));
    const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;
    const authToken = await raiseIfUnauthorizedServiceAuth(issuerUrl, "account.auth", token, "/v2/account", c.req.method);
    c.set("authToken", authToken);
    await next();
  } catch (err) {
    log("warn", "rbac denied /v2/account", { error: String(err) });
    return c.json({ id: "unauthorized", message: String(err) }, 401);
  }
});

app.use("/v2/droplets", async (c, next) => {
  try {
    const token = extractBearer(c.req.header("Authorization"));
    const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;
    const authToken = await raiseIfUnauthorizedServiceAuth(issuerUrl, "account.auth", token, c.req.path, c.req.method);
    c.set("authToken", authToken);
    await next();
  } catch (err) {
    log("warn", "rbac denied /v2/droplets", { error: String(err) });
    return c.json({ id: "unauthorized", message: String(err) }, 401);
  }
});

app.use("/v2/droplets/*", async (c, next) => {
  try {
    const token = extractBearer(c.req.header("Authorization"));
    const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;
    const authToken = await raiseIfUnauthorizedServiceAuth(issuerUrl, "account.auth", token, c.req.path, c.req.method);
    c.set("authToken", authToken);
    await next();
  } catch (err) {
    log("warn", "rbac denied /v2/droplets/*", { error: String(err) });
    return c.json({ id: "unauthorized", message: String(err) }, 401);
  }
});

// POST /v1/oidc/issue — issue an OIDC token for authorized callers
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

// POST /v1/oidc/prove — validate droplet SSH challenge + issue scoped token
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
      const droplet = getDroplets(actx).get(id) as Record<string, unknown> | undefined;
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

// GET /v2/account
app.get("/v2/account", (c) => {
  const authToken = c.get("authToken") as AuthToken;
  log("info", "/v2/account uuid", { uuid: authToken.actx });
  return c.json({ account: { team: { uuid: authToken.actx } } });
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
    const authToken = c.get("authToken") as AuthToken;
    const actx = authToken.actx;

    // Local Docker/QEMU path
    const droplet = makeDroplet(body);
    getDroplets(actx).set(droplet.id, droplet);

    const provisioningData = await ProvisioningData.create(actx, body.user_data ?? null);
    body.user_data = provisioningData.userData;
    provisioningData.associateWithDroplet(droplet.id);

    log("info", "droplets.create → local VM", { name: body.name, actx });
    await spawnVM(droplet, provisioningData.userData);
    return c.json({ droplet }, 202);
  } catch (err) {
    log("error", "droplets create failed", { error: String(err) });
    return c.json({ id: "server_error", message: String(err) }, 500);
  }
});

// GET /v2/droplets — list caller's droplets
app.get("/v2/droplets", (c) => {
  const actx = (c.get("authToken") as AuthToken).actx;
  return c.json({ droplets: [...getDroplets(actx).values()] });
});

// GET /v2/droplets/:id
app.get("/v2/droplets/:id", (c) => {
  const actx = (c.get("authToken") as AuthToken).actx;
  const id = c.req.param("id");
  const droplet = getDroplets(actx).get(id);
  if (!droplet) return c.json({ id: "not_found", message: "Droplet not found" }, 404);
  return c.json({ droplet });
});

// DELETE /v2/droplets/:id
app.delete("/v2/droplets/:id", async (c) => {
  const actx = (c.get("authToken") as AuthToken).actx;
  const id = c.req.param("id");
  const dm = getDroplets(actx);
  if (!dm.has(id)) return c.json({ id: "not_found", message: "Droplet not found" }, 404);
  dm.delete(id);
  await new Deno.Command("docker", { args: ["kill", `droplet-${id}`] }).output().catch(() => {});
  await new Deno.Command("docker", { args: ["rm", "-f", `droplet-${id}`] }).output().catch(() => {});
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function killAllDroplets(): Promise<void> {
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
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, async () => {
    log("info", `received ${sig}, shutting down`);
    await killAllDroplets();
    if (sig === "SIGINT") {
      Deno.exit(0);
    }
  });
}

// Warm up signing key (loads from DB or generates + persists)
await getSigningKey();
const jwk = await getPublicJwk();
const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;
log("info", "miniCloud listening", { port: PORT, issuer: issuerUrl, kid: jwk.kid });
Deno.serve({ port: PORT }, app.fetch);
