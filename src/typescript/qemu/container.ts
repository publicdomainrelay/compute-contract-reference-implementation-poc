#!/usr/bin/env -S deno run -A
/**
 * container.ts — Run cloud-init + sshd inside Docker container (lighter QEMU alternative)
 *
 * Fulfills TODO in qemu-standalone.ts line 5:
 *   "update to optionally run only in docker a cloud-init and sshd setup"
 *
 * Instead of booting a full VM with kernel+initrd+squashfs overlay, this runs
 * cloud-init and sshd directly in a Docker container. No KVM required.
 * Startup ~2-5s vs ~15-30s for QEMU.
 *
 * Usage:
 *   deno run -A container.ts build [--distro=fedora|ubuntu]
 *   cat cloud-init.yaml | deno run -A container.ts run [--distro=fedora|ubuntu] [--port=2222]
 *
 * Library imports (for main.ts):
 *   import { buildContainerImage, runContainer, DEFAULT_USER_DATA } from "./container.ts";
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = Deno.env.get("HOME");
if (!HOME) {
  console.error("HOME environment variable is not set.");
  Deno.exit(1);
}

type Distro = "fedora" | "ubuntu";

function parseDistro(args: string[]): Distro {
  for (const arg of args) {
    const m = arg.match(/^--distro=(.+)$/);
    if (m) {
      const d = m[1];
      if (d !== "fedora" && d !== "ubuntu") {
        console.error(`Unknown distro: ${d}. Use fedora or ubuntu.`);
        Deno.exit(1);
      }
      return d as Distro;
    }
  }
  return "ubuntu";
}

const CACHE_DIR = `${HOME}/.cache/container-runner`;

const POLL_TIMEOUT_MS = 300_000; // 5 minutes
const SSH_DEFAULT_PORT = 22;
const MEMORY_DEFAULT = "512m";

const DEFAULT_USER_DATA = `#cloud-config
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerOptions {
  distro?: Distro;
  memory?: string;
  imageTag?: string;
  containerName?: string;
}

export interface ContainerInfo {
  ip: string;
  containerName: string;
}

// ---------------------------------------------------------------------------
// Utility functions (from qemu-standalone.ts)
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false;
    }
    throw err;
  }
}

async function run(cmd: string, args: string[]): Promise<void> {
  console.log(`\n[EXEC] ${cmd} ${args.join(" ")}`);
  const command = new Deno.Command(cmd, {
    args,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const { code } = await command.output();
  if (code !== 0) {
    throw new Error(`Command '${cmd}' failed with exit code ${code}`);
  }
}

async function runCapture(cmd: string, args: string[]): Promise<string> {
  console.log(`[EXEC CAPTURE] ${cmd} ${args.join(" ")}`);
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "inherit",
  });
  const { code, stdout } = await command.output();
  if (code !== 0) {
    throw new Error(`Command '${cmd}' failed with exit code ${code}`);
  }
  return new TextDecoder().decode(stdout).trim();
}

async function readStdin(): Promise<string> {
  let result = "";
  if (!Deno.stdin.isTerminal()) {
    const decoder = new TextDecoder();
    for await (const chunk of Deno.stdin.readable) {
      result += decoder.decode(chunk);
    }
  }
  return result;
}

async function readUserData(): Promise<string> {
  const filePath = Deno.env.get("USER_DATA_FILE");
  if (filePath) {
    try {
      const data = await Deno.readTextFile(filePath);
      console.log(`got user-data:\n${data}`);
      return data;
    } catch (err) {
      console.log(`Error reading data from ${filePath}`);
    }
  }
  return await readStdin();
}

// ---------------------------------------------------------------------------
// Docker utilities (from main.ts)
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
  try {
    const result = await runCapture("docker", ["images", "-q", tag]);
    return result.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Container entrypoint script generation
// ---------------------------------------------------------------------------

function generateEntrypoint(distro: Distro): string {
  // No systemd. Cloud-init stages run sequentially, then websocat/fedproxy/sshd.
  const sshdPath = "/usr/sbin/sshd";

  return `#!/bin/bash
set -e
echo "[container-entrypoint] Starting cloud-init + services container (${distro})"

# Generate SSH host keys on first boot
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
  echo "[container-entrypoint] Generating SSH host keys..."
  ssh-keygen -A
fi

# Set up NoCloud seed directory
SEED_DIR=/var/lib/cloud/seed/nocloud
mkdir -p "$SEED_DIR"

# Copy user-data from mounted file or use default
UD_FILE="\${USER_DATA_FILE:-/tmp/user-data}"
if [ -f "$UD_FILE" ]; then
  cp "$UD_FILE" "$SEED_DIR/user-data"
  echo "[container-entrypoint] Using user-data from $UD_FILE"
else
  cat > "$SEED_DIR/user-data" << 'UEOF'
#cloud-config
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
UEOF
  echo "[container-entrypoint] No user-data provided, using default"
fi

# Minimal meta-data
cat > "$SEED_DIR/meta-data" << 'MEOF'
instance-id: container-\$(hostname 2>/dev/null || echo "unknown")
local-hostname: container
MEOF

# Run cloud-init in stages (matches systemd unit ordering without systemd)
echo "[container-entrypoint] Running cloud-init init --local"
cloud-init init --local || true

echo "[container-entrypoint] Running cloud-init init"
cloud-init init || true

echo "[container-entrypoint] Running cloud-init modules --mode=config"
cloud-init modules --mode=config || true

echo "[container-entrypoint] Running cloud-init modules --mode=final"
cloud-init modules --mode=final || true
echo "[container-entrypoint] cloud-init complete"

	# Start sshd in foreground (container's main process)
	echo "[container-entrypoint] Starting sshd on port 22"
	exec ${sshdPath} -D -p 22
`;
}

// ---------------------------------------------------------------------------
// Dockerfile generation
// ---------------------------------------------------------------------------

function generateDockerfile(distro: Distro): string {
  if (distro === "fedora") {
    return `FROM fedora:latest
RUN dnf install -y \\
    cloud-init \\
    openssh-server \\
    sudo \\
    curl \\
    jq \\
    util-linux \\
    rsyslog \\
    vim \\
    tmux \\
    git \\
    unzip \\
    python3 \\
  && dnf clean all
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
COPY systemctl-shim.sh /usr/local/bin/systemctl
RUN chmod +x /usr/local/bin/systemctl
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
`;
  } else {
    return `FROM ubuntu:latest
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \\
    cloud-init \\
    openssh-server \\
    sudo \\
    curl \\
    jq \\
    util-linux \\
    rsyslog \\
    vim \\
    tmux \\
    git \\
    unzip \\
    ca-certificates \\
    locales \\
    python3 \\
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
COPY systemctl-shim.sh /usr/local/bin/systemctl
RUN chmod +x /usr/local/bin/systemctl
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
`;
  }
}

// ---------------------------------------------------------------------------
// Container image tag helpers
// ---------------------------------------------------------------------------

function imageTag(distro: Distro): string {
  return `container-runner-${distro}:latest`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildContainerImage(distro: Distro = "ubuntu"): Promise<string> {
  const tag = imageTag(distro);

  // Check if already built
  if (await imageExists(tag)) {
    console.log(`==> Image ${tag} already exists. Skipping build.`);
    // return tag;
  }

  console.log(`==> Building container image for ${distro}...`);

  // Create ephemeral build context
  const buildDir = await Deno.makeTempDir({ prefix: "container-build-" });
  try {
    // Copy systemctl shim into build context
    const shimSrc = new URL("./systemctl-shim.sh", import.meta.url).pathname;
    await Deno.copyFile(shimSrc, `${buildDir}/systemctl-shim.sh`);

    // Write entrypoint.sh
    await Deno.writeTextFile(`${buildDir}/entrypoint.sh`, generateEntrypoint(distro));
    await run("chmod", ["+x", `${buildDir}/entrypoint.sh`]);

    // Write Dockerfile
    await Deno.writeTextFile(`${buildDir}/Dockerfile`, generateDockerfile(distro));

    // Build
    await run("docker", [
      "build",
      "--pull",
      "--progress", "plain",
      "-t", tag,
      buildDir,
    ]);

    console.log(`==> Built container image: ${tag}`);
    return tag;
  } finally {
    await Deno.remove(buildDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runContainer(
  userData: string,
  opts: ContainerOptions = {},
): Promise<ContainerInfo> {
  const distro = opts.distro ?? "ubuntu";
  const tag = opts.imageTag ?? imageTag(distro);
  const memory = opts.memory ?? MEMORY_DEFAULT;
  const containerName = opts.containerName ?? `container-${crypto.randomUUID().slice(0, 8)}`;

  console.log(`==> Starting container (${distro}, tag=${tag})`);

  // Ensure image exists
  if (!(await imageExists(tag))) {
    console.log(`==> Image ${tag} not found. Building...`);
    await buildContainerImage(distro);
  }

  // Ensure cache dir exists
  await Deno.mkdir(CACHE_DIR, { recursive: true });

  // Write user-data to temp file
  const udFile = await Deno.makeTempFile({
    dir: CACHE_DIR,
    prefix: "container-ud-",
    suffix: ".yaml",
  });
  await Deno.writeTextFile(udFile, userData);

  // Generate entrypoint and write to temp file (runtime mount → no image rebuild
  // needed when entrypoint changes).
  const entrypointScript = generateEntrypoint(distro);
  const epFile = await Deno.makeTempFile({
    dir: CACHE_DIR,
    prefix: "container-ep-",
    suffix: ".sh",
  });
  await Deno.writeTextFile(epFile, entrypointScript);
  await run("chmod", ["+x", epFile]);

  // Clean up any old container with same name
  await new Deno.Command("docker", { args: ["rm", "-f", containerName] }).output().catch(() => {});

  // Run container — entrypoint mounted at runtime overrides baked-in
  const { code } = await new Deno.Command("docker", {
    args: [
      "run", "-d",
      "--name", containerName,
      "--memory", memory,
      "--memory-swap", memory,
      "-v", `${udFile}:/tmp/user-data:ro`,
      "-v", `${epFile}:/entrypoint.sh:ro`,
      "-e", "USER_DATA_FILE=/tmp/user-data",
      tag,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();

  if (code !== 0) {
    await Deno.remove(udFile).catch(() => {});
    await Deno.remove(epFile).catch(() => {});
    throw new Error(`docker run failed for ${containerName} (exit ${code})`);
  }

  // Get container IP
  // Wait a moment for the container to start and get an IP
  await new Promise((r) => setTimeout(r, 1_000));
  const ip = await dockerInspectIp(containerName);
  console.log(`==> Container IP: ${ip}`);

  // Wait for SSH
  console.log("==> Waiting for SSH...");
  const ready = await pollSsh(ip, 22);
  if (!ready) {
    // Clean up temp files but leave container for debugging
    await Deno.remove(udFile).catch(() => {});
    await Deno.remove(epFile).catch(() => {});
    throw new Error(`SSH not ready within timeout for ${containerName} (ip=${ip})`);
  }

  console.log(`==> SSH ready! ssh agent@${ip}`);
  console.log(`    Container: ${containerName}`);

  // Clean up temp files
  await Deno.remove(udFile).catch(() => {});
  await Deno.remove(epFile).catch(() => {});

  return { ip, containerName };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const command = Deno.args[0];
  const distro = parseDistro(Deno.args.slice(1));

  if (command === "build") {
    const tag = await buildContainerImage(distro);
    console.log(`Image tag: ${tag}`);
  } else if (command === "run") {
    const userData = await readUserData();
    const info = await runContainer(userData, { distro });
    console.log(JSON.stringify(info));

    // Block until Ctrl-C, then clean up
    console.log("==> Container running. Press Ctrl-C to stop and remove.");
    const ac = new AbortController();
    const signalCb = () => {
      console.log("\n==> Shutting down...");
      ac.abort();
    };
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      try { Deno.addSignalListener(sig, signalCb); } catch { /* ignore */ }
    }

    // Wait for signal
    try {
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (ac.signal.aborted) { clearInterval(interval); resolve(); }
        }, 200);
      });
    } finally {
      // Clean up
      console.log(`==> Removing container ${info.containerName}...`);
      await new Deno.Command("docker", {
        args: ["rm", "-f", info.containerName],
        stdout: "inherit",
        stderr: "inherit",
      }).output().catch(() => {});
    }
    console.log("Done.");
  } else {
    console.error("Usage:");
    console.error("  deno run -A container.ts build [--distro=fedora|ubuntu]");
    console.error("  deno run -A container.ts run [--distro=fedora|ubuntu] < user-data.yaml");
    console.error("");
    console.error("Library imports:");
    console.error("  import { buildContainerImage, runContainer, DEFAULT_USER_DATA }");
    console.error("    from \"./container.ts\";");
    Deno.exit(1);
  }
}
