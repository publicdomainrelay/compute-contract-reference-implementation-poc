#!/usr/bin/env bash
set -euo pipefail

RBAC_REPO_ROOT="${HOME}/src/rbac/homelab-0002/wid-atp" X402_MAKE_FREE=1 DIGITALOCEAN_TOKEN=feedface DIGITALOCEAN_BASE_URL=https://mini-cloud-0001.fedfork.com deno run --allow-all --watch main.ts 2>&1 | jq --unbuffered -rR '(fromjson? // .)'
