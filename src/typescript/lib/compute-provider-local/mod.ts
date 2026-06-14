// compute-provider-local — provisions Docker containers (QEMU VMs or light
// cloud-init+sshd containers) on the local host. Implements ComputeProvider
// so the bidder never branches on "where to provision".
//
// No HTTP, no RBAC, no OIDC — just docker commands and YAML injection.
//
// Also exports the low-level container runner (runContainer, buildContainerImage,
// DEFAULT_USER_DATA) for direct use from hono-factory-compute-provider-local and
// other callers that need the full container lifecycle outside the ComputeProvider
// interface.

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

export interface ComputeProviderLocalCtx extends ComputeProviderCtx {
  getAgent: () => Agent;
  getAgentDid: () => string;
  acceptPathVm: string;
  /** "container" (lightweight, no KVM) or "vm" (QEMU). Default: "container". */
  containerMode?: "vm" | "container";
  /** Docker image for QEMU VMs. */
  vmImage?: string;
  /** Docker image for container mode. */
  containerImage?: string;
  /** Cache directory. Default: ~/.cache/pdr-local. */
  cacheDir?: string;
  /** Gets the xrpc relay url for the hono-factory-workload-identity-droplet-oidc-poc. */
  getIssuerUrl: () => string;
  /** Creates an atproto record in the bidder's repo (for createBidConfig). */
  createRecord: (
    collection: string,
    record: Record<string, unknown>,
  ) => Promise<StrongRef>;
}

type Distro = "fedora" | "ubuntu";

export interface ContainerOptions {
  distro?: Distro;
  memory?: string;
  imageTag?: string;
  containerName?: string;
  /** Called as soon as the container IP is known (before SSH poll). */
  onIp?: (ip: string, containerName: string) => void | Promise<void>;
}

export interface ContainerInfo {
  ip: string;
  containerName: string;
}

// WIF simple config NSID — hardcoded to avoid a lexicons dep that pulls in
// the full atproto stack.
const COMPUTE_CONFIG_WIF_SIMPLE_NSID =
  "com.publicdomainrelay.temp.compute.config.wif.simple";

// ── constants ────────────────────────────────────────────────────────────

const HOME = Deno.env.get("HOME");
if (!HOME) {
  console.error("HOME environment variable is not set.");
  Deno.exit(1);
}

const POLL_TIMEOUT_MS = 300_000; // 5 minutes
const SSH_DEFAULT_PORT = 22;
const MEMORY_DEFAULT = "512m";

export const DEFAULT_USER_DATA = `#cloud-config
users:
  - name: agent
    sudo: ["ALL=(ALL) NOPASSWD:ALL"]
chpasswd:
  expire: False
  users:
  - name: agent
    password: agent
    type: text
ssh_pwauth: true
`;

function defaultCacheDir(): string {
  return `${HOME}/.cache/pdr-local`;
}

// ── helpers ──────────────────────────────────────────────────────────────

function shortUuid(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function dockerRun(
  args: string[],
  opts?: { inherit?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("docker", {
    args,
    stdout: opts?.inherit ? "inherit" : "piped",
    stderr: opts?.inherit ? "inherit" : "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: opts?.inherit ? "" : new TextDecoder().decode(out.stdout).trim(),
    stderr: opts?.inherit ? "" : new TextDecoder().decode(out.stderr).trim(),
  };
}

async function dockerInspectIp(containerName: string): Promise<string> {
  const { code, stdout } = await dockerRun([
    "inspect", "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    containerName,
  ]);
  if (code !== 0) throw new Error(`docker inspect failed for ${containerName}`);
  return stdout;
}

async function pollSsh(
  host: string,
  port: number = SSH_DEFAULT_PORT,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: host, port });
      conn.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function imageExists(tag: string): Promise<boolean> {
  const { code, stdout } = await dockerRun(["images", "-q", tag]);
  return code === 0 && stdout.length > 0;
}

async function pullImage(
  image: string,
  log: ComputeProviderCtx["log"],
): Promise<void> {
  log("info", "pulling image", { image });
  const { code, stderr } = await dockerRun(["pull", image], { inherit: true });
  if (code !== 0) throw new Error(`docker pull failed for ${image}: ${stderr}`);
}

// ── entrypoint + Dockerfile generation ───────────────────────────────────

function imageTag(distro: Distro): string {
  return `container-runner-${distro}:latest`;
}

/**
 * Entrypoint script for the container-runner image.
 * The deno systemctl-shim (mounted at runtime) runs as PID 1.
 * It generates SSH host keys, starts sshd, runs cloud-init, then monitors.
 * Cloud-init runcmd calls `systemctl` which is a wrapper that invokes
 * `deno run -A /usr/local/bin/systemctl-shim.ts <command>`.
 */
function generateEntrypoint(_distro: Distro): string {
  return `#!/bin/bash
set -e
echo "[container-entrypoint] Launching systemctl-shim as PID 1"

# Create systemctl wrapper so cloud-init runcmd can call it
if [ -f /usr/local/bin/systemctl-shim.ts ]; then
  cat > /usr/local/bin/systemctl << 'SHEOF'
#!/bin/bash
exec deno run -A /usr/local/bin/systemctl-shim.ts "$@"
SHEOF
  chmod +x /usr/local/bin/systemctl
fi

exec deno run -A /usr/local/bin/systemctl-shim.ts --init
`;
}

/**
 * Dockerfile for the container-runner image. Installs cloud-init + sshd + deno.
 * The systemctl shim is NOT baked in — it is mounted at runtime (systemctl-shim.ts)
 * and the entrypoint creates the /usr/local/bin/systemctl wrapper on boot.
 */
function generateDockerfile(distro: Distro): string {
  const base = distro === "fedora"
    ? `FROM fedora:latest
RUN dnf install -y \\
    cloud-init openssh-server sudo curl jq util-linux rsyslog vim tmux git unzip python3 \\
  && dnf clean all`
    : `FROM ubuntu:latest
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \\
    cloud-init openssh-server sudo curl jq util-linux rsyslog vim tmux git unzip ca-certificates locales python3 \\
  && rm -rf /var/lib/apt/lists/*`;

  return `${base}
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
`;
}

// ── image building ───────────────────────────────────────────────────────

export async function buildContainerImage(
  distro: Distro = "ubuntu",
): Promise<string> {
  const tag = imageTag(distro);

  // Check if already built
  if (await imageExists(tag)) {
    console.log(`==> Image ${tag} already exists. Skipping build.`);
    return tag;
  }

  console.log(`==> Building container image for ${distro}...`);

  // Create ephemeral build context
  const buildDir = await Deno.makeTempDir({ prefix: "container-build-" });
  try {
    // Write entrypoint.sh
    await Deno.writeTextFile(
      `${buildDir}/entrypoint.sh`,
      generateEntrypoint(distro),
    );
    await Deno.chmod(`${buildDir}/entrypoint.sh`, 0o755);

    // Write Dockerfile
    await Deno.writeTextFile(
      `${buildDir}/Dockerfile`,
      generateDockerfile(distro),
    );

    // Build
    const { code } = await new Deno.Command("docker", {
      args: [
        "build",
        "--pull",
        "--progress", "plain",
        "-t", tag,
        buildDir,
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).output();

    if (code !== 0) {
      throw new Error(`docker build failed for ${tag}`);
    }

    console.log(`==> Built container image: ${tag}`);
    return tag;
  } finally {
    await Deno.remove(buildDir, { recursive: true }).catch(() => {});
  }
}

// ── container runner ─────────────────────────────────────────────────────

/**
 * Copy systemctl-shim.ts to a stable path under cacheDir so Docker can mount it.
 * Returns the host path that should be mounted to /usr/local/bin/systemctl-shim.ts.
 */
async function copySystemctlShim(
  distro: Distro,
  cacheDir: string,
): Promise<string> {
  const systemctlShimSrc = new URL(
    "./systemctl-shim.ts",
    import.meta.url,
  ).pathname;
  const dst = `${cacheDir}/systemctl-shim-${distro}.ts`;
  // Copy to stable path so Docker can mount it (tempfile paths differ each run)
  await Deno.copyFile(systemctlShimSrc, dst);
  return dst;
}

export async function runContainer(
  userData: string,
  opts: ContainerOptions = {},
): Promise<ContainerInfo> {
  const distro = opts.distro ?? "ubuntu";
  const tag = opts.imageTag ?? imageTag(distro);
  const memory = opts.memory ?? MEMORY_DEFAULT;
  const containerName = opts.containerName ??
    `container-${crypto.randomUUID().slice(0, 8)}`;

  console.log(`==> Starting container (${distro}, tag=${tag})`);

  // Ensure image exists — auto-build if not
  if (!(await imageExists(tag))) {
    console.log(`==> Image ${tag} not found. Building...`);
    await buildContainerImage(distro);
  }

  const cacheDir = defaultCacheDir();
  await Deno.mkdir(cacheDir, { recursive: true });

  // Write user-data to temp file
  const udFile = await Deno.makeTempFile({
    dir: cacheDir,
    prefix: "container-ud-",
    suffix: ".yaml",
  });
  await Deno.writeTextFile(udFile, userData);

  // Generate entrypoint and write to temp file (runtime mount → no image
  // rebuild needed when entrypoint changes).
  const entrypointScript = generateEntrypoint(distro);
  const epFile = await Deno.makeTempFile({
    dir: cacheDir,
    prefix: "container-ep-",
    suffix: ".sh",
  });
  await Deno.writeTextFile(epFile, entrypointScript);
  await Deno.chmod(epFile, 0o755);

  // Mount deno-based systemctl shim (type-checked, handles flags properly).
  const systemctlShimTag = await copySystemctlShim(distro, cacheDir);

  // Clean up any old container with same name
  await dockerRun(["rm", "-f", containerName]).catch(() => {});

  // Run container — entrypoint + systemctl-shim mounted at runtime
  const { code, stderr } = await dockerRun([
    "run", "-d",
    "--name", containerName,
    "--memory", memory,
    "--memory-swap", memory,
    "-v", `${udFile}:/tmp/user-data:ro`,
    "-v", `${epFile}:/entrypoint.sh:ro`,
    "-v", `${systemctlShimTag}:/usr/local/bin/systemctl-shim.ts:ro`,
    "-e", "USER_DATA_FILE=/tmp/user-data",
    tag,
  ]);

  if (code !== 0) {
    await Deno.remove(udFile).catch(() => {});
    await Deno.remove(epFile).catch(() => {});
    throw new Error(
      `docker run failed for ${containerName} (exit ${code}): ${stderr}`,
    );
  }

  // Get container IP — wait a moment for the container to start
  await new Promise((r) => setTimeout(r, 1_000));
  const ip = await dockerInspectIp(containerName);
  console.log(`==> Container IP: ${ip}`);

  // Notify caller of IP immediately (before SSH poll) so the droplet record
  // is updated before the provisioning-token prove callback arrives.
  if (opts.onIp) await opts.onIp(ip, containerName);

  // Wait for SSH
  console.log("==> Waiting for SSH...");
  const ready = await pollSsh(ip, 22);
  if (!ready) {
    // Clean up temp files but leave container for debugging
    await Deno.remove(udFile).catch(() => {});
    await Deno.remove(epFile).catch(() => {});
    throw new Error(
      `SSH not ready within timeout for ${containerName} (ip=${ip})`,
    );
  }

  console.log(`==> SSH ready! ssh agent@${ip}`);
  console.log(`    Container: ${containerName}`);

  // Clean up temp files
  await Deno.remove(udFile).catch(() => {});
  await Deno.remove(epFile).catch(() => {});

  return { ip, containerName };
}

// ── QEMU VM helpers ──────────────────────────────────────────────────────

async function provisionVM(
  vm: VM,
  containerName: string,
  user_data: string,
  ds: DropletSpec,
  cacheDir: string,
  vmImage: string,
  log: ComputeProviderCtx["log"],
): Promise<{ ip: string; sshReady: boolean }> {
  log("info", "provisioning VM", { containerName, image: vmImage });

  await pullImage(vmImage, log);

  const udFile = `${cacheDir}/ud-${containerName}.yaml`;
  await Deno.writeTextFile(udFile, user_data);

  await dockerRun(["rm", "-f", containerName]).catch(() => {});

  const { code, stderr } = await dockerRun([
    "run", "-d",
    "--name", containerName,
    "--privileged",
    "--memory", "6g",
    "--memory-swap", "6g",
    "--device", "/dev/kvm",
    "-v", `${cacheDir}:/root/.cache/simple-qemu`,
    "-v", `${udFile}:/tmp/user-data:ro`,
    "-e", "USER_DATA_FILE=/tmp/user-data",
    vmImage,
    `--distro=${ds.image ?? "ubuntu"}`,
  ]);

  if (code !== 0) {
    throw new Error(`docker run failed for ${containerName}: ${stderr}`);
  }

  await new Promise((r) => setTimeout(r, 2_000));

  let ip = "0.0.0.0";
  try {
    ip = await dockerInspectIp(containerName);
    log("info", "VM container IP", { containerName, ip });
  } catch {
    log("warn", "could not get VM container IP", { containerName });
  }

  const sshReady = await pollSsh(ip, 22, POLL_TIMEOUT_MS);
  if (!sshReady) {
    log("warn", "SSH not ready within timeout", { containerName, ip });
  }

  return { ip, sshReady };
}

// ── factory ──────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// ComputeProvider adapter — wraps the RBAC-aware DO implementation in the
// provider-agnostic ComputeProvider interface.
// ---------------------------------------------------------------------------


export function createComputeProviderLocal(ctx: ComputeProviderDigitalOceanCtx) {
  const { getAgent, getAgentDid, log, parseAtUri, acceptPathVm, getIssuerUrl, createRecord } = ctx;
  const containerMode = ctx.containerMode ??
    (Deno.env.get("CONTAINER_MODE") === "true" ? "container" : "vm");
  const vmImage = ctx.vmImage ??
    Deno.env.get("VM_IMAGE") ??
    "atcr.io/johnandersen777.bsky.social/ccripoc-qemu-runner";
  const containerImage = ctx.containerImage ??
    Deno.env.get("CONTAINER_IMAGE") ??
    "container-runner-ubuntu:latest";
  const cacheDir = ctx.cacheDir ??
    Deno.env.get("CACHE_DIR") ??
    defaultCacheDir();

  // Track container names
  const containers = new Map<string, string>();

  async function atprotoCreateRecord(collection: string, record: Record<string, unknown>): Promise<StrongRef> {
    const agent = getAgent();
    const res = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection,
      record,
    });
    return { $type: "com.atproto.repo.strongRef", uri: res.data.uri, cid: res.data.cid };
  }

  // ── provision ───────────────────────────────────────────────────────

  async function provision(
    vm: VM,
    requesterDid: string,
    spec?: DropletSpec,
  ): Promise<ProvisionResult><{ result: ProvisionResult; rbacRef: StrongRef }> {
    const ds = spec ?? dropletSpecFromEnv();
    const requesterPlc = requesterDid.split(":").pop() ?? "unknown";
    const rfpRkey = (vm._uri ?? "").split("/")[4] ?? "unknown";
    const containerName = `pdr-${requesterPlc}-${rfpRkey}-${shortUuid()}`;

    await Deno.mkdir(cacheDir, { recursive: true });

    const rbacRef = await configureDropletRbac(getAgent(), vm, requesterDid);

    const provisioningData = await ProvisioningData.create(getAgentDid(), vm.user_data ?? null);
    const user_data = provisioningData.userData;
    provisioningData.associateWithDroplet(droplet.id);

    if (containerMode === "container") {
      // Container path — cloud-init + sshd directly in Docker (no KVM needed).
      // Uses runContainer which handles entrypoint generation, systemctl-shim
      // mount, image auto-build, and SSH polling.
      log("info", "provisioning container", {
        containerName,
        image: containerImage,
      });

      const info = await runContainer(user_data, {
        distro: (ds.image as Distro | undefined) ?? "ubuntu",
        containerName,
        imageTag: containerImage,
      });

      containers.set(containerName, containerName);

      return {
        providerId: containerName,
        metadata: {
          containerName,
          ip: info.ip,
          mode: "container",
          sshReady: true,
        },
      };
    }

    // VM mode: run QEMU in Docker
    const { ip, sshReady } = await provisionVM(
      vm,
      containerName,
      user_data,
      ds,
      cacheDir,
      vmImage,
      log,
    );

    containers.set(containerName, containerName);

    return {
      providerId: containerName,
      metadata: {
        containerName,
        ip,
        mode: "vm",
        sshReady,
      },
      rbacRef: rbacRef,
    };
  }

  // ── destroy ─────────────────────────────────────────────────────────

  async function destroy(id: string | number): Promise<void> {
    const name = String(id);
    log("info", "destroying container", { containerName: name });
    await dockerRun(["kill", name]).catch(() => {});
    await dockerRun(["rm", "-f", name]).catch(() => {});
    containers.delete(name);
  }

  // ── createBidConfig ─────────────────────────────────────────────────

  // Creates the com.publicdomainrelay.temp.compute.config.wif.simple record
  // that the bid advertises. Encodes the DO OIDC exchange parameters so the
  // VM can mint its own short-lived credentials without a long-lived secret.
  async function createBidConfig(nowIso: string): Promise<StrongRef> {
    const doctx = await makeDoctx();
    return atprotoCreateRecord(COMPUTE_CONFIG_WIF_SIMPLE_NSID, {
      $type: COMPUTE_CONFIG_WIF_SIMPLE_NSID,
      accept_path: acceptPathVm,
      issuer_uri: getIssuerUrl(),
      to_issue: "exchange-custom-droplet-oidc-poc",
      actx: getAgentDid(),
      actx_path: "/root/secrets/digitalocean.com/serviceaccount/team_uuid",
      token_path: "/root/secrets/digitalocean.com/serviceaccount/token",
      url_path: "/root/secrets/digitalocean.com/serviceaccount/base_url",
      url_route: "/v1/oidc/issue",
      subject: "actx:{actx}:plc:{did-plc-key}:role:{role}",
      createdAt: nowIso,
    });
  }

  // ── injectAcceptBundle ──────────────────────────────────────────────

  function injectAcceptBundle(
    userData: string,
    bundle: Record<string, unknown>,
  ): string {
    const ACCEPT_PATH_VM =
      "/root/secrets/publicdomainrelay.com/market/accept.json";
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

  // -- setup --

  async function configureRbac(agent: Agent, vm: VM, requesterDid: string): Promise<StrongRef> {
    const agentDidPlc = getAgentDid().requesterDid.split(":").slice(-1)[0];
    const requesterPlc = requesterDid.split(":").slice(-1)[0];
    const slug = `${agentDidPlc}-${requesterPlc}-${vm.role}`;
    const roleName = `ex-${slug}`;

    const rbacRecord = {
      $type: RBAC_NSID,
      protects: {
        [roleName]: {
          service: `${digitaloceanBaseUrl}`,
          scope: 'droplets.wid',
        }
      },
      roles: {
        [roleName]: {
          role_name: roleName,
          definition: {
            aud: `api://DigitalOcean?actx=${agentDidPlc}`,
            sub: `actx:${agentDidPlc}:plc:${requesterPlc}:role:${vm.role}`,
            policies: [roleName],
          },
        },
      },
      policies: {
        [roleName]: {
          meta: {
            policy: roleName,
          },
          schemas: {
            "/v1/oidc/issue": {
              type: "object",
              $schema: "http://json-schema.org/draft-07/schema#",
              required: ["capability", "allowed_parameters"],
              properties: {
                capability: {
                  enum: ["create"],
                },
                allowed_parameters: {
                  type: "object",
                  properties: {
                    aud: { type: "string" },
                    sub: {
                      type: "string",
                      const: `actx:${agentDidPlc}:plc:${requesterPlc}:role:${vm.role}`,
                    },
                    ttl: {
                      type: "number",
                      const: 3600,
                    },
                  },
                },
              },
            },
          },
        },
      },
      custom_claims_roles_index: {
        job_workflow_ref: {},
      },
      createdAt: new Date().toISOString(),
    };
    log("info", "creating rbac record", { nsid: RBAC_NSID });
    const rbacRef = await atprotoCreateRecord(RBAC_NSID, rbacRecord);
    log("info", "rbac record created", { nsid: RBAC_NSID, uri: rbacRef.uri });

    return rbacRef;
  }

  // Deletes a com.fedproxy.rbac record previously minted for a droplet, e.g.
  // when the droplet is torn down via a vm.delete event.
  async function deleteRbacRecord(rbacRef: StrongRef, reason: string): Promise<void> {
    const agent = getAgent();
    const { repo, collection, rkey } = parseAtUri(rbacRef.uri);
    log("info", "deleting rbac record", { uri: rbacRef.uri, cid: rbacRef.cid, repo, collection, rkey, agentDid: agent.assertDid, reason });
    try {
      const res = await agent.com.atproto.repo.deleteRecord({ repo, collection, rkey });
      log("info", "rbac record deleted", { uri: rbacRef.uri, reason, status: res.success, headers: res.headers });
    } catch (err) {
      log("error", "failed to delete rbac record", {
        uri: rbacRef.uri,
        repo,
        collection,
        rkey,
        reason,
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  // ── return ──────────────────────────────────────────────────────────

  return {
    name: "local",
    provision,
    destroy,
    createBidConfig,
    injectAcceptBundle,
    setup: undefined,
    teardown: undefined,
  };
}


export function createLocalComputeProvider(
  ctx: ComputeProviderLocalCtx,
): ComputeProvider {
  let issuerUrl = "";

  ctx.getIssuerUrl = () => {
    if (issuerUrl === "") {
      throw new Exception("xrpc relay not up yet")
    }
    return issuerUrl;
  }

  const {
    provision,
    destroy,
    createBidConfig,
    injectAcceptBundle,
    deleteRbacRecord,
    injectAcceptBundle,
  } = createComputeProviderLocal(ctx);

  const rbacByProvider = new Map<string | number, StrongRef>();

  return {
    name: "local",

    async provision(
      vm: VM,
      requesterDid: string,
      _spec?: DropletSpec,
    ): Promise<ProvisionResult> {
      const { providerId, metadata, rbacRef } = await provision(vm, requesterDid);
      rbacByProvider.set(providerId, rbacRef);
      return { providerId, metadata };
    },

    async destroy(id: string | number): Promise<void> {
      const rbacRef = rbacByProvider.get(id);
      if (rbacRef) {
        await deleteRbacRecord(rbacRef, "vm.delete event");
        rbacByProvider.delete(id);
      }
      await destroy(id);
    },

    createBidConfig,
    injectAcceptBundle,

    async setup(): Promise<void> {

/**
 * TODO Move this to lib/oidc-helper
 */

import * as jose from "npm:jose@5";
import { getJwkPem, saveJwkPem } from "./qemu/database.ts";

export class UnauthorizedException extends Error {
  constructor(msg: string) { super(msg); this.name = "UnauthorizedException"; }
}

export interface OIDCTokenData {
  actx: string;
  api: string;
  aud: string;
  sub: string;
  claims: Record<string, unknown>;
  asString: string;
}

// ---------------------------------------------------------------------------
// Signing key — loaded from DB or auto-generated once
// ---------------------------------------------------------------------------


// SECURITY: bound the default token lifetime. Previously tokens minted without an
// explicit `ttl` defaulted to 100 years (effectively non-expiring), so any leaked
// token stayed valid forever. Default to 24h; operators can tune via env.
const DEFAULT_TTL_SECONDS = Number(Deno.env.get("OIDC_DEFAULT_TTL_SECONDS") ?? 60 * 60 * 24);

// Returns true iff `sub` is scoped to `actx`. The subject format is
// `actx:<actx>[:role:...:...]`, so we require an exact match or an `actx:<actx>:`
// prefix rather than a loose substring test (which a crafted sub could satisfy).
export function subMatchesActx(sub: string | undefined, actx: string): boolean {
  if (!sub) return false;
  return sub === `actx:${actx}` || sub.startsWith(`actx:${actx}:`);
}

let _signingKey: CryptoKeyPair | null = null;
let _publicJwk: jose.JWK | null = null;

export async function getSigningKey(): Promise<CryptoKeyPair> {
  if (_signingKey) return _signingKey;

  const storedPem = getJwkPem(issuerUrl);
  if (storedPem) {
    const pemBody = storedPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
    const priv = await crypto.subtle.importKey(
      "pkcs8", der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true, ["sign"],
    );
    const jwk = await jose.exportJWK(priv);
    const pubJwk = { ...jwk, d: undefined, dp: undefined, dq: undefined, p: undefined, q: undefined, qi: undefined };
    const pub = await crypto.subtle.importKey(
      "jwk", pubJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true, ["verify"],
    );
    _signingKey = { privateKey: priv, publicKey: pub };
  } else {
    _signingKey = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pem = await jose.exportPKCS8(_signingKey.privateKey);
    saveJwkPem(issuerUrl, pem);
  }
  return _signingKey;
}

export async function getPublicJwk(): Promise<jose.JWK> {
  if (_publicJwk) return _publicJwk;
  const keys = await getSigningKey();
  const jwk = await jose.exportJWK(keys.publicKey);
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.kid = await jose.calculateJwkThumbprint(jwk);
  _publicJwk = jwk;
  return _publicJwk;
}

// ---------------------------------------------------------------------------
// JWKS cache for remote issuers
// ---------------------------------------------------------------------------

const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getRemoteJwks(jwksUri: string) {
  if (!jwksCache.has(jwksUri)) {
    jwksCache.set(jwksUri, jose.createRemoteJWKSet(new URL(jwksUri)));
  }
  return jwksCache.get(jwksUri)!;
}

// ---------------------------------------------------------------------------
// Audience parsing: "api://<api>?actx=<actx>"
// ---------------------------------------------------------------------------

export function parseAudience(aud: string): { actx: string; api: string } {
  const rest = aud.startsWith("api://") ? aud.slice(6) : null;
  if (!rest) throw new UnauthorizedException(`aud does not start with api://: ${aud}`);
  const qIdx = rest.indexOf("?");
  if (qIdx < 0) throw new UnauthorizedException(`aud missing ?actx=: ${aud}`);
  const api = rest.slice(0, qIdx);
  const params = new URLSearchParams(rest.slice(qIdx + 1));
  const actx = params.get("actx");
  if (!actx) throw new UnauthorizedException(`aud missing actx param: ${aud}`);
  return { actx, api };
}

// ---------------------------------------------------------------------------
// OIDCToken
// ---------------------------------------------------------------------------

export class OIDCToken implements OIDCTokenData {
  actx!: string;
  api!: string;
  aud!: string;
  sub!: string;
  claims!: Record<string, unknown>;
  asString!: string;

  private constructor(data: OIDCTokenData) {
    Object.assign(this, data);
  }

  static async create(
    actx: string,
    claims: Record<string, unknown>,
    api = "DigitalOcean",
  ): Promise<OIDCToken> {
    const keys = await getSigningKey();
    const jwk = await getPublicJwk();
    let audience = `api://${api}?actx=${actx}`;

    const sub = claims["sub"] as string | undefined;
    if (!subMatchesActx(sub, actx)) {
      throw new Error(`'actx:${actx}' not found in sub '${sub}'`);
    }

    const payload = { ...claims };
    delete payload["ttl"];

    let expTime: string | number;
    if (typeof claims["ttl"] === "number") {
      expTime = Math.floor(Date.now() / 1000) + (claims["ttl"] as number);
    } else {
      expTime = Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS;
    }

    if (typeof claims["aud"] === "string") {
      audience = claims["aud"]
    }

    const token = await new jose.SignJWT(payload as jose.JWTPayload)
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(issuerUrl)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expTime)
      .sign(keys.privateKey);

    return new OIDCToken({
      actx,
      api,
      aud: audience,
      sub: sub!,
      claims: { ...payload, iss: issuerUrl, aud: audience },
      asString: token,
    });
  }

  static async validate(
    token: string,
    getIssuers?: (api: string, actx: string) => Promise<string[]> | string[],
  ): Promise<OIDCToken> {
    if (!token || token === "0") throw new UnauthorizedException("Unable to authenticate you, no token");
    if (token.split(".").length !== 3) throw new UnauthorizedException("Invalid token");

    // Peek at unverified payload to extract actx + api from aud
    const unverified = jose.decodeJwt(token);
    const rawAud = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud as string;
    const { actx, api } = parseAudience(rawAud ?? "");
    const expectedAud = `api://${api}?actx=${actx}`;

    const ownIssuers = [issuerUrl];
    const extraIssuers = getIssuers ? await getIssuers(api, actx) : [];
    const issuers = [...new Set([...ownIssuers, ...extraIssuers])];

    let lastErr: Error = new Error("no issuers");
    for (const issuer of issuers) {
      try {
        let jwks: jose.JWTVerifyGetKey;
        if (issuer === issuerUrl) {
          const keys = await getSigningKey();
          jwks = keys.publicKey as unknown as jose.JWTVerifyGetKey;
        } else {
          const openidConfig = await fetch(`${issuer}/.well-known/openid-configuration`).then((r) => r.json()) as { jwks_uri: string };
          jwks = getRemoteJwks(openidConfig.jwks_uri);
        }

        const { payload } = await jose.jwtVerify(token, jwks, {
          issuer,
          audience: expectedAud,
        });

        return new OIDCToken({
          actx,
          api,
          aud: expectedAud,
          sub: payload.sub!,
          claims: payload as Record<string, unknown>,
          asString: token,
        });
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw new UnauthorizedException(`OIDC token failed validation: ${lastErr.message}`);
  }
}

/**
 * TODO Move this to lib/rbac-helper
 */

import { OIDCToken, UnauthorizedException, parseAudience } from "./oidc_helper.ts";
import { IdResolver } from '@atproto/identity';
import { verifyJwt } from '@atproto/xrpc-server'
import * as jose from "npm:jose@5";

function log(
  level: "info" | "error" | "warn",
  msg: string,
  extra?: Record<string, unknown>,
) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  Deno.stderr.writeSync(new TextEncoder().encode(JSON.stringify(entry) + "\n"));
}

// ---------------------------------------------------------------------------
// Shared auth token shape returned by both OIDC and ATProto paths
// ---------------------------------------------------------------------------

export interface AuthToken {
  sub: string;
  actx: string;
  asString: string;
  claims: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ATProto types
// ---------------------------------------------------------------------------

interface RBACPolicy {
  meta: Record<string, string>;
  schemas: Record<string, RBACSchema>;
}

interface RBACSchema {
  properties: {
    capability: { enum: string[] };
    body?: unknown;
  };
}

interface RBACRoleDefinition {
  iss: string;
  aud?: string;
  sub: string;
  policies: string[];
}

interface RBACRole {
  role_name: string;
  definition: RBACRoleDefinition;
}

interface RBACProtects {
  service: string;
  scope?: string;
}

interface RBACRecord {
  protects: Record<string, RBACProtects>;
  policies: Record<string, RBACPolicy>;
  roles: Record<string, RBACRole>;
}

interface ServiceAllowlistRecord {
  protects: Record<string, RBACProtects>;
  allowed: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// DID resolution
// ---------------------------------------------------------------------------

interface DIDDocument {
  service?: { id: string; type: string; serviceEndpoint: string }[];
  verificationMethod?: { id: string; type: string; publicKeyJwk?: jose.JWK; publicKeyMultibase?: string }[];
}

async function resolveDIDDoc(did: string): Promise<DIDDocument> {
  let res: Response;
  if (did.startsWith("did:plc:")) {
    res = await fetch(`https://plc.directory/${did}`);
  } else if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).replace(/:/g, "/");
    res = await fetch(`https://${host}/.well-known/did.json`);
  } else {
    throw new Error(`unsupported DID method: ${did}`);
  }
  if (!res.ok) throw new Error(`DID resolution failed for ${did}: ${res.status}`);
  return await res.json() as DIDDocument;
}

async function resolvePDS(did: string): Promise<string> {
  let didDoc: { service?: { id: string; type: string; serviceEndpoint: string }[] };

  if (did.startsWith("did:plc:")) {
    const res = await fetch(`https://plc.directory/${did}`);
    if (!res.ok) throw new Error(`plc.directory lookup failed for ${did}: ${res.status}`);
    didDoc = await res.json();
  } else if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).replace(/:/g, "/");
    const res = await fetch(`https://${host}/.well-known/did.json`);
    if (!res.ok) throw new Error(`did:web lookup failed for ${did}: ${res.status}`);
    didDoc = await res.json();
  } else {
    throw new Error(`unsupported DID method: ${did}`);
  }

  const pds = didDoc.service?.find(
    (s) => s.type === "AtprotoPersonalDataServer" || s.id === "#atproto_pds",
  )?.serviceEndpoint;
  if (!pds) throw new Error(`no PDS in DID document for ${did}`);
  return pds;
}

// Initialize the official ATProto Identity Resolver.
// This handles caching, did:plc resolution (via plc.directory), and did:web resolution.
const idResolver = new IdResolver();

// Derive did:web: from the service base URL for use as getServiceAuth aud.
function urlToDid(url: string): string {
  const host = new URL(url).host;
  return `did:web:${host}`;
}

// ---------------------------------------------------------------------------
// ATProto service auth JWT validation (non-OIDC)
// Validates com.atproto.server.getServiceAuth tokens against DID doc keys.
// ---------------------------------------------------------------------------
export async function validateATProtoServiceAuth(
  token: string,
  service: string,
): Promise<{ iss: string; sub: string; payload: jose.JWTPayload }> {
  // 1. Parse token quickly to read the issuer (iss)
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new UnauthorizedException("Invalid JWT format");
  }

  const payloadJson = JSON.parse(
    new TextDecoder().decode(jose.base64url.decode(parts[1]))
  );
  const iss = payloadJson.iss as string | undefined;
  if (!iss || !iss.startsWith("did:")) {
    throw new UnauthorizedException("ATProto service auth token must have DID iss");
  }

  const aud = urlToDid(service);
  log("info", "aud", { aud: aud, service: service, payloadJson: payloadJson });

  try {
    // 2. Resolve the DID Document & verify the signature using @atproto/identity.
    // verifyJwt handles:
    //   - Resolving the DID Document (using plc.directory or did:web lookup)
    //   - Safely parsing publicKeyMultibase (secp256k1/k256, ed25519) and publicKeyJwk formats
    //   - Cryptographically verifying the token signature
    const payload = await verifyJwt(token, aud, null,  async (did) => {
      const didDoc = await idResolver.did.resolveAtprotoKey(did);
      return didDoc; // Returns the verification key string directly
    });

    // 3. Extract subject (sub) and return
    const sub = ((payload as Record<string, unknown>).sub as string | undefined) ?? iss;
    return { iss, sub, payload };
  } catch (error: any) {
    throw new UnauthorizedException(
      `ATProto JWT validation failed: ${error.message || error}`
    );
  }
}

// ---------------------------------------------------------------------------
// com.fedproxy.rbac record fetch (paginated)
// ---------------------------------------------------------------------------

async function getRBACRecord(pdsURL: string, did: string, service: string, scope: string): Promise<RBACRecord> {
  const joined: RBACRecord = { protects: {}, policies: {}, roles: {} };
  let cursor = "";
  let total = 0;

  let anyProtects = false;
  for (;;) {
    const url = new URL(`${pdsURL}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", "com.fedproxy.rbac");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`listRecords failed pds=${pdsURL} did=${did}: ${res.status}`);

    const out = await res.json() as { records: { uri: string; value: RBACRecord }[]; cursor?: string };

    for (const rec of out.records ?? []) {
      const rbac = rec.value;
      let protectsThis = false;
      for (const [name, protects] of Object.entries(rbac.protects ?? {})) {
        if (protects.service === service || protects.service === "*") {
          if (protects.scope === scope || protects.scope === "*") {
            protectsThis = true;
          }
          break;
        }
      }
      if (protectsThis !== true) {
        continue;
      } else {
        anyProtects = true;
      }
      for (const [name, policy] of Object.entries(rbac.policies ?? {})) {
        joined.policies[name] = policy;
      }
      for (const [name, role] of Object.entries(rbac.roles ?? {})) {
        joined.roles[name] = role;
      }
      total++;
    }

    if (!out.cursor) break;
    cursor = out.cursor;
  }

  if (anyProtects === false) throw new Error(`no com.fedproxy.rbac records found which protect for did=${did} service=${service} scope=${scope}`);

  if (total === 0) throw new Error(`no com.fedproxy.rbac record found for did=${did}`);
  return joined;
}

// ---------------------------------------------------------------------------
// com.publicdomainrelay.temp.auth.allowlist.rbacDid record fetch (paginated)
// Lets a service operator restrict which issuer DIDs may call a given
// service+scope, independent of the issuer's own RBAC grant.
// ---------------------------------------------------------------------------

async function getServiceAllowlist(pdsURL: string, did: string, service: string, scope: string): Promise<ServiceAllowlistRecord> {
  const joined: ServiceAllowlistRecord = { protects: {}, allowed: {} };
  let cursor = "";
  let total = 0;

  let anyProtects = false;
  for (;;) {
    const url = new URL(`${pdsURL}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", "com.publicdomainrelay.temp.auth.allowlist.rbacDid");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`listRecords failed pds=${pdsURL} did=${did}: ${res.status}`);

    const out = await res.json() as { records: { uri: string; value: ServiceAllowlistRecord }[]; cursor?: string };

    for (const rec of out.records ?? []) {
      const allowlist = rec.value;
      let protectsThis = false;
      for (const [name, protects] of Object.entries(allowlist.protects ?? {})) {
        if (protects.service === service || protects.service === "*") {
          if (protects.scope === scope || protects.scope === "*") {
            protectsThis = true;
          }
          break;
        }
      }
      if (protectsThis !== true) {
        continue;
      } else {
        anyProtects = true;
      }
      for (const [name, dids] of Object.entries(allowlist.allowed ?? {})) {
        joined.allowed[name] = dids;
      }
      total++;
    }

    if (!out.cursor) break;
    cursor = out.cursor;
  }

  if (anyProtects === false) throw new Error(`no com.publicdomainrelay.temp.auth.allowlist.rbacDid records found which protect for did=${did} service=${service} scope=${scope}`);

  if (total === 0) throw new Error(`no com.publicdomainrelay.temp.auth.allowlist.rbacDid record found for did=${did}`);
  return joined;
}

function checkAllowedToUseService(
  allowlist: ServiceAllowlistRecord,
  iss: string,
): void {
  for (const dids of Object.values(allowlist.allowed)) {
    if (dids.includes(iss)) return;
  }
  throw new UnauthorizedException(`unable to authorize: issuer ${iss} is not on the operator's service allowlist`);
}

// ---------------------------------------------------------------------------
// Issuer collection (mirrors collectIssuers in main.go)
// ---------------------------------------------------------------------------

function collectIssuers(rbac: RBACRecord): string[] {
  const seen = new Set<string>();
  for (const role of Object.values(rbac.roles)) {
    const iss = role.definition.iss;
    if (iss) seen.add(iss);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Path glob matching (mirrors globMatch in main.go / find_matching_schema_for_path)
// ---------------------------------------------------------------------------

function globMatch(pattern: string, s: string): boolean {
  if (pattern === "*") return true;
  const parts = pattern.split("*");
  let rest = s;
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts[i];
    if (i === parts.length - 1) return prefix === "" ? true : rest.endsWith(prefix);
    if (prefix.length > 0) {
      const idx = rest.indexOf(prefix);
      if (idx < 0) return false;
      rest = rest.slice(idx + prefix.length);
    }
  }
  return true;
}

function findMatchingSchema(schemas: Record<string, RBACSchema>, path: string): RBACSchema | null {
  if (schemas[path]) return schemas[path];
  let best = "";
  let bestSchema: RBACSchema | null = null;
  for (const [pattern, schema] of Object.entries(schemas)) {
    if (globMatch(pattern, path) && pattern.length > best.length) {
      best = pattern;
      bestSchema = schema;
    }
  }
  return bestSchema;
}

// ---------------------------------------------------------------------------
// Policy check (mirrors checkRBACPolicy in main.go + check_permissions in hcl_policy.py)
// ---------------------------------------------------------------------------

const HTTP_METHOD_CAPABILITY: Record<string, string> = {
  GET: "read", HEAD: "read", OPTIONS: "read",
  POST: "create", PUT: "update", PATCH: "update", DELETE: "delete",
};

export function checkRBACPolicy(
  rbac: RBACRecord,
  sub: string,
  path: string,
  method: string,
  reqJson?: unknown,
): void {
  const capability = HTTP_METHOD_CAPABILITY[method.toUpperCase()];
  if (!capability) throw new UnauthorizedException(`unsupported HTTP method ${method}`);

  const matchingPolicies: string[] = [];
  for (const role of Object.values(rbac.roles)) {
    if (role.definition.sub === sub) {
      matchingPolicies.push(...role.definition.policies);
    }
  }

  if (matchingPolicies.length === 0) {
    throw new UnauthorizedException(`no matching role found for sub: ${sub}`);
  }

  const denials: string[] = [];
  for (const policyName of matchingPolicies) {
    const policy = rbac.policies[policyName];
    if (!policy) continue;

    const schema = findMatchingSchema(policy.schemas, path);
    if (!schema) continue;

    const allowed = schema.properties.capability.enum;
    if (allowed.includes(capability)) return; // permitted

    denials.push(`policy '${policyName}': capability '${capability}' not in [${allowed.join(", ")}] for path '${path}'`);
  }

  if (denials.length > 0) throw new UnauthorizedException(denials.join("; "));
  throw new UnauthorizedException(`no policy covers path='${path}' for sub='${sub}'`);
}

// ---------------------------------------------------------------------------
// OIDC flow: raiseIfUnauthorized (scope: droplets.wid, /v1/oidc/issue)
// ---------------------------------------------------------------------------

export async function raiseIfUnauthorized(
  service: string,
  scope: string,
  token: string,
  path: string,
  method: string,
  reqJson?: unknown,
): Promise<AuthToken> {
  const unverifiedPayload = (() => {
    try {
      const [, payloadB64] = token.split(".");
      return JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return {};
    }
  })();

  const rawAud = Array.isArray(unverifiedPayload.aud)
    ? unverifiedPayload.aud[0]
    : unverifiedPayload.aud as string ?? "";

  let rbac: RBACRecord | null = null;
  let getIssuers: ((api: string, actx: string) => Promise<string[]>) | undefined;

  let { actx, api } = parseAudience(rawAud);
  if (actx.includes(".")) {
    // did:web:
    actx = "did:web:" + actx
  } else {
    // did:plc:
    actx = "did:plc:" + actx
  }

  try {
    const pdsURL = await resolvePDS(actx);
    rbac = await getRBACRecord(pdsURL, actx, service, scope);
    const issuers = collectIssuers(rbac);
    getIssuers = async (_api: string, _actx: string) => issuers;
    void api;
  } catch (err) {
    // SECURITY: fail closed. This previously returned an empty AuthToken (`{}`),
    // which made the calling middleware treat the request as authorized while
    // skipping BOTH OIDC token validation AND the RBAC policy check below — an
    // authentication/authorization bypass on the privileged /v1/oidc/issue
    // endpoint (which mints OIDC tokens that grant droplet creation). If we
    // cannot resolve the actx DID or load its com.fedproxy.rbac record, we have
    // no basis on which to authorize the caller, so deny the request.
    log("error", "failed to lookup rbac record", { actx: actx, err: String(err) });
    throw new UnauthorizedException(`unable to authorize: rbac lookup failed for actx=${actx}: ${String(err)}`);
  }

  const oidcToken = await OIDCToken.validate(token, getIssuers);

  if (rbac) {
    checkRBACPolicy(rbac, oidcToken.sub, path, method, reqJson);
  }

  return oidcToken as AuthToken;
}

// ---------------------------------------------------------------------------
// ATProto service auth flow: raiseIfUnauthorizedServiceAuth
// (scope: account.auth, /v2/account + /v2/droplets*)
// Tokens are com.atproto.server.getServiceAuth JWTs: iss=DID, validated via
// DID document verificationMethod keys — no OIDC discovery used.
// ---------------------------------------------------------------------------

export async function raiseIfUnauthorizedServiceAuth(
  service: string,
  scope: string,
  // Source from OPERATOR_HANDLE env var somewhere up call stack
  operatorHandle: string,
  token: string,
  path: string,
  method: string,
): Promise<AuthToken> {
  // Get the incoming token data
  const { iss, sub, payload } = await validateATProtoServiceAuth(token, service);

  // Check if the OPERATOR_HANDLE trusts the token via our allowlist
  let operatorDid = operatorHandle;
  if (!operatorDid.startsWith("did:")) {
    const resolved = await idResolver.handle.resolve(operatorHandle);
    if (!resolved) throw new UnauthorizedException(`unable to resolve operator handle: ${operatorHandle}`);
    operatorDid = resolved;
  }
  const operatorPdsURL = await resolvePDS(operatorDid);
  // checkAllowedToUseService calls listRecords for
  // com.publicdomainrelay.temp.auth.allowlist.rbacDid
  // where each record has properties protects{service, scope} and allowed:
  // [dids], join together similar to RBACRecord and validate that the iss is a
  // did which the operator of this service wants to be able to call routes here
  const allowlist = await getServiceAllowlist(operatorPdsURL, operatorDid, service, scope);
  checkAllowedToUseService(allowlist, iss);

  // Check if the token issuer wants to enable their token to access these
  // routes
  const pdsURL = await resolvePDS(iss);
  const rbac = await getRBACRecord(pdsURL, iss, service, scope);
  checkRBACPolicy(rbac, sub, path, method);
  let actx = iss;
  if (actx.includes(":")) {
    const actxSplit = actx.split(":")
    actx = actxSplit[actxSplit.length - 1];
  }
  const result = { sub, actx: actx, asString: token, claims: payload as Record<string, unknown> };
  log("info", "raiseIfUnauthorizedServiceAuth.result", result);
  return result;
}
      /* TODO start xrpc relay for workload identity */
      /* TODO move the followin into hono-factory-workload-identity-droplet-oidc-poc */
      const app = new Hono<{ Variables: { authToken: AuthToken } }>();

      app.use('*', cors());

      // request logger — opens a per-request log context so every line emitted while
      // handling this request carries the caller DID (set after auth) and the
      // originating principal forwarded by the caller (the market.accept author).
      app.use("*", (c, next) => {
        const onBehalfOfDid = c.req.header(ON_BEHALF_OF_HEADER) || undefined;
        return runWithLogContext({ onBehalfOfDid }, async () => {
          log("info", "request", { method: c.req.method, path: c.req.path });
          await next();
        });
      });

      // GET /.well-known/openid-configuration
      app.get("/.well-known/openid-configuration", async (c) => {
        const jwk = await getPublicJwk();
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


      app.use("/v1/oidc/issue", async (c, next) => {
        try {
          const token = extractBearer(c.req.header("Authorization"));
          const authToken = await raiseIfUnauthorized(issuerUrl, "droplets.wid", token, "/v1/oidc/issue", c.req.method);
          c.set("authToken", authToken);
          // The validated token's actx is the caller DID performing this operation.
          setLogContext({ actorDid: authToken.actx });
          await next();
        } catch (err) {
          log("warn", "rbac denied /v1/oidc/issue", { error: String(err) });
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

      // Warm up signing key (loads from DB or generates + persists)
      await getSigningKey();
      const jwk = await getPublicJwk();
      log("info", "miniCloud listening", { port: PORT, issuer: issuerUrl, kid: jwk.kid });

      // ── XRPC relay (optional) ─────────────────────────────────────────
      // Enabled when --write-xrpc-relay-generated-issuer-to <path> is passed.
      // Connects to the fedproxy relay, registers a did:web identity, and writes
      // it to the given path once live. Requests proxied through the relay are
      // dispatched into the existing Hono app via createSubscriberFactory.
      let relayController: ReturnType<typeof runSubscriber> | undefined;
      if (XRPC_RELAY_ENABLED) {
        const PRIVATE_KEY_HEX = Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
        const relayKeypair = PRIVATE_KEY_HEX
          ? await Secp256k1Keypair.import(PRIVATE_KEY_HEX)
          : await Secp256k1Keypair.create({ exportable: true });

        const relaySigner: Signer = {
          did: () => relayKeypair.did(),
          sign: (bytes) => relayKeypair.sign(bytes),
        };

        // Use the existing Hono app for relay request dispatch. The relay
        // registration mints a did:web identity; requests proxied through the
        // relay arrive as #request frames and are dispatched via app.fetch().

        const { handleRequest } = createSubscriberFactory({ app });

        const dispatcherDid = `did:web:${DISPATCHER_HOST}`;
        async function getServiceAuthToken(lxm: string): Promise<string> {
          return await signServiceAuth(relaySigner, { aud: dispatcherDid, lxm });
        }

        relayController = runSubscriber({
          label: "qemu",
          keypair: relayKeypair,
          getServiceAuthToken,
          dispatcherHost: DISPATCHER_HOST,
          handleRequest,
          subscribe: undefined,
          onLog: (e) => log("info", `xrpc-relay: ${e.message}`, { severity: e.severity }),
          onRegistered: async (info) => {
            log("info", "xrpc-relay registered", { subdomain: info.subdomain, proxyRef: info.proxyRef });
            // Derive this qemu's external identity from the relay proxyRef so
            // service-auth JWT validation (aud == service did) passes when
            // callers reach us through the relay at https://<subdomain>.<host>.
            const proxyHost = info.proxyRef.replace(/^did:web:/, "");
            const baseUrl = `https://${proxyHost}`;
            Deno.env.set("ISSUER_URL", baseUrl);
            Deno.env.set("THIS_ENDPOINT", baseUrl);
            issuerUrl = baseUrl;
            log("info", "xrpc-relay issuer url updated", { baseUrl });
            // Write did:web to the requested path so external tooling can discover it.
            try {
              await Deno.writeTextFile(XRPC_RELAY_ISSUER_PATH!, `${info.proxyRef}\n`);
              log("info", "xrpc-relay issuer written", { path: XRPC_RELAY_ISSUER_PATH, proxyRef: info.proxyRef });
            } catch (err) {
              log("error", "xrpc-relay failed to write issuer", { path: XRPC_RELAY_ISSUER_PATH, error: String(err) });
            }
          },
          onSubscriptionOpen: (sub) => log("info", "xrpc-relay subscription open", { subscriptionId: sub.subscriptionId, nsid: sub.nsid }),
          onStatus: (status) => log("info", "xrpc-relay status", { status }),
        });

        log("info", "xrpc-relay connecting", { dispatcherHost: DISPATCHER_HOST });
      }
    },

    async teardown(): Promise<void> {
      /* TODO stop xrpc relay */
      // stop the relayController
    },
  };
}
