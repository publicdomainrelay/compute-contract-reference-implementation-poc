#!/usr/bin/env -S deno run -A
/**
 * Deno Script to build and run a Fedora or Ubuntu SquashFS LiveOS using QEMU.
 * Usage:
 * deno run -A main.ts build [--distro=fedora|ubuntu]
 * cat cloud-init.yaml | deno run -A main.ts run [--distro=fedora|ubuntu]
 */

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

const CACHE_DIR = `${HOME}/.cache/simple-qemu`;

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

// Run a shell command inside the chroot via plain chroot + bind mounts.
// We deliberately avoid systemd-nspawn: inside a container without systemd/dbus
// (e.g. the qemu-builder image) nspawn aborts with "Failed to open system bus"
// because it can't allocate a machine scope. chroot needs no bus and works both
// in a privileged container and on the host. Requires root (sudo) and
// CAP_SYS_ADMIN (docker --privileged) to bind-mount /proc, /sys, /dev.
async function inChroot(chrootDir: string, cmd: string): Promise<void> {
  console.log(`\n[CHROOT ${chrootDir}] ${cmd}`);
  const script =
    `cd="$1"
mkdir -p "$cd/proc" "$cd/sys" "$cd/dev" "$cd/run"
mountpoint -q "$cd/proc" || mount -t proc proc "$cd/proc"
mountpoint -q "$cd/sys"  || mount -t sysfs sys "$cd/sys"
mountpoint -q "$cd/dev"  || mount --rbind /dev "$cd/dev"
mountpoint -q "$cd/run"  || mount -t tmpfs tmpfs "$cd/run"
# Installing systemd/resolved turns the chroot's /etc/resolv.conf into a
# dangling symlink to /run/systemd/resolve/stub-resolv.conf; drop it first so
# we write a real resolv.conf each time and DNS keeps working across calls.
rm -f "$cd/etc/resolv.conf" 2>/dev/null || true
cp -fL /etc/resolv.conf "$cd/etc/resolv.conf" 2>/dev/null || true
chroot "$cd" /bin/sh -c "$2"; rc=$?
umount -R "$cd/run" "$cd/dev" "$cd/sys" "$cd/proc" 2>/dev/null || true
exit $rc`;
  await run("sudo", ["sh", "-c", script, "_", chrootDir, cmd]);
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

// --- Distro configs ---

async function installFedora(chrootDir: string): Promise<void> {
  await inChroot(chrootDir,
    "dnf -y install systemd kernel-core cloud-init dracut dracut-live " +
    "dracut-network btrfs-progs util-linux rsyslog openssh-server vim tmux sudo jq");
}

async function installUbuntu(chrootDir: string): Promise<void> {
  const nspawn = (cmd: string) => inChroot(chrootDir, cmd);

  await nspawn(
    "ln -sf /usr/share/zoneinfo/UTC /etc/localtime && " +
    "DEBIAN_FRONTEND=noninteractive apt-get update && " +
    "DEBIAN_FRONTEND=noninteractive apt-get install -y systemd linux-image-generic cloud-init dracut btrfs-progs util-linux rsyslog openssh-server vim tmux ca-certificates curl jq sudo locales",
  );
  await nspawn(
    "install -m 0755 -d /etc/apt/keyrings && " +
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && " +
    "chmod a+r /etc/apt/keyrings/docker.asc",
  );
  await nspawn(
    ". /etc/os-release && " +
    `printf 'Types: deb\\nURIs: https://download.docker.com/linux/ubuntu\\nSuites: %s\\nComponents: stable\\nArchitectures: %s\\nSigned-By: /etc/apt/keyrings/docker.asc\\n' ` +
    '"${UBUNTU_CODENAME:-$VERSION_CODENAME}" "$(dpkg --print-architecture)" ' +
    "> /etc/apt/sources.list.d/docker.sources",
  );
  await nspawn(
    "DEBIAN_FRONTEND=noninteractive apt-get update && " +
    "DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
  );
  // DHCP on all ethernet so systemd-resolved gets upstream DNS at boot.
  // The trailing rm/ln replaces the resolv.conf we copied in with the
  // resolved stub symlink that the booted VM uses.
  await nspawn(
    "mkdir -p /etc/systemd/network && " +
    "printf '[Match]\\nName=e*\\n\\n[Network]\\nDHCP=yes\\n\\n[DHCP]\\nUseDNS=yes\\nUseDomains=yes\\n' > /etc/systemd/network/20-wired.network && " +
    "systemctl enable systemd-networkd systemd-resolved && " +
    "rm -f /etc/resolv.conf && ln -s /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf",
  );
}

async function findKernelFedora(chrootDir: string): Promise<string> {
  const raw = await runCapture("find", [
    `${chrootDir}/usr/lib/modules`,
    "-name",
    "vmlinuz",
  ]);
  const path = raw.split("\n")[0];
  if (!path) throw new Error("Could not find vmlinuz in chroot (fedora).");
  return path;
}

async function findKernelUbuntu(chrootDir: string): Promise<string> {
  const raw = await runCapture("find", [
    `${chrootDir}/boot`,
    "-maxdepth",
    "1",
    "-name",
    "vmlinuz-*",
    "-not",
    "-name",
    "*.efi.signed",
  ]);
  const path = raw.split("\n")[0];
  if (!path) throw new Error("Could not find vmlinuz in chroot (ubuntu).");
  return path;
}

interface DistroConfig {
  ociSource: string;
  install: (chrootDir: string) => Promise<void>;
  findKernel: (chrootDir: string) => Promise<string>;
  kernelAppend: string;
}

const DISTRO_CONFIGS: Record<Distro, DistroConfig> = {
  fedora: {
    ociSource: "docker://registry.fedoraproject.org/fedora:latest",
    install: installFedora,
    findKernel: findKernelFedora,
    kernelAppend: "console=ttyS0 root=live:LABEL=LIVEOS rd.live.image rd.live.overlay.overlayfs=1 rd.live.overlay=LABEL=OVERLAY rd.live.overlay.nouserconfirmprompt init=/usr/lib/systemd/systemd",
  },
  ubuntu: {
    ociSource: "docker://docker.io/library/ubuntu:latest",
    install: installUbuntu,
    findKernel: findKernelUbuntu,
    // rd.overlay is deliberately OMITTED. When it names a device (rd.overlay=/dev/vdb)
    // BOTH dmsquash-live-root and 70overlayfs honor it and race to mount that device:
    // dmsquash mounts it at /run/initramfs/overlayfs first, then 70overlayfs fails to
    // mount it at /run/overlayfs-backing ("already mounted") and silently falls back to
    // a tmpfs overlay. A tmpfs root overlay then makes /var/lib/{docker,containerd}
    // overlay-on-overlay and the in-VM container build dies ("not supported as upperdir").
    // Instead our custom 90pdroverlay dracut module (injected at build time) owns the
    // overlay backing on LABEL=OVERLAY. dmsquash still forces overlayfs=required because
    // the squashfs root contains /usr, and its generator mounts the overlay onto /sysroot
    // using the /run/overlayfs + /run/ovlwork symlinks our module creates.
    // rd.live.overlay.nouserconfirmprompt suppresses the legacy dmsquash "Press [Enter]".
    kernelAppend: "console=ttyS0 root=live:LABEL=LIVEOS rd.live.image rd.live.overlay.nouserconfirmprompt init=/usr/lib/systemd/systemd",
  },
};

// --- Commands ---

async function buildCommand(distro: Distro) {
  const cfg = DISTRO_CONFIGS[distro];
  const CHROOT_DIR = `${CACHE_DIR}/my-chroot-${distro}`;
  const LIVEOS_IMG = `${CACHE_DIR}/liveos-${distro}.img`;

  await Deno.mkdir(CACHE_DIR, { recursive: true });

  // 1. Build chroot
  if (!(await exists(CHROOT_DIR))) {
    console.log(`==> Initializing ${distro} chroot...`);
    await Deno.mkdir(CHROOT_DIR, { recursive: true });

    const ociLayout = `${CACHE_DIR}/temp_oci_layout_${distro}`;
    await Deno.mkdir(ociLayout, { recursive: true });

    await run("skopeo", [
      "copy",
      "--format",
      "oci",
      cfg.ociSource,
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

    await cfg.install(CHROOT_DIR);
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

  // 2b. Docker/containerd storage on dedicated ext4 disks (ubuntu only).
  // The live root is overlayfs; docker + buildkit cannot stack an overlay
  // on top of an overlayfs lowerdir (nested overlay -> mount fails with
  // "invalid argument"). Bind /var/lib/docker and /var/lib/containerd to ext4
  // data disks (LABEL=DOCKERDATA, CTRDDATA) created at run time so the storage
  // drivers sit on a real fs. Run unconditionally (idempotent) so an existing
  // chroot picks this up after just deleting the cached liveos img.
  // RequiresMountsFor orders the mounts before the daemons touch their stores.
  if (distro === "ubuntu") {
    console.log("==> Configuring docker/containerd storage disks...");
    const fstabLines =
      "LABEL=DOCKERDATA /var/lib/docker ext4 defaults,nofail 0 2\n" +
      "LABEL=CTRDDATA /var/lib/containerd ext4 defaults,nofail 0 2\n";
    await run("sudo", [
      "sh",
      "-c",
      `set -e; ` +
      `mkdir -p ${CHROOT_DIR}/var/lib/docker ${CHROOT_DIR}/var/lib/containerd ` +
      `${CHROOT_DIR}/etc/systemd/system/docker.service.d ` +
      `${CHROOT_DIR}/etc/systemd/system/containerd.service.d; ` +
      // strip any prior entries, then re-append (idempotent)
      `sed -i '/LABEL=DOCKERDATA/d;/LABEL=CTRDDATA/d' ${CHROOT_DIR}/etc/fstab 2>/dev/null || true; ` +
      // %b (not %s) so the \n escapes in fstabLines become real newlines;
      // %s wrote a literal "\n" and collapsed both entries onto one unparsable
      // line, so systemd generated no .mount units and the disks never mounted.
      `printf '%b' ${JSON.stringify(fstabLines)} >> ${CHROOT_DIR}/etc/fstab; ` +
      `printf '[Unit]\\nRequiresMountsFor=/var/lib/docker /var/lib/containerd\\n' ` +
      `> ${CHROOT_DIR}/etc/systemd/system/docker.service.d/10-storage.conf; ` +
      `printf '[Unit]\\nRequiresMountsFor=/var/lib/containerd\\n' ` +
      `> ${CHROOT_DIR}/etc/systemd/system/containerd.service.d/10-storage.conf`,
    ]);
  }

  // 2c. Inject custom dracut module 90pdroverlay (ubuntu only).
  // It runs as a pre-mount hook BEFORE 70overlayfs and deterministically mounts
  // the LABEL=OVERLAY ext4 disk as the live root overlay backing, creating the
  // /run/overlayfs + /run/ovlwork symlinks that dmsquash's generated sysroot.mount
  // (Type=overlay) consumes. This replaces the rd.overlay=<device> path that races
  // dmsquash vs 70overlayfs and degrades to a tmpfs root overlay. See kernelAppend.
  if (distro === "ubuntu") {
    console.log("==> Injecting 90pdroverlay dracut module...");
    const moduleSetup = `#!/bin/bash
# 90pdroverlay - deterministic persistent root overlay backing.
# Owns /run/overlayfs + /run/ovlwork (upper/work on the ext4 disk labelled
# OVERLAY) so the live root overlay is backed by a real disk, not the tmpfs
# fallback dmsquash-live/70overlayfs hit when they race for the device.
check() { return 0; }
depends() { echo base; }
installkernel() { hostonly="" instmods overlay ext4; }
install() {
    inst_multiple mount mkdir ln udevadm
    inst_hook pre-mount 00 "$moddir/pdr-overlay.sh"
}
`;
    const pdrOverlay = `#!/bin/sh
command -v getarg > /dev/null || . /lib/dracut-lib.sh

# Run before 70overlayfs (pre-mount 01) so we own the overlay backing.
# Idempotent across the pre-mount/pre-pivot passes.
[ -h /run/overlayfs ] && return 0

label="\${PDR_OVERLAY_LABEL:-OVERLAY}"
dev="/dev/disk/by-label/$label"

# Local virtio disk; present by pre-mount, but settle to be safe.
i=0
while [ ! -b "$dev" ] && [ "$i" -lt 50 ]; do
    udevadm settle --timeout=1 2>/dev/null || sleep 0.1
    i=$((i + 1))
done

if [ ! -b "$dev" ]; then
    warn "pdroverlay: $dev not found; leaving overlay backing to default"
    return 0
fi

mkdir -m 0755 -p /run/overlayfs-backing
if mount -t ext4 "$dev" /run/overlayfs-backing; then
    mkdir -m 0755 -p /run/overlayfs-backing/overlay /run/overlayfs-backing/ovlwork
    ln -sf /run/overlayfs-backing/overlay /run/overlayfs
    ln -sf /run/overlayfs-backing/ovlwork /run/ovlwork
    info "pdroverlay: persistent root overlay on $dev"
else
    warn "pdroverlay: mount $dev failed; falling back to tmpfs overlay"
fi
return 0
`;
    // base64 the file bodies to avoid all shell quoting/expansion hazards.
    const b64 = (s: string) => btoa(s);
    await run("sudo", [
      "sh",
      "-c",
      `set -e; d=${CHROOT_DIR}/usr/lib/dracut/modules.d/90pdroverlay; mkdir -p "$d"; ` +
      `echo ${b64(moduleSetup)} | base64 -d > "$d/module-setup.sh"; ` +
      `echo ${b64(pdrOverlay)} | base64 -d > "$d/pdr-overlay.sh"; ` +
      `chmod 0755 "$d/module-setup.sh" "$d/pdr-overlay.sh"`,
    ]);
  }

  // 3. Build initrd with dmsquash-live
  const dracutMods = distro === "ubuntu"
    ? "dmsquash-live overlayfs pdroverlay"
    : "dmsquash-live overlayfs";
  const initrdPath = `${CHROOT_DIR}/boot/initrd.img`;
  // The distro packages ship a stock /boot/initrd.img (without dmsquash-live),
  // so guard on our own marker rather than initrd.img existence — otherwise the
  // stock initrd is reused and dracut FATALs with "Don't know how to handle
  // 'root=live:LABEL=LIVEOS'".
  const initrdMarker = `${CHROOT_DIR}/boot/.dmsquash-initrd`;
  if (!(await exists(initrdMarker))) {
    console.log("==> Building initrd...");
    const liveConf =
      `add_dracutmodules+=" ${dracutMods} "\nfilesystems+=" squashfs overlay ext4 "\ncompress="zstd"\nhostonly="no"\n`;
    await run("sudo", [
      "sh",
      "-c",
      `mkdir -p ${CHROOT_DIR}/etc/dracut.conf.d && echo '${liveConf}' > ${CHROOT_DIR}/etc/dracut.conf.d/live.conf`,
    ]);

    const kver = await getLatestKernelVersion(CHROOT_DIR);
    await inChroot(CHROOT_DIR,
      `dracut --force --no-hostonly --add '${dracutMods}' ` +
      `--filesystems 'squashfs overlay ext4' /boot/initrd.img '${kver}'`);
    await run("sudo", ["touch", initrdMarker]);

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
    const stagingDir = `${CACHE_DIR}/liveos-staging-${distro}`;
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

async function runCommand(distro: Distro) {
  const cfg = DISTRO_CONFIGS[distro];
  const CHROOT_DIR = `${CACHE_DIR}/my-chroot-${distro}`;
  const LIVEOS_IMG = `${CACHE_DIR}/liveos-${distro}.img`;

  if (!(await exists(LIVEOS_IMG))) {
    console.error(
      `Error: Disk image not found at ${LIVEOS_IMG}. Run 'build --distro=${distro}' first.`,
    );
    Deno.exit(1);
  }

  // Create per-invocation sparse 20GB overlay disk in a tempdir
  const overlayDir = await Deno.makeTempDir({ prefix: "qemu-overlay-" });
  const overlayImg = `${overlayDir}/overlay.img`;
  console.log("==> Creating 20GB sparse overlay disk...");
  await run("truncate", ["-s", "20G", overlayImg]);
  await run("mkfs.ext4", ["-L", "OVERLAY", overlayImg]);

  // Dedicated ext4 data disks for docker + containerd storage. The live root
  // is overlayfs and docker/buildkit cannot stack overlay-on-overlay, so these
  // get mounted at /var/lib/docker and /var/lib/containerd (see installUbuntu
  // fstab entries) to give the storage drivers a real filesystem.
  const dockerImg = `${overlayDir}/docker.img`;
  const containerdImg = `${overlayDir}/containerd.img`;
  console.log("==> Creating docker/containerd data disks...");
  await run("truncate", ["-s", "40G", dockerImg]);
  await run("mkfs.ext4", ["-L", "DOCKERDATA", dockerImg]);
  await run("truncate", ["-s", "40G", containerdImg]);
  await run("mkfs.ext4", ["-L", "CTRDDATA", containerdImg]);

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
  // QEMU user-mode DNS is at 10.0.2.3; 8.8.8.8 as fallback
  const networkConfig = `version: 2
ethernets:
  id0:
    match:
      name: "en*"
    dhcp4: true
    nameservers:
      addresses: [10.0.2.3, 8.8.8.8]
`;

  // 2. Start HTTP server for Cloud-Init NoCloud endpoint
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/user-data") return new Response(userData);
      if (url.pathname === "/meta-data") return new Response(metaData);
      if (url.pathname === "/vendor-data") return new Response(vendorData);
      if (url.pathname === "/network-config") return new Response(networkConfig);
      return new Response("Not found", { status: 404 });
    },
  );
  const port = server.addr.port;
  console.log(`==> Cloud-Init server listening on internal port ${port}`);

  // 3. Locate Kernel and run QEMU
  const kernelPath = await cfg.findKernel(CHROOT_DIR);

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
    "-drive",
    `file=${dockerImg},format=raw,if=virtio`,
    "-drive",
    `file=${containerdImg},format=raw,if=virtio`,
    "-append",
    cfg.kernelAppend,
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
  const distro = parseDistro(Deno.args.slice(1));

  if (command === "build") {
    await buildCommand(distro);
  } else if (command === "run") {
    await runCommand(distro);
  } else {
    console.error("Usage:");
    console.error("  deno run -A main.ts build [--distro=fedora|ubuntu]");
    console.error("  deno run -A main.ts run [--distro=fedora|ubuntu] < user-data.yaml");
    Deno.exit(1);
  }
}
