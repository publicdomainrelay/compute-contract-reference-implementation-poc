# docker build --pull --push --progress plain -f qemu-runner.Dockerfile -t atcr.io/johnandersen777.bsky.social/ccripoc-qemu-runner .
FROM fedora:latest

RUN dnf install -y \
    qemu-system-x86-core \
    e2fsprogs \
    ssh-keyscan \
    openssh-clients \
    unzip \
 && dnf clean all

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

WORKDIR /app
COPY qemu-standalone.ts .

ENTRYPOINT ["deno", "run", "-A", "qemu-standalone.ts", "run"]
