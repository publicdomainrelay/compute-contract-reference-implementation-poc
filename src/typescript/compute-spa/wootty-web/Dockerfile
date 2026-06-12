# Builds the WooTTY web UI (the static assets WooTTY serves as WOOTTY_STATIC_DIR)
# and packages them as a tarball. Upstream ships NO web assets in either the
# release binary or the GHCR image (both embed an empty placeholder dist and
# serve "Web app is not built yet"), so we build them ourselves here.
#
# Output: /out/wootty-web-dist.tar.gz  (contains a single top-level dir: wootty-web/)
#
# Pinned to the same WooTTY tag as the woottyd binary in cloud-init-presets.ts.
ARG WOOTTY_TAG=wootty-v0.2.17

FROM node:24-bookworm-slim AS build
ARG WOOTTY_TAG

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${WOOTTY_TAG}" https://github.com/icoretech/wootty .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @icoretech/wootty-web build

# Package apps/web/dist as wootty-web/ so the on-VM extraction yields a stable
# WOOTTY_STATIC_DIR=/usr/local/share/wootty/wootty-web.
RUN mkdir -p /out \
  && cp -a apps/web/dist /out/wootty-web \
  && tar -C /out -czf /out/wootty-web-dist.tar.gz wootty-web

# Minimal final stage so `docker create` + `docker cp` pull just the tarball.
FROM scratch AS artifact
COPY --from=build /out/wootty-web-dist.tar.gz /wootty-web-dist.tar.gz
