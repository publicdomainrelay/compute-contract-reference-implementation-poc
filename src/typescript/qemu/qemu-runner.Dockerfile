FROM fedora:latest

RUN dnf install -y \
    qemu-system-x86-core \
    unzip \
 && dnf clean all

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

WORKDIR /app
COPY qemu-runner.ts .

ENTRYPOINT ["deno", "run", "-A", "qemu-runner.ts", "run"]
