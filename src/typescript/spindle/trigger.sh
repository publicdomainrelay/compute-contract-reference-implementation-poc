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
echo "$BODY" | tee /dev/stderr \
  | goat xrpc procedure "$SPINDLE_REF" "$TRIGGER_LXM" 'Content-Type:application/json' - \
  | tee /dev/stderr | jq .
