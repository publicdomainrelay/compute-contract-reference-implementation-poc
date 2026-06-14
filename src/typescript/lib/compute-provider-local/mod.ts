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


      app.use("/v1/oidc/issue", async (c, next) => {
        try {
          const token = extractBearer(c.req.header("Authorization"));
          const issuerUrl = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? `http://localhost:${PORT}`;
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
