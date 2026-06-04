set -euo pipefail

TOKEN=$(goat xrpc get @pds com.atproto.server.getServiceAuth aud==did:web:mini-cloud-0001--johnandersen777-bsky-social.fedproxy.com | jq -r .token)

set -x
user_data=$(cat)
if [ "x${user_data}" = "x" ]; then
  user_data="#cloud-config\nruncmd:\n  - set -x && systemctl enable sshd.service && systemctl start --no-block sshd.service\n"
fi
set +x

jq -n \
  --arg name "test-0001" \
  --arg region "nyc3" \
  --arg size "s-1vcpu-1gb" \
  --arg image "ubuntu" \
  --arg user_data "${user_data}" \
  --argjson tags '["oidc-sub:plc:5svqtrhheairglgiiyvutzik", "oidc-sub:role:policy-engine-680d9545985c1368"]' \
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
  "https://mini-cloud-0001--johnandersen777-bsky-social.fedproxy.com/v2/droplets" \
  | yq -P
