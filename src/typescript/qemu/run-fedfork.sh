#!/usr/bin/env bash
set -xeuo pipefail

THIS_ENDPOINT=https://mini-cloud-0001.fedfork.com PORT=9000 deno run -A --watch ./main.ts 2>&1 | jq --unbuffered -rR '(fromjson? // .)'
