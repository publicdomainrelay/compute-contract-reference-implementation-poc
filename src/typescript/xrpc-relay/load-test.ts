/**
 * Load test — N subscribers × M callers each against relay.
 *
 *   DISPATCHER_HOST=xrpc-test.fedproxy.com:9999 deno run -A load-test.ts
 *
 * Args:
 *   --subscribers N    number of subscriber instances (default 5)
 *   --callers-per N    callers per subscriber (default 10)
 *   --duration S       test duration seconds (default 30)
 */

import { Secp256k1Keypair } from "npm:@atproto/crypto";
import { Agent, CredentialSession } from "npm:@atproto/api";
import { createSubscriber, createCaller, log, hostnameOnly, didToSubdomain } from "@publicdomainrelay/xrpc-relay";

const DISPATCHER_HOST  = Deno.env.get("DISPATCHER_HOST") ?? "xrpc-test.fedproxy.com";
const ATPROTO_PDS      = Deno.env.get("ATPROTO_PDS") ?? "https://bsky.social";
const ATPROTO_HANDLE   = Deno.env.get("ATPROTO_HANDLE");
const ATPROTO_PASSWORD = Deno.env.get("ATPROTO_PASSWORD");

let SUBSCRIBER_COUNT = 5;
let CALLERS_PER      = 10;
let DURATION_MS      = 30_000;

for (let i = 0; i < Deno.args.length; i++) {
  if (Deno.args[i] === "--subscribers" && Deno.args[i+1]) SUBSCRIBER_COUNT = parseInt(Deno.args[++i]);
  if (Deno.args[i] === "--callers-per" && Deno.args[i+1]) CALLERS_PER = parseInt(Deno.args[++i]);
  if (Deno.args[i] === "--duration" && Deno.args[i+1]) DURATION_MS = parseInt(Deno.args[++i]) * 1000;
}

if (!ATPROTO_HANDLE || !ATPROTO_PASSWORD) {
  log("error", { component: "loadtest", event: "missing_atproto_env" });
  Deno.exit(1);
}

const dispatcherHostname = hostnameOnly(DISPATCHER_HOST);

// ── PDS session ──────────────────────────────────────────────────

log("info", { component: "loadtest", event: "logging_into_pds", pds: ATPROTO_PDS });
const session = new CredentialSession(new URL(ATPROTO_PDS));
await session.login({ identifier: ATPROTO_HANDLE, password: ATPROTO_PASSWORD });
const agent = new Agent(session);

async function getServiceAuthToken(nsid: string): Promise<string> {
  const res = await agent.com.atproto.server.getServiceAuth({ aud: `did:web:${dispatcherHostname}`, lxm: nsid });
  return res.data.token;
}

log("info", { component: "loadtest", event: "pds_logged_in", did: session.did });

// ── spawn subscribers (sequential) ────────────────────────────────

log("info", { component: "loadtest", event: "spawning_subscribers", count: SUBSCRIBER_COUNT });

const subs: Array<{ did: string; subdomain: string; handle: Awaited<ReturnType<typeof createSubscriber>> }> = [];
const subStart = performance.now();

for (let i = 0; i < SUBSCRIBER_COUNT; i++) {
  const kp = await Secp256k1Keypair.create({ exportable: false });
  const did = kp.did();
  const subdomain = didToSubdomain(did);
  const handle = await createSubscriber({
    label: `sub-${i}`,
    keypair: kp,
    getServiceAuthToken,
    dispatcherHost: DISPATCHER_HOST,
    synthetic: true,
  });
  subs.push({ did, subdomain, handle });
}

const subElapsed = (performance.now() - subStart) / 1000;
log("info", { component: "loadtest", event: "subscribers_ready", count: SUBSCRIBER_COUNT, elapsedSec: Math.round(subElapsed * 10) / 10 });

// ── spawn callers ─────────────────────────────────────────────────

const totalCallers = SUBSCRIBER_COUNT * CALLERS_PER;
const callerEventCounts: number[] = new Array(totalCallers).fill(0);

log("info", { component: "loadtest", event: "spawning_callers", count: totalCallers });

const callers: ReturnType<typeof createCaller>[] = [];
for (let si = 0; si < SUBSCRIBER_COUNT; si++) {
  for (let ci = 0; ci < CALLERS_PER; ci++) {
    const idx = si * CALLERS_PER + ci;
    callers.push(createCaller({
      label: `caller-${si}-${ci}`,
      dispatcherHost: DISPATCHER_HOST,
      subscriberDid: subs[si].did,
      onEvent: () => { callerEventCounts[idx]++; },
    }));
  }
}

// ── wait ──────────────────────────────────────────────────────────

log("info", { component: "loadtest", event: "collecting", durationMs: DURATION_MS });
await new Promise((r) => setTimeout(r, DURATION_MS));

// ── stop ──────────────────────────────────────────────────────────

log("info", { component: "loadtest", event: "stopping" });
for (const c of callers) c.close();
for (const s of subs) s.handle.ws.close();

// ── report ────────────────────────────────────────────────────────

const connected = callerEventCounts.filter(c => c > 0).length;
const totalEvents = callerEventCounts.reduce((a, c) => a + c, 0);
const sorted = [...callerEventCounts].sort((a, b) => a - b);

function p50(arr: number[]): number { return arr[Math.floor(arr.length * 0.5)]; }
function p95(arr: number[]): number { return arr[Math.floor(arr.length * 0.95)]; }
function p99(arr: number[]): number { return arr[Math.floor(arr.length * 0.99)]; }
function avg(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }

log("info", {
  component: "loadtest",
  event: "result",
  subscribers: SUBSCRIBER_COUNT,
  callersAttempted: totalCallers,
  callersWithEvents: connected,
  totalEvents,
  eventsPerSec: Math.round(totalEvents / (DURATION_MS / 1000)),
  subscriberRegSec: Math.round(SUBSCRIBER_COUNT / subElapsed),
  eventsPerCaller: { avg: Math.round(avg(sorted)), p50: p50(sorted), p95: p95(sorted), p99: p99(sorted) },
});

const perSub: Record<number, number[]> = {};
for (let si = 0; si < SUBSCRIBER_COUNT; si++) {
  perSub[si] = [];
  for (let ci = 0; ci < CALLERS_PER; ci++) {
    perSub[si].push(callerEventCounts[si * CALLERS_PER + ci]);
  }
}
console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", component: "loadtest", event: "per_subscriber", raw: perSub }));
