#!/usr/bin/env bash
set -xeuo pipefail

export OPERATOR_HANDLE=johnandersen777.bsky.social
export THIS_ENDPOINT=https://mini-cloud-0001.fedfork.com
export PORT=9000

deno run -A --watch ./main.ts 2>&1 | jq --unbuffered -rR '(fromjson? // .)'
