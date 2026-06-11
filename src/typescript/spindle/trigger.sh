#!/usr/bin/env bash
# Trigger a new pipeline run out-of-band by calling this spindle's trigger XRPC
# (main.ts handleTrigger) — bypasses the knot's git post-receive hook (the only
# path that normally produces a sh.tangled.pipeline event, see triggerPipeline
# in knotserver/internal.go) so we can exercise triggerWorkflows() directly for
# testing.
#
# Request body must satisfy TriggerPayload (main.ts:162-170):
#   knot, pipelineRkey, actor, repoDid, repoName, ref, inputs?
#
# Uses PDS service proxying (atproto.com/specs/xrpc#service-proxying), exactly
# like the viewer SPA: we hand `goat xrpc` a service DID reference
# (did:web:<spindle>#tangled_spindle) instead of a base URL, so it sends the
# call to the logged-in account's PDS with an `atproto-proxy` header. The PDS
# mints and signs the inter-service auth token (iss=<our DID>, aud=the spindle's
# service DID, lxm=com.publicdomainrelay.temp.tangled.spindle.trigger) and
# forwards the request to the spindle, which verifies it against our DID
# document and requires iss === actor (see validateTriggerServiceAuth).
#
# Target repo defaults to "compute-contract-reference-implementation-poc" on
# knot1.tangled.sh (repoDid did:plc:bbvpwcihkeeztqxk47s5arq3) — its
# sh.tangled.repo record's `spindle` field matches this running instance's
# hostname (see repoDidToSpindle in main.ts), so it's authorized here.
# Override KNOT / REPO_NAME / REPO_DID / DEFAULT_BRANCH / SHA / SPINDLE_URL via env.
set -euo pipefail

# SPINDLE_URL="${SPINDLE_URL:-http://localhost:${PORT:-7777}}"
SPINDLE_URL="${SPINDLE_URL:-https://did-plc-7nebcphrbnjegrniycnbvyrk.gha.spindle.tangled.fedcicd.com}"
KNOT="${KNOT:-knot1.tangled.sh}"
REPO_NAME="${REPO_NAME:-compute-contract-reference-implementation-poc}"
REPO_DID_PLC_KEY="$(git remote get-url tangled-pub | sed -e 's/.*did:plc://')"
REPO_DID="${REPO_DID:-did:plc:${REPO_DID_PLC_KEY}}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

# Resolve the latest SHA on $DEFAULT_BRANCH directly from the knot — the
# spindle fetches .github/workflows/*.yml at this exact SHA, so it must exist
# there (not just locally).
SHA="${SHA:-$(curl -s "https://${KNOT}/xrpc/sh.tangled.repo.log?repo=${REPO_DID}&ref=${DEFAULT_BRANCH}&limit=1" | jq -r '.commits[0].this')}"
if [ -z "$SHA" ] || [ "$SHA" = "null" ]; then
  echo "error: could not resolve latest SHA for ${REPO_DID}@${DEFAULT_BRANCH} from ${KNOT}" >&2
  exit 1
fi

ACTOR_DID="$(goat account check-auth 2>/dev/null | grep -m1 '^DID:' | awk '{print $2}')"
if [ -z "$ACTOR_DID" ]; then
  echo "error: no logged-in goat account (run: goat account login)" >&2
  exit 1
fi

# pipelineRkey just needs to be unique per run — mint a TID-shaped key
PIPELINE_RKEY="manual-$(date -u +%Y%m%dT%H%M%SZ)"

# Proxy target: the spindle's service DID reference. Handing this (rather than a
# base URL) to `goat xrpc` triggers authenticated PDS proxying — goat posts to
# our PDS with `atproto-proxy: <SPINDLE_REF>`, the PDS resolves the spindle's
# did:web document, mints the service-auth token, and forwards the call.
SPINDLE_HOST="$(echo "$SPINDLE_URL" | sed -E 's#^[a-z]+://##; s#/.*##')"
SPINDLE_SERVICE_ID="tangled_spindle"
SPINDLE_REF="did:web:${SPINDLE_HOST}#${SPINDLE_SERVICE_ID}"
TRIGGER_LXM="com.publicdomainrelay.temp.tangled.spindle.trigger"

echo "Triggering pipeline run by proxying ${TRIGGER_LXM} through your PDS"
echo "  repo:    $REPO_NAME ($REPO_DID)"
echo "  knot:    $KNOT"
echo "  branch:  $DEFAULT_BRANCH"
echo "  sha:     $SHA"
echo "  actor:   $ACTOR_DID"
echo "  rkey:    $PIPELINE_RKEY"
echo "  proxy:   $SPINDLE_REF"
echo "  lxm:     $TRIGGER_LXM"

BODY=$(jq -n \
  --arg knot "$KNOT" \
  --arg pipelineRkey "$PIPELINE_RKEY" \
  --arg actor "$ACTOR_DID" \
  --arg repoDid "$REPO_DID" \
  --arg repoName "$REPO_NAME" \
  --arg ref "$SHA" \
  '{knot: $knot, pipelineRkey: $pipelineRkey, actor: $actor, repoDid: $repoDid, repoName: $repoName, ref: $ref}')

# `goat xrpc procedure <service> <nsid> ...`: a service DID reference selects
# authenticated PDS proxying; `-` reads the JSON request body from stdin.
# The trigger now returns immediately with the run ids (logsUrl per workflow);
# compute provisioning continues in the background on the spindle.
echo "$BODY" >&2
RESPONSE="$(echo "$BODY" | goat xrpc procedure "$SPINDLE_REF" "$TRIGGER_LXM" 'Content-Type:application/json' -)"
echo "$RESPONSE" | jq .

# Pull the per-workflow log URLs out of the trigger response so we can stream.
mapfile -t LOG_URLS < <(echo "$RESPONSE" | jq -r '.workflows[]?.logsUrl // empty')
if [ "${#LOG_URLS[@]}" -eq 0 ]; then
  echo "no workflows to stream" >&2
  exit 0
fi

# Inline Deno log streamer. The spindle's /logs endpoint streams the run's
# accumulated output over a WebSocket and then closes (it isn't a long-lived
# tail), so we reconnect until /status reports a terminal state, deduping
# already-printed data lines across reconnects by count.
STREAMER="$(mktemp --suffix=.ts)"
trap 'rm -f "$STREAMER"' EXIT
cat > "$STREAMER" <<'EOF'
const logsUrl = Deno.args[0];
const label = Deno.args[1] ?? "";
const wsUrl = logsUrl.replace(/^http/, "ws");
const statusUrl = logsUrl.replace("/logs/", "/status/");
const prefix = label ? `[${label}] ` : "";
const enc = new TextEncoder();
const out = (s: string) => Deno.stdout.writeSync(enc.encode(prefix + s + "\n"));

const DEADLINE = Date.now() + 30 * 60 * 1000; // 30 min safety cap
let printed = 0; // data lines already emitted (monotonic across reconnects)

const isTerminal = (s: string | null) =>
  s === "complete" || s === "input_validation_error" || s === "unknown";

async function pollStatus(): Promise<string | null> {
  try {
    const r = await fetch(statusUrl);
    if (!r.ok) return null;
    const j = await r.json();
    return j?.policyEngine?.status ?? null;
  } catch {
    return null;
  }
}

function streamOnce(): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      resolve();
      return;
    }
    ws.onmessage = (ev) => {
      let frame: { type?: string; kind?: string; content?: string };
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (frame.type === "ping") return;
      if (frame.kind === "data") {
        seen++;
        if (seen > printed) {
          out(frame.content ?? "");
          printed = seen;
        }
      }
    };
    ws.onclose = () => resolve();
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
      resolve();
    };
  });
}

while (true) {
  await streamOnce();
  const s = await pollStatus();
  if (isTerminal(s)) break;
  if (Date.now() > DEADLINE) {
    out(`(log stream gave up after 30m, last status: ${s ?? "unknown"})`);
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
EOF

# Stream each workflow's logs. Prefix lines with the workflow stem only when
# more than one workflow is running, so a single-workflow run stays clean.
pids=()
for url in "${LOG_URLS[@]}"; do
  label=""
  if [ "${#LOG_URLS[@]}" -gt 1 ]; then
    label="${url##*/}"
  fi
  echo "==> streaming logs: $url" >&2
  deno run --allow-net "$STREAMER" "$url" "$label" &
  pids+=($!)
done
wait "${pids[@]}"
