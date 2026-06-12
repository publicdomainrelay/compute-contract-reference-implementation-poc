#!/usr/bin/env bash
# Build the WooTTY web UI in a container and drop the tarball into the SPA's
# dist/ so it is served at <client_uri>/wootty-web-dist.tar.gz (the URL the VM
# cloud-init downloads). client_uri comes from public/oauth-client-metadata.json
# (https://ui.fedfork.com).
#
# Usage: ./build-wootty-web.sh [WOOTTY_TAG]
#   WOOTTY_TAG defaults to the pinned tag in the Dockerfile (wootty-v0.2.17).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPA_DIR="$(cd "${HERE}/.." && pwd)"
DIST_DIR="${SPA_DIR}/dist"
TARBALL_NAME="wootty-web-dist.tar.gz"
IMAGE_TAG="wootty-web-build:local"

DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || { echo "error: '${DOCKER}' not found (set DOCKER=podman to use podman)" >&2; exit 1; }

BUILD_ARGS=()
if [ "${1:-}" != "" ]; then
  BUILD_ARGS+=(--build-arg "WOOTTY_TAG=$1")
fi

# Remove any prior artifact first, then build + extract the fresh one into dist/.
mkdir -p "${DIST_DIR}"
rm -f "${DIST_DIR}/${TARBALL_NAME}"

# The `artifact` stage is a scratch image holding only the tarball; buildx
# --output type=local writes its files straight into dist/ (no container run).
echo ">> building ${IMAGE_TAG} and extracting ${TARBALL_NAME} -> ${DIST_DIR}/"
"${DOCKER}" build "${BUILD_ARGS[@]}" \
  --target artifact \
  --output "type=local,dest=${DIST_DIR}" \
  -t "${IMAGE_TAG}" "${HERE}"

echo ">> done: ${DIST_DIR}/${TARBALL_NAME}"
ls -l "${DIST_DIR}/${TARBALL_NAME}"
