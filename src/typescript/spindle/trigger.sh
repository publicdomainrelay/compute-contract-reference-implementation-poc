#!/usr/bin/env bash
# Trigger a new pipeline run out-of-band by POSTing straight to this spindle's
# /trigger endpoint (main.ts:1459) — bypasses the knot's git post-receive hook
# (the only path that normally produces a sh.tangled.pipeline event, see
# triggerPipeline in knotserver/internal.go) so we can exercise
# triggerWorkflows() directly for testing.
#
# POST body must satisfy TriggerPayload (main.ts:162-170):
#   knot, pipelineRkey, actor, repoDid, repoName, ref, inputs?
#
# Target repo defaults to "compute-contract-reference-implementation-poc" on
# knot1.tangled.sh (repoDid did:plc:bbvpwcihkeeztqxk47s5arq3) — its
# sh.tangled.repo record's `spindle` field matches this running instance's
# hostname (see repoDidToSpindle in main.ts), so it's authorized here.
# Override KNOT / REPO_NAME / REPO_DID / DEFAULT_BRANCH / SHA / SPINDLE_URL via env.
set -euo pipefail

SPINDLE_URL="${SPINDLE_URL:-http://localhost:${PORT:-7777}}"
KNOT="${KNOT:-knot1.tangled.sh}"
REPO_NAME="${REPO_NAME:-compute-contract-reference-implementation-poc}"
REPO_DID="${REPO_DID:-did:plc:bbvpwcihkeeztqxk47s5arq3}"
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

echo "Triggering pipeline run via ${SPINDLE_URL}/trigger"
echo "  repo:   $REPO_NAME ($REPO_DID)"
echo "  knot:   $KNOT"
echo "  branch: $DEFAULT_BRANCH"
echo "  sha:    $SHA"
echo "  actor:  $ACTOR_DID"
echo "  rkey:   $PIPELINE_RKEY"

BODY=$(jq -n \
  --arg knot "$KNOT" \
  --arg pipelineRkey "$PIPELINE_RKEY" \
  --arg actor "$ACTOR_DID" \
  --arg repoDid "$REPO_DID" \
  --arg repoName "$REPO_NAME" \
  --arg ref "$SHA" \
  '{knot: $knot, pipelineRkey: $pipelineRkey, actor: $actor, repoDid: $repoDid, repoName: $repoName, ref: $ref}')

echo "$BODY" | tee /dev/stderr \
  | curl -sS -X POST "${SPINDLE_URL}/trigger" -H 'Content-Type: application/json' -d @- \
  | tee /dev/stderr | jq .
