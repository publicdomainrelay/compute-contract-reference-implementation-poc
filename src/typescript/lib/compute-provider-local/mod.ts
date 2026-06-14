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
  /** "container" (lightweight, no KVM) or "vm" (QEMU). Default: "container". */
  containerMode?: "vm" | "container";
  /** Docker image for QEMU VMs. */
  vmImage?: string;
  /** Docker image for container mode. */
  containerImage?: string;
  /** Cache directory. Default: ~/.cache/pdr-local. */
  cacheDir?: string;
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
  ds: DropletSpec,
  cacheDir: string,
  vmImage: string,
  log: ComputeProviderCtx["log"],
): Promise<{ ip: string; sshReady: boolean }> {
  log("info", "provisioning VM", { containerName, image: vmImage });

  await pullImage(vmImage, log);

  const udFile = `${cacheDir}/ud-${containerName}.yaml`;
  await Deno.writeTextFile(udFile, vm.user_data);

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

export function createLocalComputeProvider(
  ctx: ComputeProviderLocalCtx,
): ComputeProvider {
  const { log, parseAtUri, createRecord } = ctx;
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

  // ── provision ───────────────────────────────────────────────────────

  async function provision(
    vm: VM,
    requesterDid: string,
    spec?: DropletSpec,
  ): Promise<ProvisionResult> {
    const ds = spec ?? dropletSpecFromEnv();
    const requesterPlc = requesterDid.split(":").pop() ?? "unknown";
    const rfpRkey = (vm._uri ?? "").split("/")[4] ?? "unknown";
    const containerName = `pdr-${requesterPlc}-${rfpRkey}-${shortUuid()}`;

    await Deno.mkdir(cacheDir, { recursive: true });

    if (containerMode === "container") {
      // Container path — cloud-init + sshd directly in Docker (no KVM needed).
      // Uses runContainer which handles entrypoint generation, systemctl-shim
      // mount, image auto-build, and SSH polling.
      log("info", "provisioning container", {
        containerName,
        image: containerImage,
      });

      const info = await runContainer(vm.user_data, {
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

  async function createBidConfig(nowIso: string): Promise<StrongRef> {
    return createRecord(COMPUTE_CONFIG_WIF_SIMPLE_NSID, {
      $type: COMPUTE_CONFIG_WIF_SIMPLE_NSID,
      provider: "local",
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

  // ── return ──────────────────────────────────────────────────────────

  return {
    name: "local",
    provision,
    destroy,
    createBidConfig,
    injectAcceptBundle,
    setupAuth: undefined,
    teardownAuth: undefined,
  };
}
