/**
 * Subscription consumer client — refactored to use @publicdomainrelay/xrpc-relay.
 *
 * DISPATCHER_HOST=xrpc-test.fedproxy.com \
 * SUBSCRIBER_DID="did:key:zQ3shmvyWHXrt6aVSx3ibsCk2RkYYNSrF4UA7YWhB1kPYe7B7" \
 * deno run -A client-of-client-example.ts [--cursor 0] [--nsid com.atproto.sync.subscribeRepos]
 *
 * Output: NDJSON. Pipe through jq: ... | jq --unbuffered -rR '(fromjson? // .)'
 */

import { createCaller, log, inferFrameType, summarizeFrame } from "@publicdomainrelay/xrpc-relay";

// ── CLI args ──────────────────────────────────────────────────────

function parseArgs(args: string[]) {
  let cursor: number | undefined;
  let nsid = "com.atproto.sync.subscribeRepos";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cursor" && args[i + 1]) cursor = parseInt(args[++i]);
    if (args[i] === "--nsid" && args[i + 1]) nsid = args[++i];
  }
  return { cursor, nsid };
}

const cli = parseArgs(Deno.args);

// ── config ────────────────────────────────────────────────────────

const DISPATCHER_HOST      = Deno.env.get("DISPATCHER_HOST") ?? "xrpc.fedproxy.com";
const SUBSCRIBER_DID        = Deno.env.get("SUBSCRIBER_DID");
const SUBSCRIBER_SUBDOMAIN  = Deno.env.get("SUBSCRIBER_SUBDOMAIN");

if (!SUBSCRIBER_DID && !SUBSCRIBER_SUBDOMAIN) {
  log("error", { component: "caller", event: "missing_env", message: "set SUBSCRIBER_DID or SUBSCRIBER_SUBDOMAIN" });
  Deno.exit(1);
}

// ── connect ───────────────────────────────────────────────────────

createCaller({
  dispatcherHost: DISPATCHER_HOST,
  subscriberDid: SUBSCRIBER_DID ?? undefined,
  subscriberSubdomain: SUBSCRIBER_SUBDOMAIN ?? undefined,
  nsid: cli.nsid,
  cursor: cli.cursor,
  onEvent: (summary, eventIndex) => {
    log("info", { component: "caller", event: "subscription_event", frameType: (summary as Record<string, unknown>)._type, eventIndex, ...summary });
  },
});
