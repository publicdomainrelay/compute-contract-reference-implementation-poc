#!/usr/bin/env -S deno run -A
/**
 * Deno Script to build and run a Fedora SquashFS LiveOS using QEMU.
 * * Usage:
 * deno run -A main.ts build
 * cat cloud-init.yaml | deno run -A main.ts run
 */

const HOME = Deno.env.get("HOME");
if (!HOME) {
  console.error("HOME environment variable is not set.");
  Deno.exit(1);
}

const CACHE_DIR = `${HOME}/.cache/simple-qemu`;
const CHROOT_DIR = `${CACHE_DIR}/my-chroot`;
const LIVEOS_IMG = `${CACHE_DIR}/liveos.img`;

// --- Utility Functions ---

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

async function getLatestKernelVersion(chrootDir: string): Promise<string> {
  const modulesDir = `${chrootDir}/lib/modules`;
  const entries = [];
  for await (const entry of Deno.readDir(modulesDir)) {
    if (entry.isDirectory) {
      entries.push(entry.name);
    }
  }
  if (entries.length === 0) {
    throw new Error("No kernel modules found in chroot.");
  }
  return entries.sort().pop()!;
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

// --- Commands ---

async function buildCommand() {
  await Deno.mkdir(CACHE_DIR, { recursive: true });

  // 1. Build chroot
  if (!(await exists(CHROOT_DIR))) {
    console.log("==> Initializing chroot...");
    await Deno.mkdir(CHROOT_DIR, { recursive: true });

    const ociLayout = `${CACHE_DIR}/temp_oci_layout`;
    await Deno.mkdir(ociLayout, { recursive: true });

    await run("skopeo", [
      "copy",
      "--format",
      "oci",
      "docker://registry.fedoraproject.org/fedora:latest",
      `dir:${ociLayout}`,
    ]);

    const manifestText = await Deno.readTextFile(`${ociLayout}/manifest.json`);
    const manifest = JSON.parse(manifestText);

    for (const layer of manifest.layers) {
      const digest = layer.digest.replace("sha256:", "");
      await run("sudo", [
        "tar",
        "-xzkf",
        `${ociLayout}/${digest}`,
        "-C",
        CHROOT_DIR,
      ]);
    }

    await run("sudo", [
      "systemd-nspawn",
      "-D",
      CHROOT_DIR,
      "dnf",
      "-y",
      "install",
      "systemd",
      "kernel-core",
      "cloud-init",
      "dracut",
      "dracut-live",
      "dracut-network",
      "btrfs-progs",
      "util-linux",
      "rsyslog",
      "openssh-server",
      "vim",
      "tmux",
    ]);
  } else {
    console.log("==> Chroot already exists. Skipping chroot build.");
  }

  // 2. Journald config
  console.log("==> Configuring journald...");
  await run("sudo", [
    "mkdir",
    "-p",
    `${CHROOT_DIR}/etc/systemd/journald.conf.d`,
  ]);
  const journalConf =
    "[Journal]\nForwardToConsole=yes\nMaxLevelConsole=debug\n";
  await run("sudo", [
    "sh",
    "-c",
    `echo "${journalConf}" > ${CHROOT_DIR}/etc/systemd/journald.conf.d/serial.conf`,
  ]);

  // 3. Build initrd with dmsquash-live
  const initrdPath = `${CHROOT_DIR}/boot/initrd.img`;
  if (!(await exists(initrdPath))) {
    console.log("==> Building initrd...");
    const liveConf =
      `add_dracutmodules+=" dmsquash-live "\nfilesystems+=" squashfs overlay ext4 "\ncompress="zstd"\nhostonly="no"\n`;
    await run("sudo", [
      "sh",
      "-c",
      `echo '${liveConf}' > ${CHROOT_DIR}/etc/dracut.conf.d/live.conf`,
    ]);

    const kver = await getLatestKernelVersion(CHROOT_DIR);
    await run("sudo", [
      "systemd-nspawn",
      "-D",
      CHROOT_DIR,
      "dracut",
      "--force",
      "/boot/initrd.img",
      kver,
    ]);

    const user = Deno.env.get("USER");
    if (user) {
      await run("sudo", ["chown", `${user}:${user}`, initrdPath]);
    }
  } else {
    console.log("==> Initrd already exists. Skipping initrd build.");
  }

  // 4. Build squashfs and final ext4 live image
  if (!(await exists(LIVEOS_IMG))) {
    console.log("==> Building squashfs & disk image...");
    const stagingDir = `${CACHE_DIR}/liveos-staging`;
    await Deno.mkdir(`${stagingDir}/LiveOS`, { recursive: true });
    const squashfsPath = `${stagingDir}/LiveOS/squashfs.img`;

    await run("sudo", [
      "mksquashfs",
      CHROOT_DIR,
      squashfsPath,
      "-comp",
      "zstd",
      "-e",
      `${CHROOT_DIR}/proc`,
      "-e",
      `${CHROOT_DIR}/sys`,
      "-e",
      `${CHROOT_DIR}/dev`,
      "-e",
      `${CHROOT_DIR}/run`,
      "-noappend",
    ]);

    const duOut = await runCapture("du", ["-sb", squashfsPath]);
    const sqSize = parseInt(duOut.split(/\s+/)[0], 10);
    // Add 15% headroom and round up to the nearest MB (1048576 bytes)
    const imgSize = Math.ceil((sqSize * 1.15) / 1048576) * 1048576;

    await run("truncate", ["-s", imgSize.toString(), LIVEOS_IMG]);
    await run("mkfs.ext4", ["-L", "LIVEOS", LIVEOS_IMG]);

    const mountPoint = await Deno.makeTempDir();
    try {
      await run("sudo", ["mount", "-o", "loop", LIVEOS_IMG, mountPoint]);
      await run("sudo", ["mkdir", "-p", `${mountPoint}/LiveOS`]);
      await run("sudo", [
        "cp",
        squashfsPath,
        `${mountPoint}/LiveOS/squashfs.img`,
      ]);
    } finally {
      await run("sudo", ["umount", mountPoint]);
      await Deno.remove(mountPoint);
    }
  } else {
    console.log("==> Disk image already exists. Skipping squashfs build.");
  }

  console.log(`\n==> Build complete! Resources are cached in ${CACHE_DIR}`);
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

async function runCommand() {
  if (!(await exists(LIVEOS_IMG))) {
    console.error(
      `Error: Disk image not found at ${LIVEOS_IMG}. Run 'build' first.`,
    );
    Deno.exit(1);
  }

  // Create per-invocation sparse 20GB overlay disk in a tempdir
  const overlayDir = await Deno.makeTempDir({ prefix: "qemu-overlay-" });
  const overlayImg = `${overlayDir}/overlay.img`;
  console.log("==> Creating 20GB sparse overlay disk...");
  await run("truncate", ["-s", "20G", overlayImg]);
  await run("mkfs.ext4", ["-L", "OVERLAY", overlayImg]);

  // 1. Prepare cloud-init payloads
  let userData = await readUserData();
  if (!userData.trim()) {
    console.log(
      "No cloud-init user-data provided on stdin. Using default test configuration.",
    );
    userData = `#cloud-config
users:
  - name: agent
    sudo: ["ALL=(ALL) NOPASSWD:ALL"]
chpasswd:
  expire: False
  users:
  - name: agent
    password: agent
    type: text
`;
  }
  const metaData = "instance-id: deno-qemu-liveos\n";
  const vendorData = "";

  // 2. Start HTTP server for Cloud-Init NoCloud endpoint
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/user-data") return new Response(userData);
      if (url.pathname === "/meta-data") return new Response(metaData);
      if (url.pathname === "/vendor-data") return new Response(vendorData);
      return new Response("Not found", { status: 404 });
    },
  );
  const port = server.addr.port;
  console.log(`==> Cloud-Init server listening on internal port ${port}`);

  // 3. Locate Kernel and run QEMU
  const kernelRawPath = await runCapture("find", [
    `${CHROOT_DIR}/usr/lib/modules`,
    "-name",
    "vmlinuz",
  ]);
  const kernelPath = kernelRawPath.split("\n")[0];
  if (!kernelPath) {
    throw new Error("Could not find vmlinuz in chroot.");
  }

  console.log(`==> SSH forwarded: container :22 -> guest :22`);

  const qemuArgs = [
    "-net",
    "nic",
    "-net",
    "user,hostfwd=tcp::22-:22",
    "-smbios",
    `type=1,serial=ds=nocloud;s=http://10.0.2.2:${port}/`,
    "-no-reboot",
    "-enable-kvm",
    "-cpu",
    "host",
    "-smp",
    "cpus=2",
    "-m",
    "4G",
    "-nographic",
    "-initrd",
    `${CHROOT_DIR}/boot/initrd.img`,
    "-kernel",
    kernelPath,
    "-drive",
    `file=${LIVEOS_IMG},format=raw,if=virtio,readonly=on`,
    "-drive",
    `file=${overlayImg},format=raw,if=virtio`,
    "-append",
    "console=ttyS0 root=live:LABEL=LIVEOS rd.live.image rd.overlayfs=1 rd.live.overlay.overlayfs=1 rd.live.overlay=/dev/vdb init=/usr/lib/systemd/systemd",
  ];

  console.log("==> Starting QEMU...");
  try {
    await run("qemu-system-x86_64", qemuArgs);
  } finally {
    console.log("==> QEMU exited. Shutting down cloud-init server...");
    ac.abort();
    await Deno.remove(overlayDir, { recursive: true });
  }
}

// --- Entry Point ---

if (import.meta.main) {
  const command = Deno.args[0];

  if (command === "build") {
    await buildCommand();
  } else if (command === "run") {
    await runCommand();
  } else {
    console.error("Usage:");
    console.error("  deno run -A main.ts build");
    console.error("  deno run -A main.ts run < user-data.yaml");
    Deno.exit(1);
  }
}
