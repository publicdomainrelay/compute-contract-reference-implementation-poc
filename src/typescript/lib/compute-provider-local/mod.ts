// compute-provider-local — provisions Docker containers (QEMU VMs or light
// cloud-init+sshd containers) on the local host. Implements ComputeProvider
// so the bidder never branches on "where to provision".
//
// Unlike the DigitalOcean provider (which talks to a remote DO-compatible API),
// the local provider also *hosts* the workload-identity OIDC issuer itself: its
// setup()/teardown() stand up the issuer Hono app + XRPC relay
// (@publicdomainrelay/hono-factory-workload-identity-droplet-oidc-poc), and
// provision() mints the per-droplet com.fedproxy.rbac record + injects the OIDC
// provisioning exchange so a container can prove itself and mint scoped tokens.
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
import {
  configureOidc,
  getPublicJwk,
  getSigningKey,
} from "@publicdomainrelay/oidc-helper";
import { createWorkloadIdentityDropletOidcPoc } from "@publicdomainrelay/hono-factory-workload-identity-droplet-oidc-poc";
import {
  configureProvisioning,
  ProvisioningData,
} from "@publicdomainrelay/hono-factory-workload-identity-droplet-oidc-poc/provisioning";
import type { NonceStore } from "@publicdomainrelay/hono-factory-workload-identity-droplet-oidc-poc/provisioning";

// ── types ───────────────────────────────────────────────────────────────

export interface ComputeProviderLocalCtx extends ComputeProviderCtx {
  /** Path the accept bundle is written to inside the VM. Default: DEFAULT_ACCEPT_PATH_VM. */
  acceptPathVm?: string;
  /** "container" (lightweight, no KVM) or "vm" (QEMU). Default: "container". */
  containerMode?: "vm" | "container";
  /** Docker image for QEMU VMs. */
  vmImage?: string;
  /** Docker image for container mode. */
  containerImage?: string;
  /** Cache directory. Default: ~/.cache/pdr-local. */
  cacheDir?: string;
  /** Bind the issuer Hono app to a local HTTP port (PORT) in setup(). Default: false. */
  serveHttp?: boolean;
  /** Serve the issuer via the fedproxy XRPC relay in setup() (its real transport). Default: true. */
  xrpcRelay?: boolean;
  /** This provider's own DID (the RBAC actx / "team", mirroring DO's teamUuid). */
  getAgentDid: () => string;
  /** Gets the xrpc relay url for the hono-factory-workload-identity-droplet-oidc-poc. */
  getIssuerUrl: () => string;
  /** Creates an atproto record in the provider's repo (for createBidConfig + RBAC). */
  createRecord: (
    collection: string,
    record: Record<string, unknown>,
  ) => Promise<StrongRef>;
  /** Deletes an atproto record from the provider's repo (for RBAC teardown). */
  deleteRecord?: (collection: string, rkey: string) => Promise<void>;
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

// Default path the accept bundle is written to inside the provisioned VM.
const DEFAULT_ACCEPT_PATH_VM =
  "/root/secrets/publicdomainrelay.com/market/accept.json";

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

export async function dockerInspectIp(containerName: string): Promise<string> {
  const { code, stdout } = await dockerRun([
    "inspect", "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    containerName,
  ]);
  if (code !== 0) throw new Error(`docker inspect failed for ${containerName}`);
  return stdout;
}

export async function pollSsh(
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
RUN dnf upgrade -y \\
  && dnf install -y \\
    cloud-init openssh-server sudo curl jq util-linux rsyslog vim tmux git unzip python3 \\
  && dnf clean all`
    : `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get upgrade -y && apt-get install -y \\
    cloud-init openssh-server openssh-client openssh-sftp-server sudo curl jq util-linux rsyslog vim tmux git unzip ca-certificates locales python3
RUN echo "datasource_list: [NoCloud]" > /etc/cloud/cloud.cfg.d/99-datasource.cfg`;

  return `${base}
ARG DENO_VERSION=v2.9.2
RUN _arch=\$(uname -m) && case "\$_arch" in x86_64|amd64) _arch=x86_64 ;; aarch64|arm64) _arch=aarch64 ;; esac && \\
    curl -fsSL "https://dl.deno.land/release/\${DENO_VERSION}/deno-\${_arch}-unknown-linux-gnu.zip" -o /tmp/deno.zip && \\
    unzip -d /usr/local/bin /tmp/deno.zip && \\
    rm /tmp/deno.zip
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
`;
}

// ── image building ───────────────────────────────────────────────────────

export async function buildContainerImage(
  distro: Distro = "ubuntu",
  opts: { force?: boolean } = {},
): Promise<string> {
  const tag = imageTag(distro);

  if (!opts.force && await imageExists(tag)) {
    console.log(`==> Image ${tag} already exists. Skipping build.`);
    return tag;
  }
  if (opts.force) console.log(`==> Force-rebuilding ${tag}...`);

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

// Port the issuer Hono app listens on locally (the XRPC relay also dispatches
// into the same app).
const PORT = Number(Deno.env.get("PORT") ?? 8080);

// RBAC record NSID — the per-provision workload-identity grant (mirrors the DO
// provider's com.fedproxy.rbac).
const RBAC_NSID = "com.fedproxy.rbac";

// Minimal droplet record the issuer's /v1/oidc/prove route resolves by id.
interface LocalDroplet {
  id: string;
  name: string;
  networks: { v4: { ip_address: string; type: string }[] };
  tags: string[];
  containerName?: string;
}

// ---------------------------------------------------------------------------
// Inner factory — RBAC-aware local provisioning + the helpers the
// ComputeProvider adapter composes. Mirrors createComputeProviderDigitalOcean
// but provisions via local Docker (runContainer / provisionVM) and mints the
// com.fedproxy.rbac record as an atproto record instead of a git push.
// ---------------------------------------------------------------------------

export function createComputeProviderLocal(ctx: ComputeProviderLocalCtx) {
  const { log, parseAtUri, getAgentDid, getIssuerUrl, createRecord, deleteRecord } = ctx;
  const acceptPathVm = ctx.acceptPathVm ?? DEFAULT_ACCEPT_PATH_VM;
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

  // Shared droplet registry — provision() populates it; the issuer's
  // /v1/oidc/prove route (started in setup()) reads it to resolve a container.
  const droplets = new Map<string, LocalDroplet>();

  // Shared nonce store — ProvisioningData injects a nonce here at provision
  // time; the prove route consumes it (one-shot).
  const nonceStore: NonceStore = (() => {
    const m = new Map<string, string>();
    return {
      createProvisioningNonce: (nonce, id) => { m.set(nonce, id); },
      getProvisioningNonceDropletId: (nonce) => {
        const id = m.get(nonce);
        if (id === undefined) throw new Error(`Nonce ${nonce} not found`);
        m.delete(nonce);
        return id;
      },
    };
  })();

  // ── RBAC ────────────────────────────────────────────────────────────

  // Mints the per-provision com.fedproxy.rbac grant in the PROVIDER's repo,
  // mirroring compute-provider-digitalocean's configureDropletRbac (which writes
  // the equivalent HCL role+policy to the provider's git RBAC repo). The actx is
  // the provider (getAgentDid), matching DO's teamUuid: the VM's provisioning
  // token carries this actx, and /v1/oidc/issue authorizes against this repo.
  async function configureRbac(vm: VM, requesterDid: string): Promise<StrongRef> {
    const agentDidPlc = getAgentDid().split(":").slice(-1)[0];
    const requesterPlc = requesterDid.split(":").slice(-1)[0];
    const serviceBaseUrl = getIssuerUrl();
    const slug = `${agentDidPlc}-${requesterPlc}-${vm.role}`;
    const roleName = `ex-${slug}`;
    const subject = `actx:${agentDidPlc}:plc:${requesterPlc}:role:${vm.role}`;

    const rbacRecord = {
      $type: RBAC_NSID,
      protects: {
        [roleName]: { service: serviceBaseUrl, scope: "droplets.wid" },
      },
      roles: {
        [roleName]: {
          role_name: roleName,
          definition: {
            aud: `api://DigitalOcean?actx=${agentDidPlc}`,
            sub: subject,
            policies: [roleName],
          },
        },
      },
      policies: {
        [roleName]: {
          meta: { policy: roleName },
          schemas: {
            "/v1/oidc/issue": {
              type: "object",
              $schema: "http://json-schema.org/draft-07/schema#",
              required: ["capability", "allowed_parameters"],
              properties: {
                capability: { enum: ["create"] },
                allowed_parameters: {
                  type: "object",
                  properties: {
                    aud: { type: "string" },
                    sub: { type: "string", const: subject },
                    ttl: { type: "number", const: 3600 },
                  },
                },
              },
            },
          },
        },
      },
      custom_claims_roles_index: { job_workflow_ref: {} },
      createdAt: new Date().toISOString(),
    };
    log("info", "creating rbac record", { nsid: RBAC_NSID, roleName, sub: subject });
    const rbacRef = await createRecord(RBAC_NSID, rbacRecord);
    log("info", "rbac record created", { nsid: RBAC_NSID, uri: rbacRef.uri });
    return rbacRef;
  }

  // Deletes a com.fedproxy.rbac record minted for a droplet, on vm.delete /
  // teardown (mirrors DO's deleteRbacRecord).
  async function deleteRbacRecord(rbacRef: StrongRef, reason: string): Promise<void> {
    if (!deleteRecord) {
      log("warn", "no deleteRecord configured; skipping rbac delete", { uri: rbacRef.uri, reason });
      return;
    }
    const { collection, rkey } = parseAtUri(rbacRef.uri);
    log("info", "deleting rbac record", { uri: rbacRef.uri, collection, rkey, reason });
    try {
      await deleteRecord(collection, rkey);
      log("info", "rbac record deleted", { uri: rbacRef.uri, reason });
    } catch (err) {
      log("error", "failed to delete rbac record", { uri: rbacRef.uri, reason, err: String(err) });
    }
  }

  // ── provision ───────────────────────────────────────────────────────

  async function provisionLocal(
    vm: VM,
    requesterDid: string,
    spec?: DropletSpec,
  ): Promise<{ result: ProvisionResult; rbacRef: StrongRef }> {
    const ds = spec ?? dropletSpecFromEnv();
    const agentDidPlc = getAgentDid().split(":").pop() ?? "unknown";
    const requesterPlc = requesterDid.split(":").pop() ?? "unknown";
    const rfpRkey = (vm._uri ?? "").split("/")[4] ?? "unknown";
    const containerName = `pdr-${requesterPlc}-${rfpRkey}-${shortUuid()}`;

    await Deno.mkdir(cacheDir, { recursive: true });

    // Mint the RBAC grant (provider repo) before provisioning, like DO.
    const rbacRef = await configureRbac(vm, requesterDid);

    // Register the droplet so the issuer's prove route can resolve it by id.
    // Tags carry the oidc-sub fragments so the prove-issued token's subject is
    // "actx:<provider>:plc:<requester>:role:<role>" — matching the grant above.
    const droplet: LocalDroplet = {
      id: containerName,
      name: containerName,
      networks: { v4: [] },
      tags: [`oidc-sub:plc:${requesterPlc}`, `oidc-sub:role:${vm.role}`],
    };
    droplets.set(containerName, droplet);

    // Inject the OIDC provisioning exchange (nonce + prove script) into the
    // cloud-init user-data so the container can mint its own scoped tokens.
    // actx is the PROVIDER (getAgentDid), mirroring DO's teamUuid: the prove
    // token's aud carries this actx and /v1/oidc/issue authorizes against the
    // provider's RBAC repo.
    const provisioningData = await ProvisioningData.create(
      agentDidPlc,
      vm.user_data ?? null,
      getIssuerUrl(),
    );
    const user_data = provisioningData.userData;
    provisioningData.associateWithDroplet(containerName);

    if (containerMode === "container") {
      // Container path — cloud-init + sshd directly in Docker (no KVM needed).
      log("info", "provisioning container", {
        containerName,
        image: containerImage,
      });

      const info = await runContainer(user_data, {
        distro: (ds.image as Distro | undefined) ?? "ubuntu",
        containerName,
        imageTag: containerImage,
        onIp: (ip, name) => {
          // Set IP immediately — before SSH poll — so prove can ssh-keyscan
          // the container during cloud-init provisioning.
          droplet.networks.v4 = [{ ip_address: ip, type: "public" }];
          droplet.containerName = name;
        },
      });

      droplet.networks.v4 = [{ ip_address: info.ip, type: "public" }];
      droplet.containerName = info.containerName;

      return {
        result: {
          providerId: containerName,
          metadata: {
            containerName,
            ip: info.ip,
            mode: "container",
            sshReady: true,
          },
        },
        rbacRef,
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

    droplet.networks.v4 = [{ ip_address: ip, type: "public" }];
    droplet.containerName = containerName;

    return {
      result: {
        providerId: containerName,
        metadata: {
          containerName,
          ip,
          mode: "vm",
          sshReady,
        },
      },
      rbacRef,
    };
  }

  // ── destroy ─────────────────────────────────────────────────────────

  async function destroyLocal(id: string | number): Promise<void> {
    const name = String(id);
    log("info", "destroying container", { containerName: name });
    await dockerRun(["kill", name]).catch(() => {});
    await dockerRun(["rm", "-f", name]).catch(() => {});
    droplets.delete(name);
  }

  // ── createBidConfig ─────────────────────────────────────────────────

  // Creates the com.publicdomainrelay.temp.compute.config.wif.simple record
  // that the bid advertises. Encodes the OIDC exchange parameters so the VM can
  // mint its own short-lived credentials without a long-lived secret.
  async function createBidConfig(nowIso: string): Promise<StrongRef> {
    return createRecord(COMPUTE_CONFIG_WIF_SIMPLE_NSID, {
      $type: COMPUTE_CONFIG_WIF_SIMPLE_NSID,
      accept_path: acceptPathVm,
      issuer_uri: getIssuerUrl(),
      to_issue: "exchange-custom-droplet-oidc-poc",
      // actx is the provider (mirrors DO's teamUuid). The VM reads it at runtime
      // from actx_path (the team_uuid file the prove exchange writes); this field
      // is the same value, for discoverability.
      actx: getAgentDid().split(":").slice(-1)[0],
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
    // deno-lint-ignore no-explicit-any
    let obj: Record<string, any> = {};
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

    const writeFiles = (obj.write_files ??= []) as unknown[];
    writeFiles.push({
      path: acceptPathVm,
      owner: "root:root",
      permissions: "0600",
      content: JSON.stringify(bundle, null, 2),
    });

    const runcmd = (obj.runcmd ??= []) as unknown[];
    const parent = acceptPathVm.split("/").slice(0, -1).join("/");
    runcmd.unshift([
      "sh",
      "-c",
      `install -d -m 0700 -o root -g root ${parent}`,
    ]);

    return "#cloud-config\n" + yamlStringify(obj, { lineWidth: 0 });
  }

  return {
    provisionLocal,
    destroyLocal,
    createBidConfig,
    injectAcceptBundle,
    deleteRbacRecord,
    getDroplet: (id: string): Record<string, unknown> | undefined =>
      droplets.get(id) as Record<string, unknown> | undefined,
    nonceStore,
  };
}

// ---------------------------------------------------------------------------
// ComputeProvider adapter — wraps the RBAC-aware local implementation in the
// provider-agnostic ComputeProvider interface and owns the workload-identity
// OIDC issuer lifecycle (setup/teardown).
// ---------------------------------------------------------------------------

export function createLocalComputeProvider(
  ctx: ComputeProviderLocalCtx,
): ComputeProvider {
  // Issuer URL is unknown until the XRPC relay registers a did:web identity, so
  // resolve it lazily: fall back to env / localhost before registration, then
  // adopt the relay-provided URL once it arrives (onIssuerUrl below).
  let issuerUrl = "";
  const getIssuerUrl = (): string => {
    if (!issuerUrl) {
      issuerUrl = Deno.env.get("ISSUER_URL") ??
        Deno.env.get("THIS_ENDPOINT") ??
        `http://localhost:${PORT}`;
    }
    return issuerUrl;
  };
  ctx.getIssuerUrl = getIssuerUrl;

  // Configure the extracted OIDC helper for this process (issuer getter + the
  // default in-memory signing-key store).
  configureOidc({ getIssuerUrl });

  const {
    provisionLocal,
    destroyLocal,
    createBidConfig,
    injectAcceptBundle,
    deleteRbacRecord,
    getDroplet,
    nonceStore,
  } = createComputeProviderLocal(ctx);

  // Track the RBAC grant minted per provisioned droplet so destroy() can revoke
  // it (mirrors the DO provider's rbacByProvider map).
  const rbacByProvider = new Map<string | number, StrongRef>();

  // Point the provisioning nonce persistence at the shared in-memory store so
  // provision() and the issuer's /v1/oidc/prove route agree on nonces.
  configureProvisioning({ nonceStore });

  // Resolves once the XRPC relay registers and the external issuer URL is known.
  let resolveIssuerReady!: (url: string) => void;
  const issuerReady = new Promise<string>((res) => { resolveIssuerReady = res; });

  const poc = createWorkloadIdentityDropletOidcPoc({
    getIssuerUrl,
    getDroplet,
    log: ctx.log,
    onIssuerUrl: (baseUrl) => { issuerUrl = baseUrl; resolveIssuerReady(baseUrl); },
    xrpcRelayIssuerPath: Deno.env.get("XRPC_RELAY_ISSUER_PATH") || undefined,
  });

  let httpServer: Deno.HttpServer | undefined;
  let relayController: ReturnType<typeof poc.startRelay> | undefined;

  return {
    name: "local",

    async provision(
      vm: VM,
      requesterDid: string,
      spec?: DropletSpec,
    ): Promise<ProvisionResult> {
      const { result, rbacRef } = await provisionLocal(vm, requesterDid, spec);
      rbacByProvider.set(result.providerId, rbacRef);
      return result;
    },

    async destroy(id: string | number): Promise<void> {
      const rbacRef = rbacByProvider.get(id);
      if (rbacRef) {
        await deleteRbacRecord(rbacRef, "vm.delete event");
        rbacByProvider.delete(id);
      }
      await destroyLocal(id);
    },

    createBidConfig,
    injectAcceptBundle,

    async setup(): Promise<void> {
      // Warm up the signing key (loads from store or generates + persists).
      await getSigningKey();

      // Transport selection (see ctx.serveHttp / ctx.xrpcRelay):
      //   - xrpcRelay (default true): the issuer's real transport. Provisioned
      //     containers reach /v1/oidc/{issue,prove} via the relay's did:web
      //     proxyRef. We wait for registration so getIssuerUrl() is the public
      //     URL before callers (e.g. createBidConfig) read it.
      //   - serveHttp (default false): also bind a local HTTP port (debug /
      //     direct access). Off by default — relay only.
      const serveHttp = ctx.serveHttp ?? false;
      const xrpcRelay = ctx.xrpcRelay ?? true;

      if (serveHttp) {
        // Issuer binds ISSUER_PORT when set, else PORT. Lets a host process
        // (e.g. the bidder) keep its own app on PORT while the issuer's
        // /v1/oidc/{issue,prove} HTTP transport listens on a separate port
        // fronted by a public reverse proxy (ISSUER_URL).
        const issuerPort = Number(Deno.env.get("ISSUER_PORT") ?? PORT);
        httpServer = Deno.serve({ port: issuerPort }, poc.app.fetch);
      }

      if (xrpcRelay) {
        relayController = poc.startRelay();
        const REGISTRATION_TIMEOUT_MS = 60_000;
        const timed = new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error("XRPC relay registration timed out")), REGISTRATION_TIMEOUT_MS)
        );
        try {
          await Promise.race([issuerReady, timed]);
        } catch (err) {
          ctx.log("warn", "issuer relay not registered; using fallback issuer URL", { error: String(err) });
        }
      }

      const jwk = await getPublicJwk();
      ctx.log("info", "workload-identity issuer listening", {
        serveHttp,
        xrpcRelay,
        port: serveHttp ? Number(Deno.env.get("ISSUER_PORT") ?? PORT) : undefined,
        issuer: getIssuerUrl(),
        kid: jwk.kid,
      });
    },

    async teardown(): Promise<void> {
      poc.stopRelay();
      relayController = undefined;
      try {
        await httpServer?.shutdown();
      } catch {
        /* ignore */
      }
      httpServer = undefined;
    },
  };
}
