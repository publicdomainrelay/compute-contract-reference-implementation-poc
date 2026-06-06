#!/usr/bin/env bash
set -xeuo pipefail

sudo rm -rf ~/.cache/simple-qemu

docker build --pull --progress plain -f qemu-builder.Dockerfile -t atcr.io/johnandersen777.bsky.social/ccripoc-qemu-builder .

docker run --rm --privileged \
  -v ~/.cache/simple-qemu:/root/.cache/simple-qemu \
  atcr.io/johnandersen777.bsky.social/ccripoc-qemu-builder --distro=ubuntu

sudo chown -R $USER:$USER ~/.cache/simple-qemu/
