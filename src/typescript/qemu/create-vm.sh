#!/usr/bin/env bash
# docker kill $(docker ps -q | grep -v knot-knot-1); docker rm $(docker ps -qa | grep -v knot-knot-1); bash -e create-vm.sh < cloud-init.yaml ; docker logs -f $(docker ps -q | grep -v knot-knot-1 | head -n 1)
set -euo pipefail

# Get the authorization token
TOKEN=$(goat xrpc get @pds com.atproto.server.getServiceAuth aud==did:web:mini-cloud-0001.fedfork.com | jq -r .token)

# Read cloud-init.yaml from stdin
user_data=$(cat)
if [ "x${user_data}" = "x" ]; then
  user_data="#cloud-config\nruncmd:\n  - set -x && systemctl enable sshd.service && systemctl start --no-block sshd.service\n"
fi

# Extract the JSON content block
ACCEPT_JSON=$(echo "$user_data" | yq -r '.write_files[] | select(.path == "/root/secrets/publicdomainrelay.com/market/accept.json") | .content')

# Extract Role and DID from the JSON
# DID URI structure: at://did:plc:5svqtrhheairglgiiyvutzik/...
ROLE=$(echo "$ACCEPT_JSON" | jq -r '.vm.value.role')
DID_PLC_KEY=$(echo "$ACCEPT_JSON" | jq -r '.accept.uri | split("/")[2] | split(":")[2]')

echo "Extracted Role: $ROLE"
echo "Extracted DID_PLC_KEY: $DID_PLC_KEY"

# Build the tags array dynamically
TAGS_JSON=$(jq -n \
  --arg did_plc_key "$DID_PLC_KEY" \
  --arg role "$ROLE" \
  '["oidc-sub:plc:" + $did_plc_key, "oidc-sub:role:" + $role]')

# Deploy the droplet
jq -n \
  --arg name "test-0001" \
  --arg region "nyc3" \
  --arg size "s-1vcpu-1gb" \
  --arg image "ubuntu" \
  --arg user_data "$user_data" \
  --argjson tags "$TAGS_JSON" \
  '{
    name: $name,
    region: $region,
    size: $size,
    image: $image,
    tags: $tags,
    user_data: $user_data,
  }' | tee /dev/stderr | curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @- \
  "https://mini-cloud-0001.fedfork.com/v2/droplets" \
  | yq -P
