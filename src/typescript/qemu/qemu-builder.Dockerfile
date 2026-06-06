# docker build --pull --push --progress plain -f qemu-builder.Dockerfile -t atcr.io/johnandersen777.bsky.social/ccripoc-qemu-builder .
#
# Build the LiveOS .img into the host's ~/.cache/simple-qemu so the runner can
# boot it. Needs --privileged: the build chroots into the rootfs to install
# packages + run dracut (bind-mounting /proc, /sys, /dev) and loop-mounts the
# ext4 image. The cache dir is bind mounted to /root/.cache/simple-qemu
# (HOME=/root inside the container), which is where qemu-standalone.ts build/run
# read & write their artifacts.
#
# Produce the image (ubuntu):
#   sudo rm -rf ~/.cache/simple-qemu
#   docker build --pull --progress plain -f qemu-builder.Dockerfile -t atcr.io/johnandersen777.bsky.social/ccripoc-qemu-builder .
#   docker run --rm --privileged \
#     -v ~/.cache/simple-qemu:/root/.cache/simple-qemu \
#     atcr.io/johnandersen777.bsky.social/ccripoc-qemu-builder --distro=ubuntu
#   sudo chown -R $USER:$USER ~/.cache/simple-qemu/
#
# Produce the image (fedora):
#   docker run --rm --privileged \
#     -v ~/.cache/simple-qemu:/root/.cache/simple-qemu \
#     atcr.io/johnandersen777.bsky.social/ccripoc-qemu-builder --distro=fedora
#
# Force a rebuild of the squashfs/.img after changing the chroot config
# (e.g. the docker/containerd storage fstab) without rebuilding the chroot:
#   rm -f ~/.cache/simple-qemu/liveos-ubuntu.img
#   docker run --rm --privileged \
#     -v ~/.cache/simple-qemu:/root/.cache/simple-qemu \
#     atcr.io/johnandersen777.bsky.social/ccripoc-qemu-builder --distro=ubuntu
#
# The resulting ~/.cache/simple-qemu is then consumed by ccripoc-qemu-runner.
FROM fedora:latest

# Build-time deps used by qemu-standalone.ts buildCommand:
#   skopeo         - copy the base OCI image
#   squashfs-tools - mksquashfs (zstd-compressed LiveOS)
#   e2fsprogs      - mkfs.ext4
#   util-linux     - mount/umount/losetup for chroot binds + loop-mounted image
#   tar, gzip      - extract OCI layers (tar -xzkf)
#   findutils      - find (kernel/vmlinuz lookup)
#   sudo           - script wraps privileged steps in sudo
RUN dnf install -y \
    skopeo \
    squashfs-tools \
    e2fsprogs \
    util-linux \
    tar \
    gzip \
    findutils \
    sudo \
    qemu-system-x86-core \
    ssh-keyscan \
    openssh-clients \
    unzip \
 && dnf clean all

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

WORKDIR /app
COPY qemu-standalone.ts .

ENTRYPOINT ["deno", "run", "-A", "qemu-standalone.ts", "build"]
