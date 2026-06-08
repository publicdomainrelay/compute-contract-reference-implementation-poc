#!/usr/bin/env bash
set -euo pipefail

export COMPUTE_PROVIDER=market.rfp
export BID_WINDOW_MS=3000
export SPINDLE_HOSTNAME="gha.spindle.tangled.fedcicd.com"
export PORT="7777"

deno run --allow-all --watch main.ts 2>&1 | tee spindle.logs | grep --line-buffered -E '^\{' | jq --unbuffered -c . | while IFS='' read -r line; do echo '---' && printf '%s\n' "$line" | yq -P; done
# deno run --allow-all --watch main.ts
