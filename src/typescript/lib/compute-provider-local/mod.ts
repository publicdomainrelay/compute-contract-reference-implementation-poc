// compute-provider-local — provisions Docker containers (QEMU VMs or light
// cloud-init+sshd containers) on the local host. Implements ComputeProvider
// so the bidder never branches on "where to provision".
//
// No HTTP, no RBAC, no OIDC — just docker commands and YAML injection.

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

// WIF simple config NSID — hardcoded to avoid a lexicons dep that pulls in
// the full atproto stack.
const COMPUTE_CONFIG_WIF_SIMPLE_NSID =
  "com.publicdomainrelay.temp.compute.config.wif.simple";

// ── helpers ─────────────────────────────────────────────────────────────

function shortUuid(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function dockerRun(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr).trim(),
  };
}

async function dockerInspectIp(containerName: string): Promise<string> {
  const { code, stdout } = await dockerRun([
    "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    containerName,
  ]);
  if (code !== 0) throw new Error(`docker inspect failed for ${containerName}`);
  return stdout;
}

async function pollSsh(host: string, port = 22, timeoutMs = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: host, port });
      conn.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return false;
}

async function pullImage(image: string, log: ComputeProviderCtx["log"]): Promise<void> {
  log("info", "pulling image", { image });
  const { code, stderr } = await dockerRun(["pull", image]);
  if (code !== 0) throw new Error(`docker pull failed for ${image}: ${stderr}`);
}

// ── factory ─────────────────────────────────────────────────────────────

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
    `${Deno.env.get("HOME") ?? "/tmp"}/.cache/pdr-local`;

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
      log("info", "provisioning container", { containerName, image: containerImage });

      await pullImage(containerImage, log);

      const udFile = `${cacheDir}/ud-${containerName}.yaml`;
      await Deno.writeTextFile(udFile, vm.user_data);

      // Clean up stale container with same name
      await dockerRun(["rm", "-f", containerName]).catch(() => {});

      const { code, stderr } = await dockerRun([
        "run", "-d",
        "--name", containerName,
        "--memory", ds.size ?? "512m",
        "--memory-swap", ds.size ?? "512m",
        "-v", `${udFile}:/tmp/user-data:ro`,
        "-e", "USER_DATA_FILE=/tmp/user-data",
        containerImage,
      ]);

      if (code !== 0) {
        throw new Error(`docker run failed for ${containerName}: ${stderr}`);
      }
    } else {
      // VM mode: run QEMU in Docker
      log("info", "provisioning VM", { containerName, image: vmImage });

      await pullImage(vmImage, log);
      await dockerRun(["rm", "-f", containerName]).catch(() => {});

      const { code, stderr } = await dockerRun([
        "run", "-d",
        "--name", containerName,
        "--privileged",
        "-v", `${cacheDir}:/data`,
        vmImage,
      ]);

      if (code !== 0) {
        throw new Error(`docker run failed for ${containerName}: ${stderr}`);
      }
    }

    await new Promise((r) => setTimeout(r, 2_000));

    let ip: string;
    try {
      ip = await dockerInspectIp(containerName);
      log("info", "container IP", { containerName, ip });
    } catch {
      ip = "0.0.0.0";
      log("warn", "could not get container IP", { containerName });
    }

    // Poll SSH until ready
    const sshReady = await pollSsh(ip, 22, 300_000);
    if (!sshReady) {
      log("warn", "SSH not ready within timeout", { containerName, ip });
    }

    containers.set(containerName, containerName);

    return {
      providerId: containerName,
      metadata: {
        containerName,
        ip,
        mode: containerMode,
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
