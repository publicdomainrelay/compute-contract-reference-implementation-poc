THIS_ENDPOINT=https://homelab--johnandersen777-bsky-social.fedproxy.com TEAM_UUID=5svqtrhheairglgiiyvutzik PORT=9000 deno run -A --watch ./main.ts 2>&1 | jq --unbuffered -rR '(fromjson? // .)'


