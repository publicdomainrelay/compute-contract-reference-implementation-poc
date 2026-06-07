// Tangled Spindle — GitHub Actions / policy-engine backend
//
// Wire format mirrors tack (go.mitchellh.com/tack) so the Tangled appview
// treats this as a drop-in spindle.
//
// Env vars:
//   SPINDLE_OWNER_DID     – DID of the spindle operator (required)
//   SPINDLE_HOSTNAME      – public hostname of this spindle (required)
//   POLICY_ENGINE_URL     – base URL of the policy engine server (default: http://localhost:8080)
//   PORT                  – HTTP listen port (default: 8090)
//   DEFAULT_KNOT          – knot to always watch (default: knot1.tangled.sh)
//   JETSTREAM_URL         – Bluesky jetstream WebSocket base URL
//   KNOT_SCHEME           – http or https for bare knot hostnames (default: https)
//   SPINDLE_DB_PATH       – path to JSON state file (default: ./spindle-db.json)
//   SPINDLE_LOGS_DB_PATH  – path to JSON log store (default: ./spindle-logs-db.json)
//   SPINDLE_EVENTS_DB_PATH – path to JSON event-log store for /events backfill
//                           (default: ./spindle-events-db.json)
//   SPINDLE_UNIX_SOCKET   – if set, listen on this Unix socket path instead of PORT
//                           (e.g. /opt/spindle/spindle.sock — used behind Caddy)
//   COMPUTE_PROVIDER      – set to "market.rfp" to provision VMs via ATProto marketplace
//                           (also requires ATPROTO_HANDLE, ATPROTO_PASSWORD, and optional
//                            ATP_RELAY_URL, FEDPROXY_HOST, VM_* — see marketRFP.ts)
//
// Workflow retrieval:
//   On each trigger the spindle fetches .github/workflows/*.yml directly from
//   the knot that dispatched the event, using sh.tangled.repo.tree +
//   sh.tangled.repo.blob at the exact commit SHA supplied in the trigger
//   payload.  No local checkout or REPO_PATH is needed.

import { Hono } from "jsr:@hono/hono";
import { parse as parseYaml } from "jsr:@std/yaml";
import { marketRFPSubmitWorkflow, marketRFPConfigFromEnv, pendingBids } from "./marketRFP.ts";

// ---------------------------------------------------------------------------
// Structured logger — JSON to stderr
// ---------------------------------------------------------------------------

type LogLevel = "info" | "warn" | "error" | "debug";

const enc = new TextEncoder();

function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  Deno.stderr.writeSync(enc.encode(entry + "\n"));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OWNER_DID = Deno.env.get("SPINDLE_OWNER_DID") ?? "";
const HOSTNAME = Deno.env.get("SPINDLE_HOSTNAME") ?? "localhost";
const POLICY_ENGINE_URL = Deno.env.get("POLICY_ENGINE_URL") ?? "http://localhost:8080";
const PORT = parseInt(Deno.env.get("PORT") ?? "8090", 10);
const UNIX_SOCKET = Deno.env.get("SPINDLE_UNIX_SOCKET") ?? "";
// COMPUTE_PROVIDER=market.rfp provisions VMs via ATProto marketplace instead of local PE
const COMPUTE_PROVIDER = Deno.env.get("COMPUTE_PROVIDER") ?? "";

// Derive owner DID from the leftmost subdomain when SPINDLE_OWNER_DID is not set.
// did-plc-aaa.gha.spindle.example.com → did:plc:aaa
function subdomainToDID(host: string): string {
  const leftmost = host.split(".")[0] ?? "";
  return leftmost.replace(/-/g, ":");
}

function getOwnerDid(host: string): string {
  if (OWNER_DID) return OWNER_DID;
  return subdomainToDID(host);
}

// did:plc:aaa → did-plc-aaa
function didToSubdomain(did: string): string {
  return did.replace(/:/g, "-");
}

// When SPINDLE_OWNER_DID is set: effective hostname is HOSTNAME.
// When dynamic subdomain mode: each owner gets <did-slug>.HOSTNAME.
function effectiveHostname(ownerDid: string): string {
  if (OWNER_DID) return HOSTNAME;
  return didToSubdomain(ownerDid) + "." + HOSTNAME;
}

// Returns true if a repo's spindle field points at this spindle instance.
function matchesThisSpindle(spindle: string | undefined, repoDid: string): boolean {
  if (!spindle) return false;
  if (OWNER_DID) return spindle === HOSTNAME;
  return spindle === effectiveHostname(repoDid);
}

// ---------------------------------------------------------------------------
// Types — knot XRPC responses
// ---------------------------------------------------------------------------

interface KnotTreeEntry {
  name: string;
  mode: string;
  size: number;
}

interface KnotTreeOutput {
  ref: string;
  files: KnotTreeEntry[];
}

interface KnotBlobOutput {
  ref: string;
  path: string;
  content?: string;   // UTF-8 text or base64 for binary
  encoding?: string;  // "utf-8" | "base64"
  isBinary?: boolean;
}

// ---------------------------------------------------------------------------
// Types — policy engine
// ---------------------------------------------------------------------------

interface PolicyEngineRequest {
  workflow: unknown;  // parsed YAML → JSON object
  context: Record<string, unknown>;
  inputs?: Record<string, string>;
}

interface PolicyEngineStatus {
  status: "submitted" | "in_progress" | "complete" | "unknown" | "input_validation_error";
  detail: { id: string; exit_status?: string; [k: string]: unknown };
  console_output?: string;
}

// ---------------------------------------------------------------------------
// Types — tangled wire format
// ---------------------------------------------------------------------------

// eventsEnvelope is the wire shape emitted on /events WebSocket frames.
// Must match tack's eventsEnvelope byte-for-byte.
interface EventsEnvelope {
  rkey: string;
  nsid: string;
  event: unknown;
  created: number; // unix nanoseconds
}

interface PipelineStatusRecord {
  $type: "sh.tangled.pipeline.status";
  workflow: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  createdAt: string;
  pipeline?: string;  // AT-URI of the pipeline record: at://did:web:<knot>/sh.tangled.pipeline/<rkey>
}

interface LogLine {
  kind: "data" | "control";
  content: string;
  time: string;
  step_id: number;
  stream?: string;
  step_status?: string;
  step_kind?: number; // int iota: 0=system (collapsed), 1=user (expanded)
  step_command?: string;
}

// Inbound trigger payload — mirrors sh.tangled.pipeline fields we care about.
interface TriggerPayload {
  knot: string;          // knot hostname, e.g. "knot.example.com"
  pipelineRkey: string;  // atproto record key of the pipeline record
  actor: string;         // DID of the actor who pushed
  repoDid: string;       // DID of the repo (owner DID for sh.tangled.repo.blob)
  repoName: string;      // human name, e.g. "myrepo"
  ref: string;           // commit SHA (newSha from pushTriggerData)
  inputs?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Run {
  taskId: string;
  workflow: string;       // filename stem (no .yml/.yaml)
  knot: string;
  pipelineRkey: string;
  actor: string;
  repoDid: string;
  ref: string;
  startedAt: Date;
  status: PolicyEngineStatus["status"];
  peUrl: string;
}

// runKey(knot, pipelineRkey, workflow) → Run
const runs = new Map<string, Run>();

// Pre-PE log lines collected during marketRFP provisioning (runKey → lines)
const preRunLogs = new Map<string, string[]>();

// WebSocket subscribers for /events
const subscribers = new Set<WebSocket>();

// Persisted event log for /events cursor backfill (capped ring).
// Backed by a JSON file so backfill survives process restarts — matches core's
// DB-backed eventstream.Store. Without this, status events emitted while no
// subscriber is connected are lost on restart and never reach the appview.
const eventLog: EventsEnvelope[] = [];
const MAX_EVENT_LOG = 1000;
const EVENTS_DB_PATH = Deno.env.get("SPINDLE_EVENTS_DB_PATH") ?? "./spindle-events-db.json";

function loadEventLog(): void {
  try {
    const raw = Deno.readTextFileSync(EVENTS_DB_PATH);
    const parsed = JSON.parse(raw) as EventsEnvelope[];
    if (Array.isArray(parsed)) {
      // Keep only the most recent MAX_EVENT_LOG entries.
      for (const e of parsed.slice(-MAX_EVENT_LOG)) eventLog.push(e);
    }
  } catch {
    // missing/corrupt → start empty
  }
}

function saveEventLog(): void {
  try {
    Deno.writeTextFileSync(EVENTS_DB_PATH, JSON.stringify(eventLog));
  } catch (err) {
    log("error", "event log save failed", { path: EVENTS_DB_PATH, err: String(err) });
  }
}

loadEventLog();
log("info", "event log loaded", { path: EVENTS_DB_PATH, events: eventLog.length });

// Keep-alive interval. fedproxy idle-closes a WS that sends no DATA frames —
// and crucially it does NOT count native WS ping control frames as activity
// (verified: a ping-only connection is dropped at ~5s). So core's native-ping
// keepalive does not survive fedproxy; we must send an application-level data
// frame. A {"type":"ping"} frame unmarshals to a zero-value Event on the Go
// consumer (Nsid="" → ignored), so it is harmless. fedproxy's idle cutoff is
// variable (observed 5–13s); 2s matches the run-broadcast cadence that demonstrably
// held a connection 35s+, so it keeps idle connections stable (no reconnect churn).
const KEEPALIVE_MS = 2_000;

// ---------------------------------------------------------------------------
// Secrets store  (in-memory; keyed by repoDid → key → SecretEntry)
// ---------------------------------------------------------------------------

interface SecretEntry {
  key: string;
  value: string;
  repo: string;       // repoDid
  createdAt: string;  // ISO-8601
  createdBy: string;  // DID
}

// secrets[repoDid][key] = SecretEntry
const secretsStore = new Map<string, Map<string, SecretEntry>>();

function repoSecrets(repoDid: string): Map<string, SecretEntry> {
  let m = secretsStore.get(repoDid);
  if (!m) { m = new Map(); secretsStore.set(repoDid, m); }
  return m;
}

// ---------------------------------------------------------------------------
// Config — knot discovery
// ---------------------------------------------------------------------------

const JETSTREAM_URL = Deno.env.get("JETSTREAM_URL") ?? "wss://jetstream2.us-east.bsky.network/subscribe";
const DEFAULT_KNOT  = Deno.env.get("DEFAULT_KNOT")  ?? "knot1.tangled.sh";
const DB_PATH       = Deno.env.get("SPINDLE_DB_PATH") ?? "./spindle-db.json";
const LOGS_DB_PATH  = Deno.env.get("SPINDLE_LOGS_DB_PATH") ?? "./spindle-logs-db.json";

// repoDid -> the spindle hostname recorded on its sh.tangled.repo record (matched
// via matchesThisSpindle). Triggers arriving for any other repoDid are silently
// ignored. The recorded hostname is the actual public hostname for that repo —
// used instead of re-deriving one from the repoDid, which may not be the owner DID.
const repoDidToSpindle = new Map<string, string>();

// Public hostname to use for a given repo: the hostname its sh.tangled.repo
// record actually points at, falling back to our default HOSTNAME.
function hostnameForRepo(repoDid: string): string {
  return repoDidToSpindle.get(repoDid) ?? HOSTNAME;
}

// ---------------------------------------------------------------------------
// JSON file DB — persists knot cursors across restarts
// ---------------------------------------------------------------------------

interface PersistedRun {
  taskId: string;
  workflow: string;
  knot: string;
  pipelineRkey: string;
  actor: string;
  repoDid: string;
  ref: string;
  startedAt: string;
  status: string;
  peUrl: string;
}

interface SpindleDB {
  cursors: Record<string, number>; // knot hostname → last seen event nanosecond timestamp
  runs: Record<string, PersistedRun>; // runKey → persisted run
}

function loadDB(): SpindleDB {
  try {
    const raw = Deno.readTextFileSync(DB_PATH);
    const parsed = JSON.parse(raw) as SpindleDB;
    if (!parsed.runs) parsed.runs = {};
    return parsed;
  } catch {
    return { cursors: {}, runs: {} };
  }
}

function saveDB(db: SpindleDB): void {
  try {
    Deno.writeTextFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (err) {
    log("error", "db save failed", { path: DB_PATH, err: String(err) });
  }
}

const db = loadDB();
log("info", "db loaded", { path: DB_PATH, knots: Object.keys(db.cursors), persistedRuns: Object.keys(db.runs).length });

// ---------------------------------------------------------------------------
// JSON file DB — persists run console output across restarts
// ---------------------------------------------------------------------------

interface SpindleLogsDB {
  logs: Record<string, string>; // runKey → raw console output
}

function loadLogsDB(): SpindleLogsDB {
  try {
    const raw = Deno.readTextFileSync(LOGS_DB_PATH);
    const parsed = JSON.parse(raw) as SpindleLogsDB;
    if (!parsed.logs) parsed.logs = {};
    return parsed;
  } catch {
    return { logs: {} };
  }
}

function saveLogsDB(ldb: SpindleLogsDB): void {
  try {
    Deno.writeTextFileSync(LOGS_DB_PATH, JSON.stringify(ldb, null, 2));
  } catch (err) {
    log("error", "logs db save failed", { path: LOGS_DB_PATH, err: String(err) });
  }
}

const logsDB = loadLogsDB();
log("info", "logs db loaded", { path: LOGS_DB_PATH, storedRuns: Object.keys(logsDB.logs).length });

function persistRunLog(key: string, output: string): void {
  logsDB.logs[key] = output;
  saveLogsDB(logsDB);
}

// Restore persisted runs into the in-memory Map so /logs works across restarts.
for (const [key, pr] of Object.entries(db.runs)) {
  runs.set(key, {
    taskId: pr.taskId,
    workflow: pr.workflow,
    knot: pr.knot,
    pipelineRkey: pr.pipelineRkey,
    actor: pr.actor,
    repoDid: pr.repoDid,
    ref: pr.ref,
    startedAt: new Date(pr.startedAt),
    status: pr.status as Run["status"],
    peUrl: pr.peUrl ?? POLICY_ENGINE_URL, // legacy records without peUrl fall back to env
  });
}

function getCursor(knot: string): number {
  return db.cursors[knot] ?? 0;
}

function setCursor(knot: string, cursor: number): void {
  db.cursors[knot] = cursor;
  saveDB(db);
}

// ---------------------------------------------------------------------------
// DID → PDS resolution
// ---------------------------------------------------------------------------

async function resolvePDS(did: string): Promise<string | null> {
  try {
    let didDoc: Record<string, unknown>;
    if (did.startsWith("did:plc:")) {
      const res = await fetch(`https://plc.directory/${did}`);
      if (!res.ok) return null;
      didDoc = await res.json();
    } else if (did.startsWith("did:web:")) {
      const domain = did.slice("did:web:".length);
      const res = await fetch(`https://${domain}/.well-known/did.json`);
      if (!res.ok) return null;
      didDoc = await res.json();
    } else {
      return null;
    }
    type Service = { id: string; type: string; serviceEndpoint: string };
    const services = (didDoc.service as Service[]) ?? [];
    const pds = services.find(
      (s) => s.type === "AtprotoPersonalDataServer" || s.id === "#atproto_pds",
    );
    return pds?.serviceEndpoint ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Knot event-stream subscriber
// ---------------------------------------------------------------------------

const watchedKnots = new Set<string>();

interface PipelineTriggerRecord {
  $type?: string;
  triggerMetadata?: {
    kind: string;
    repo?: {
      did?: string;
      knot?: string;
      repo?: string;
      repoDid?: string;
      defaultBranch?: string;
    };
    push?: { newSha: string; oldSha: string; ref: string };
    manual?: { inputs?: Array<{ key: string; value: string }> };
  };
}

function watchKnot(knot: string): void {
  if (watchedKnots.has(knot)) return;
  watchedKnots.add(knot);

  const scheme = KNOT_SCHEME === "http" ? "ws" : "wss";
  // bare hostname → ws(s)://host/events; explicit URL → replace scheme
  const wsBase = (knot.startsWith("http://") || knot.startsWith("https://"))
    ? knot.replace(/^https?/, scheme) + "/events"
    : `${scheme}://${knot}/events`;

  function connect() {
    // Seed cursor to now on first connect for this knot so we don't replay history.
    if (!db.cursors[knot]) {
      setCursor(knot, Date.now() * 1_000_000);
    }
    const cursor = getCursor(knot);
    const wsUrl = cursor ? `${wsBase}?cursor=${cursor}` : wsBase;

    log("info", "knot connecting", { knot, url: wsUrl, cursor });
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      log("error", "knot ws create failed", { knot, err: String(err) });
      setTimeout(connect, 15_000);
      return;
    }

    ws.onopen = () => log("info", "knot connected", { knot, cursor });

    ws.onmessage = async (evt) => {
      let envelope: EventsEnvelope;
      try {
        const raw = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer);
        envelope = JSON.parse(raw);
      } catch {
        return;
      }

      // Advance cursor on every message regardless of type.
      if (typeof envelope.created === "number" && envelope.created > getCursor(knot)) {
        setCursor(knot, envelope.created);
      }

      if (envelope.nsid !== "sh.tangled.pipeline") return;

      const rec = envelope.event as PipelineTriggerRecord;
      const meta = rec?.triggerMetadata;
      if (!meta?.repo) return;

      const triggerKnot  = meta.repo.knot ?? knot;
      const actor        = meta.repo.did ?? "";
      const repoDid      = meta.repo.repoDid ?? "";
      const repoName     = meta.repo.repo ?? "";
      const pipelineRkey = envelope.rkey;

      let ref = "";
      if (meta.kind === "push" && meta.push) {
        ref = meta.push.newSha;
      } else if (meta.repo.defaultBranch) {
        ref = meta.repo.defaultBranch;
      }

      if (!repoDid || !ref) {
        // DO NOT UNCOMMENT THIS LINE log("debug", "knot trigger skipped: missing repoDid or ref", { repoDid, ref, pipelineRkey, knot });
        return;
      }

      // Ignore triggers for repos that haven't opted into this spindle.
      if (!repoDidToSpindle.has(repoDid)) {
        // DO NOT UNCOMMENT THIS LINE log("debug", "knot trigger ignored: repo not authorized", { repoDid, repoName, knot });
        return;
      }

      const inputs: Record<string, string> = {};
      for (const { key, value } of meta.manual?.inputs ?? []) inputs[key] = value;

      log("info", "pipeline trigger received", { knot: triggerKnot, repo: repoName, repoDid, ref, pipelineRkey });

      const trigger: TriggerPayload = {
        knot: triggerKnot,
        pipelineRkey,
        actor,
        repoDid,
        repoName,
        ref,
        ...(Object.keys(inputs).length ? { inputs } : {}),
      };

      triggerWorkflows(trigger).catch((err) =>
        log("error", "triggerWorkflows failed", { knot, repoName, ref, err: String(err) })
      );
    };

    ws.onerror = (err) => log("error", "knot ws error", { knot, err: String(err) });
    ws.onclose = () => {
      log("info", "knot disconnected, reconnecting in 10s", { knot });
      setTimeout(connect, 10_000);
    };
  }

  connect();
}

// ---------------------------------------------------------------------------
// AT Proto repo discovery — listRecords sh.tangled.repo for OWNER_DID
// ---------------------------------------------------------------------------

async function discoverKnotsFromATProto(ownerDid?: string): Promise<void> {
  const did = ownerDid ?? OWNER_DID;
  if (!did) return;
  const pds = await resolvePDS(did);
  if (!pds) {
    log("warn", "knot-discovery: could not resolve PDS", { did });
    return;
  }

  let cursor: string | undefined;
  let foundKnots = 0;
  let foundRepos = 0;
  for (;;) {
    const url = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", "sh.tangled.repo");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    let data: { records: Array<{ value: Record<string, unknown> }>; cursor?: string };
    try {
      const res = await fetch(url);
      if (!res.ok) { log("warn", "knot-discovery: listRecords failed", { status: res.status }); break; }
      data = await res.json();
    } catch (err) {
      log("error", "knot-discovery: listRecords error", { err: String(err) });
      break;
    }

    for (const rec of data.records ?? []) {
      const knot    = rec.value.knot    as string | undefined;
      const spindle = rec.value.spindle as string | undefined;
      const repoDid = rec.value.repoDid as string | undefined;
      const repoName = rec.value.name   as string | undefined;
      log("debug", "knot-discovery: record", { knot, spindle, repoDid, repoName, matchesHostname: matchesThisSpindle(spindle, repoDid ?? "") });
      if (knot && matchesThisSpindle(spindle, repoDid ?? "")) {
        watchKnot(knot);
        foundKnots++;
      }
      if (repoDid && spindle && matchesThisSpindle(spindle, repoDid)) {
        repoDidToSpindle.set(repoDid, spindle);
        log("info", "knot-discovery: authorized repo", { repoDid, repoName, knot });
        foundRepos++;
      }
    }

    if (!data.cursor || data.records.length === 0) break;
    cursor = data.cursor;
  }

  log("info", "knot-discovery complete", { knots: foundKnots, authorizedRepos: foundRepos });
}

// ---------------------------------------------------------------------------
// Jetstream — dynamically subscribe new knots as repos point at us
// ---------------------------------------------------------------------------

function startJetstreamWatcher(): void {
  const url = new URL(JETSTREAM_URL);
  url.searchParams.set("wantedCollections", "sh.tangled.repo");

  function connect() {
    log("info", "jetstream connecting", { url: url.toString() });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log("error", "jetstream connect failed", { err: String(err) });
      setTimeout(connect, 30_000);
      return;
    }

    ws.onmessage = (evt) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer)); }
      catch { return; }

      const commit = msg.commit as Record<string, unknown> | undefined;
      const record = commit?.record as Record<string, unknown> | undefined;
      if (!record) return;

      const spindle = record.spindle as string | undefined;
      const knot    = record.knot    as string | undefined;
      const repoDid = record.repoDid as string | undefined;
      if (matchesThisSpindle(spindle, repoDid ?? "")) {
        if (knot) {
          log("info", "jetstream: new repo points at this spindle", { knot, repoDid });
          watchKnot(knot);
        }
        if (repoDid && spindle) {
          repoDidToSpindle.set(repoDid, spindle);
        }
      }
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      log("info", "jetstream disconnected, reconnecting in 30s");
      setTimeout(connect, 30_000);
    };
  }

  connect();
}

// ---------------------------------------------------------------------------
// Startup: watch knots
// ---------------------------------------------------------------------------

async function startKnotDiscovery(): Promise<void> {
  watchKnot(DEFAULT_KNOT);
  await discoverKnotsFromATProto();
  startJetstreamWatcher();
  // re-poll AT Proto records every 5 min to catch newly added repos
  setInterval(discoverKnotsFromATProto, 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Knot XRPC helpers
// ---------------------------------------------------------------------------

// Resolve knot hostname/URL to a base URL.
// Accepts bare hostnames ("knot.example.com", "mock-knot:8091") which are
// promoted to https, or explicit URLs ("http://mock-knot:8091") left as-is.
// Set KNOT_SCHEME=http to override the default scheme for all bare hostnames
// (useful for local / isolated test environments).
const KNOT_SCHEME = Deno.env.get("KNOT_SCHEME") ?? "https";

function knotBaseUrl(knot: string): string {
  if (knot.startsWith("http://") || knot.startsWith("https://")) return knot;
  return `${KNOT_SCHEME}://${knot}`;
}

// Fetch the file listing for .github/workflows at a specific commit SHA.
async function fetchWorkflowTree(
  knot: string,
  repoDid: string,
  ref: string,
): Promise<KnotTreeEntry[]> {
  const url = new URL(`${knotBaseUrl(knot)}/xrpc/sh.tangled.repo.tree`);
  url.searchParams.set("repo", repoDid);
  url.searchParams.set("ref", ref);
  url.searchParams.set("path", ".github/workflows");

  const res = await fetch(url);
  if (res.status === 404) return []; // directory doesn't exist
  if (!res.ok) {
    throw new Error(`tree fetch ${res.status}: ${await res.text()}`);
  }
  const out: KnotTreeOutput = await res.json();
  return (out.files ?? []).filter(
    (f) => f.name.endsWith(".yml") || f.name.endsWith(".yaml"),
  );
}

// Fetch raw YAML text for one workflow file from the knot.
async function fetchWorkflowBlob(
  knot: string,
  repoDid: string,
  ref: string,
  filePath: string, // e.g. ".github/workflows/ci.yml"
): Promise<string> {
  const url = new URL(`${knotBaseUrl(knot)}/xrpc/sh.tangled.repo.blob`);
  url.searchParams.set("repo", repoDid);
  url.searchParams.set("ref", ref);
  url.searchParams.set("path", filePath);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`blob fetch ${res.status}: ${await res.text()}`);
  }
  const out: KnotBlobOutput = await res.json();
  if (!out.content) throw new Error(`blob returned no content for ${filePath}`);

  if (out.encoding === "base64" || out.isBinary) {
    // Decode base64 → bytes → UTF-8 string
    const bytes = Uint8Array.from(atob(out.content), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return out.content;
}

// Fetch all .github/workflows from the knot at `ref`, returning a map of
// stem → parsed YAML object ready for the policy engine.
async function fetchWorkflows(
  knot: string,
  repoDid: string,
  ref: string,
): Promise<Map<string, unknown>> {
  const entries = await fetchWorkflowTree(knot, repoDid, ref);
  const result = new Map<string, unknown>();

  await Promise.all(
    entries.map(async (entry) => {
      const stem = entry.name.replace(/\.(yml|yaml)$/, "");
      const filePath = `.github/workflows/${entry.name}`;
      try {
        const text = await fetchWorkflowBlob(knot, repoDid, ref, filePath);
        result.set(stem, parseYaml(text));
      } catch (err) {
        log("error", "fetch workflow blob failed", { path: filePath, err: String(err) });
      }
    }),
  );

  return result;
}

// ---------------------------------------------------------------------------
// Policy engine helpers
// ---------------------------------------------------------------------------

async function submitWorkflow(
  workflowObj: unknown,
  trigger: TriggerPayload,
): Promise<string> {
  const req: PolicyEngineRequest = {
    workflow: workflowObj,
    context: {
      config: {
        env: {
          GITHUB_ACTOR: trigger.actor,
          GITHUB_REPOSITORY: `${trigger.repoDid}/${trigger.repoName}`,
          GITHUB_SHA: trigger.ref,
          GITHUB_REF: trigger.ref,
          GITHUB_SERVER_URL: `https://${trigger.knot}`,
          SPINDLE_HOSTNAME: hostnameForRepo(trigger.repoDid),
          // Used by .tangled/actions/*/checkout and BUNDLED_ACTIONS_DIR overrides
          SPINDLE_KNOT: knotBaseUrl(trigger.knot),
          SPINDLE_REPO_DID: trigger.repoDid,
        },
      },
    },
    inputs: trigger.inputs,
  };

  const res = await fetch(`${POLICY_ENGINE_URL}/request/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    throw new Error(`policy engine create ${res.status}: ${await res.text()}`);
  }

  const status: PolicyEngineStatus = await res.json();
  const taskId = status.detail?.id as string;
  if (!taskId) throw new Error("policy engine returned no task ID");
  // TODO There could be secrets in the req
  log("debug", "submitted policy engine request got response", { req: req, status: status });
  return taskId;
}

// ---------------------------------------------------------------------------
// Event fan-out
// ---------------------------------------------------------------------------

// Strictly-monotonic nanosecond clock for event `created`, mirroring core's
// eventstream.Insert (lastNanos+1 guard) so same-millisecond events get distinct,
// increasing cursors and backfill never skips a sibling.
// NOTE: Date.now()*1e6 (~1.78e18) exceeds Number.MAX_SAFE_INTEGER (~9e15), so the
// float64 step at this magnitude is ~256, and a naive +1 would round away. Bump
// by 1e6 (1ms-equivalent) — representable and strictly greater — on collision.
let lastNanos = 0;
function nowNs(): number {
  let now = Date.now() * 1_000_000;
  if (now <= lastNanos) now = lastNanos + 1_000_000;
  lastNanos = now;
  return now;
}

// Generate a sortable timestamp-based record key (TID), matching
// tangled.org/core/tid format: base32-sortable microseconds + clock ID.
function makeTID(): string {
  const us = BigInt(Date.now()) * 1000n;
  const chars = "234567abcdefghijklmnopqrstuvwxyz";
  let n = us;
  let s = "";
  for (let i = 0; i < 10; i++) {
    s = chars[Number(n & 31n)] + s;
    n >>= 5n;
  }
  // append 3 random chars as clock-id
  for (let i = 0; i < 3; i++) s += chars[Math.floor(Math.random() * 32)];
  return s;
}

function peStatusToTangled(s: PolicyEngineStatus["status"]): PipelineStatusRecord["status"] {
  switch (s) {
    case "submitted":   return "pending";
    case "in_progress": return "running";
    case "complete":    return "success"; // exit_status checked separately
    default:            return "failed";
  }
}

function broadcastStatus(
  rkey: string,
  workflow: string,
  peStatus: PolicyEngineStatus["status"],
  exitStatus?: string,
  knot?: string,
  pipelineRkey?: string,
): void {
  let s = peStatusToTangled(peStatus);
  if (peStatus === "complete" && exitStatus && exitStatus !== "success") {
    s = "failed";
  }

  const pipeline = knot && pipelineRkey
    ? `at://did:web:${knot}/sh.tangled.pipeline/${pipelineRkey}`
    : undefined;

  const record: PipelineStatusRecord = {
    $type: "sh.tangled.pipeline.status",
    workflow,
    status: s,
    createdAt: new Date().toISOString(),
    ...(pipeline ? { pipeline } : {}),
  };
  // Use a unique TID per event so the appview doesn't deduplicate status updates.
  const eventRkey = makeTID();
  const envelope: EventsEnvelope = {
    rkey: eventRkey,
    nsid: "sh.tangled.pipeline.status",
    event: record,
    created: nowNs(),
  };

  // Store for cursor backfill on reconnect (durably, survives restart)
  if (eventLog.length >= MAX_EVENT_LOG) eventLog.shift();
  eventLog.push(envelope);
  saveEventLog();

  const msg = JSON.stringify(envelope);
  let sent = 0;
  for (const ws of subscribers) {
    try {
      ws.send(msg);
      sent++;
    } catch (err) {
      subscribers.delete(ws);
      log("error", "deleted subscriber", { err: String(err), ws: ws });
    }
  }
  log("info", "broadcastStatus", { eventRkey, pipelineRkey: rkey, peStatus, tangled: s, exitStatus, pipeline, subscribers: subscribers.size, sent });
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function runKey(knot: string, pipelineRkey: string, workflow: string): string {
  return `${knot}/${pipelineRkey}/${workflow}`;
}

async function trackRun(run: Run): Promise<void> {
  const rkey = `${run.pipelineRkey}/${run.workflow}`;

  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));

    let status: PolicyEngineStatus;
    try {
      const res = await fetch(`${run.peUrl}/request/status/${run.taskId}`);
      status = await res.json();
      log("info", "check policy engine status got", { status: status });
    } catch (err) {
      log("error", "check policy engine status for run failed", { err: String(err), run: run });
      continue;
    }

    run.status = status.status;

    const terminal = status.status === "complete" || status.status === "unknown";

    const exitStatus = status.detail?.exit_status as string | undefined;
    broadcastStatus(rkey, run.workflow, status.status, exitStatus, run.knot, run.pipelineRkey);

    if (terminal) {
      log("info", "trackRun terminal", { taskId: run.taskId, workflow: run.workflow, status: status.status, exitStatus });
      // Persist console output so /logs works after a server restart.
      const key = runKey(run.knot, run.pipelineRkey, run.workflow);
      try {
        let output = status.console_output ?? "";
        if (!output) {
          const r = await fetch(`${run.peUrl}/request/console_output/${run.taskId}`);
          if (r.ok) output = await r.text();
        }
        if (output) persistRunLog(key, output);
      } catch (err) {
        log("warn", "trackRun: failed to persist run log", { taskId: run.taskId, err: String(err) });
      }
      break;
    }
  }
}

async function triggerWorkflows(trigger: TriggerPayload): Promise<string[]> {
  const workflows = await fetchWorkflows(trigger.knot, trigger.repoDid, trigger.ref);
  if (workflows.size === 0) {
    log("warn", "no .github/workflows found", { repoDid: trigger.repoDid, ref: trigger.ref, knot: trigger.knot });
    return [];
  }
  log("info", "found .github/workflows", { repoDid: trigger.repoDid, ref: trigger.ref, knot: trigger.knot, workflows: [...workflows.keys()] });

  const submitted: string[] = [];

  await Promise.all(
    [...workflows.entries()].map(async ([stem, wfObj]) => {
      const key = runKey(trigger.knot, trigger.pipelineRkey, stem);
      const rkey = `${trigger.pipelineRkey}/${stem}`;

      let taskId: string;
      let peUrl: string = POLICY_ENGINE_URL;
      broadcastStatus(rkey, stem, "submitted", undefined, trigger.knot, trigger.pipelineRkey);
      try {
        if (COMPUTE_PROVIDER === "market.rfp") {
          const rfpConfig = marketRFPConfigFromEnv();
          const preLogs: string[] = [];
          preRunLogs.set(key, preLogs);
          const result = await marketRFPSubmitWorkflow(wfObj, trigger, rfpConfig, hostnameForRepo(trigger.repoDid), (line) => preLogs.push(line));
          taskId = result.taskId;
          peUrl = result.peUrl;
        } else {
          taskId = await submitWorkflow(wfObj, trigger);
        }
      } catch (err) {
        const msg = String(err);
        const noBid = msg.includes("No bids received") || msg.includes("No scoreable bid");
        log("error", "submit workflow failed", { workflow: stem, repoDid: trigger.repoDid, noBid, err: msg });
        if (noBid) {
          broadcastStatus(rkey, stem, "unknown", "no-bid", trigger.knot, trigger.pipelineRkey);
        } else {
          broadcastStatus(rkey, stem, "unknown", "error", trigger.knot, trigger.pipelineRkey);
        }
        return;
      }

      const run: Run = {
        taskId,
        workflow: stem,
        knot: trigger.knot,
        pipelineRkey: trigger.pipelineRkey,
        actor: trigger.actor,
        repoDid: trigger.repoDid,
        ref: trigger.ref,
        startedAt: new Date(),
        status: "submitted",
        peUrl,
      };
      runs.set(key, run);
      db.runs[key] = {
        taskId: run.taskId,
        workflow: run.workflow,
        knot: run.knot,
        pipelineRkey: run.pipelineRkey,
        actor: run.actor,
        repoDid: run.repoDid,
        ref: run.ref,
        startedAt: run.startedAt.toISOString(),
        status: run.status,
        peUrl: run.peUrl,
      };
      saveDB(db);
      submitted.push(stem);

      log("info", "submitted", { run: run });
      trackRun(run).catch((err) => log("error", "trackRun failed", { workflow: stem, taskId, err: String(err) }));
    }),
  );

  return submitted;
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

app.use("*", (c, next) => {
  log("info", "request", { method: c.req.method, path: c.req.path });
  return next();
});

app.get("/", (c) =>
  c.text(`

  _________      .__            .___.__
 /   _____/_____ |__| ____    __| _/|  |   ____
 \\_____  \\\\____ \\|  |/    \\  / __ | |  | _/ __ \\
 /        \\  |_> >  |   |  \\/ /_/ | |  |_\\  ___/
/_______  /   __/|__|___|  /\\____ | |____/\\___  >
        \\/|__|           \\/      \\/           \\/

tangled-spindle-minimal: runs .github/workflows via the policy engine.

Routes:
  GET  /                                      this page
  GET  /xrpc/sh.tangled.owner                 spindle owner DID
  GET  /events                                pipeline status WebSocket
  GET  /logs/:knot/:pipelineRkey/:workflow          console output
  GET  /status/:knot/:pipelineRkey/:workflow        run status JSON
  POST /trigger                                     submit a pipeline trigger
  POST /xrpc/sh.tangled.pipeline.cancelPipeline     cancel a run { pipeline, repo, workflow }
  GET  /xrpc/sh.tangled.repo.listSecrets?repo=DID  list secrets (keys only)
  POST /xrpc/sh.tangled.repo.addSecret             add secret { repo, key, value }
  POST /xrpc/sh.tangled.repo.removeSecret          remove secret { repo, key }
  POST /xrpc/com.publicdomainrelay.temp.market.submitBid  submit bid { uri, cid } directly

Spindle hostname : ${(() => { const h = c.req.header("host"); return h ? effectiveHostname(getOwnerDid(h)) : HOSTNAME; })()}
Owner DID        : ${getOwnerDid(c.req.header("host") ?? HOSTNAME)}
Policy engine    : ${POLICY_ENGINE_URL}
`));

// sh.tangled.owner — required for appview spindle registration
app.get("/xrpc/sh.tangled.owner", (c) => {
  const host = c.req.header("host") ?? HOSTNAME;
  return c.json({ owner: getOwnerDid(host) });
});

// /events — WebSocket fan-out of sh.tangled.pipeline.status events.
// Accepts ?cursor=<nanoseconds> for backfill; replays all stored events
// with created > cursor before going live, matching core spindle behaviour.
// Emits event envelopes plus a periodic {"type":"ping"} data-frame keepalive
// (ignored by the Go consumer) required to survive fedproxy's idle timeout.
app.get("/events", (c) => {
  const cursorStr = c.req.query("cursor");
  const cursor = cursorStr ? parseInt(cursorStr, 10) : 0;
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  socket.onopen = () => {
    const backfill = cursor > 0
      ? eventLog.filter((e) => e.created > cursor)
      : eventLog.slice();
    for (const envelope of backfill) {
      try { socket.send(JSON.stringify(envelope)); } catch { /* ignore */ }
    }
    subscribers.add(socket);
    keepAlive = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
    }, KEEPALIVE_MS);
  };
  const cleanup = () => {
    if (keepAlive !== undefined) clearInterval(keepAlive);
    subscribers.delete(socket);
  };
  socket.onclose = cleanup;
  socket.onerror = cleanup;

  return response;
});

// /logs — WebSocket stream of LogLine JSON frames, wire-compatible with
// core spindle (tangled.org/core/spindle/models.LogLine). 404 is returned
// as a plain HTTP error before the upgrade so callers see a real status code.
app.get("/logs/:knot/:pipelineRkey/:workflow", (c) => {
  const key = runKey(
    c.req.param("knot"),
    c.req.param("pipelineRkey"),
    c.req.param("workflow"),
  );
  const run = runs.get(key);
  if (!run) return c.text("run not found\n", 404);

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

  // Data-frame keepalive so fedproxy doesn't idle-close while a live pipeline is
  // between log lines. A {"type":"ping"} frame has Kind="" → ignored by the
  // appview's LogLine switch (renders an empty fragment). Native WS pings don't
  // survive fedproxy, so a data frame is required. Cleared on completion/disconnect.
  let logKeepAlive: ReturnType<typeof setInterval> | undefined;
  const stopLogKeepAlive = () => {
    if (logKeepAlive !== undefined) { clearInterval(logKeepAlive); logKeepAlive = undefined; }
  };
  socket.onclose = stopLogKeepAlive;
  socket.onerror = stopLogKeepAlive;

  socket.onopen = async () => {
    logKeepAlive = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ type: "ping" })); } catch { /* closed */ }
    }, KEEPALIVE_MS);

    // step_id counter: 0 = workflow-level system step, 1+ = per-group user steps
    let nextStepId = 0;
    let currentStepId = 0;

    const send = (line: unknown) => {
      try { socket.send(JSON.stringify(line)); } catch { /* closed */ }
    };

    const openStep = (name: string, kind: number) => {
      nextStepId++;
      currentStepId = nextStepId;
      send({
        kind: "control",
        content: name,
        time: new Date().toISOString(),
        step_id: currentStepId,
        step_status: "start",
        step_kind: kind,
      });
    };

    const closeStep = () => {
      send({
        kind: "control",
        content: "",
        time: new Date().toISOString(),
        step_id: currentStepId,
        step_status: "end",
      });
      currentStepId = 0;
    };

    const sendData = (content: string) => {
      send({
        kind: "data",
        content,
        time: new Date().toISOString(),
        step_id: currentStepId,
        stream: "stdout",
      });
    };

    // Parse PE output lines: ##[group]Name opens a step, ##[endgroup] closes it.
    // Lines outside any group go to the current step (or step 0 if none open).
    const processLine = (raw: string) => {
      if (raw.startsWith("##[group]")) {
        if (currentStepId !== 0) closeStep();
        openStep(raw.slice("##[group]".length), 1 /* StepKindUser */);
      } else if (raw.startsWith("##[endgroup]")) {
        if (currentStepId !== 0) closeStep();
      } else if (raw.startsWith("##[error]")) {
        // Error lines emitted outside a group (step_id=0) land in the collapsed
        // system step and are invisible. Wrap them in an ephemeral user step so
        // they surface in the tangled UI.
        const outsideGroup = currentStepId === 0;
        if (outsideGroup) openStep("Error", 1 /* StepKindUser */);
        sendData(raw);
        if (outsideGroup) closeStep();
      } else {
        sendData(raw);
      }
    };

    // Open a system-level step for the workflow as a whole (collapsed, kind=0).
    send({
      kind: "control",
      content: run.workflow,
      time: new Date().toISOString(),
      step_id: 0,
      step_status: "start",
      step_kind: 0, // StepKindSystem — collapsed by default
    });

    let linesStreamed = 0;

    // Emit any pre-PE log lines collected during marketRFP provisioning.
    const preLogs = preRunLogs.get(key);
    if (preLogs && preLogs.length > 0) {
      openStep("Provisioning", 1 /* StepKindUser */);
      for (const line of preLogs) { sendData(line); linesStreamed++; }
      closeStep();
    }

    try {
      // Connect to PE SSE stream — delivers lines as emitted, closes on `event: done`.
      // For already-completed tasks the PE sends all buffered output then event: done immediately.
      log("info", "log stream opening SSE", { taskId: run.taskId, runStatus: run.status });
      const res = await fetch(
        `${run.peUrl}/request/console_output_stream/${run.taskId}`,
        { headers: { Accept: "text/event-stream" } },
      );
      log("info", "log stream SSE response", { taskId: run.taskId, httpStatus: res.status, ok: res.ok });

      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        outer: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const message = buf.slice(0, idx);
            buf = buf.slice(idx + 2);

            for (const rawLine of message.split("\n")) {
              if (rawLine.startsWith("event: done")) {
                break outer;
              }
              if (rawLine.startsWith("data: ")) {
                processLine(rawLine.slice("data: ".length));
                linesStreamed++;
              }
            }
          }
        }
        reader.cancel().catch(() => {});
        log("info", "log stream SSE complete", { taskId: run.taskId, linesStreamed });
      } else {
        log("warn", "console_output_stream unavailable", { taskId: run.taskId, httpStatus: res.status });
      }
    } catch (err) {
      log("error", "log stream SSE error", { taskId: run.taskId, err: String(err) });
    }

    // Hybrid fallback: if SSE delivered nothing, pull the snapshot from the status endpoint.
    // Covers cases where the task was cleaned up between run completion and log fetch.
    if (linesStreamed === 0) {
      log("info", "log stream SSE empty, falling back to console_output snapshot", { taskId: run.taskId });
      try {
        const res = await fetch(`${run.peUrl}/request/status/${run.taskId}`);
        if (res.ok) {
          const status: PolicyEngineStatus = await res.json();
          const raw = status.console_output ?? "";
          if (raw) {
            for (const line of raw.split("\n")) {
              if (line) { processLine(line); linesStreamed++; }
            }
            log("info", "log stream fallback complete", { taskId: run.taskId, linesStreamed });
          } else {
            // Last resort: plain console_output endpoint
            const r2 = await fetch(`${run.peUrl}/request/console_output/${run.taskId}`);
            if (r2.ok) {
              const text = await r2.text();
              for (const line of text.split("\n")) {
                if (line) { processLine(line); linesStreamed++; }
              }
              log("info", "log stream last-resort complete", { taskId: run.taskId, linesStreamed });
            }
          }
        }
      } catch (err) {
        log("error", "log stream fallback error", { taskId: run.taskId, err: String(err) });
      }
    }

    // Persisted log fallback: PE is gone after restart but we saved output locally.
    if (linesStreamed === 0) {
      const key = runKey(
        c.req.param("knot"),
        c.req.param("pipelineRkey"),
        c.req.param("workflow"),
      );
      const saved = logsDB.logs[key];
      if (saved) {
        log("info", "log stream serving from persisted logs db", { taskId: run.taskId });
        for (const line of saved.split("\n")) {
          if (line) { processLine(line); linesStreamed++; }
        }
        log("info", "log stream persisted complete", { taskId: run.taskId, linesStreamed });
      }
    }

    // Close any still-open step, then close the workflow-level step.
    if (currentStepId !== 0) closeStep();
    send({
      kind: "control",
      content: "",
      time: new Date().toISOString(),
      step_id: 0,
      step_status: "end",
    });
    log("info", "log stream closing", { taskId: run.taskId, linesStreamed });
    stopLogKeepAlive();
    try { socket.close(1000, "log stream complete"); } catch { /* ignore */ }
  };

  return response;
});

// /status — live status from the policy engine for one run
app.get("/status/:knot/:pipelineRkey/:workflow", async (c) => {
  const key = runKey(
    c.req.param("knot"),
    c.req.param("pipelineRkey"),
    c.req.param("workflow"),
  );
  const run = runs.get(key);
  if (!run) return c.json({ error: "run not found" }, 404);

  try {
    const res = await fetch(`${run.peUrl}/request/status/${run.taskId}`);
    const peStatus: PolicyEngineStatus = await res.json();
    return c.json({
      knot: run.knot,
      pipelineRkey: run.pipelineRkey,
      workflow: run.workflow,
      taskId: run.taskId,
      actor: run.actor,
      repoDid: run.repoDid,
      ref: run.ref,
      startedAt: run.startedAt.toISOString(),
      policyEngine: peStatus,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

// /xrpc/sh.tangled.pipeline.cancelPipeline  { pipeline: aturi, repo: repoDid, workflow: stem }
app.post("/xrpc/sh.tangled.pipeline.cancelPipeline", async (c) => {
  let body: { pipeline?: string; repo?: string; workflow?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "InvalidRequest", message: "invalid JSON" }, 400); }
  const { pipeline, repo, workflow } = body;
  if (!pipeline || !repo || !workflow) {
    return c.json({ error: "InvalidRequest", message: "missing pipeline, repo, or workflow" }, 400);
  }
  if (!repoDidToSpindle.has(repo)) {
    return c.json({ error: "Forbidden", message: "repo not authorized for this spindle" }, 403);
  }

  // Extract knot + pipelineRkey from the AT-URI (at://did:web:knot.example.com/collection/rkey)
  // pipeline aturi authority is "did:web:<knot>"
  let knot: string;
  let pipelineRkey: string;
  try {
    const uri = new URL(pipeline.replace(/^at:\/\//, "https://"));
    knot = uri.hostname;
    pipelineRkey = uri.pathname.split("/").at(-1) ?? "";
  } catch {
    return c.json({ error: "InvalidRequest", message: "invalid pipeline AT-URI" }, 400);
  }

  const key = runKey(knot, pipelineRkey, workflow);
  const run = runs.get(key);
  if (!run) return c.json({ error: "NotFound", message: "run not found" }, 404);

  run.status = "unknown"; // treat as terminal / cancelled
  const rkey = `${pipelineRkey}/${workflow}`;
  broadcastStatus(rkey, workflow, "unknown", undefined, knot, pipelineRkey);

  return c.body(null, 200);
});

// /xrpc/sh.tangled.repo.listSecrets?repo=<repoDid>
app.get("/xrpc/sh.tangled.repo.listSecrets", (c) => {
  const repo = c.req.query("repo");
  if (!repo) return c.json({ error: "InvalidRequest", message: "missing repo" }, 400);
  if (!repoDidToSpindle.has(repo)) return c.json({ error: "Forbidden", message: "repo not authorized for this spindle" }, 403);
  const m = secretsStore.get(repo) ?? new Map<string, SecretEntry>();
  const secrets = [...m.values()].map(({ key, repo: r, createdAt, createdBy }) => ({
    key,
    repo: r,
    createdAt,
    createdBy,
  }));
  return c.json({ secrets });
});

// /xrpc/sh.tangled.repo.addSecret  { repo, key, value }
app.post("/xrpc/sh.tangled.repo.addSecret", async (c) => {
  let body: { repo?: string; key?: string; value?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "InvalidRequest", message: "invalid JSON" }, 400); }
  const { repo, key, value } = body;
  if (!repo || !key || !value) return c.json({ error: "InvalidRequest", message: "missing repo, key, or value" }, 400);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return c.json({ error: "InvalidRequest", message: "invalid key identifier" }, 400);
  // Defense-in-depth: only accept secrets for repos that have opted into this
  // spindle. NOTE: this does NOT authenticate the *caller* — these endpoints
  // have no caller authentication and must be fronted by an authenticating proxy
  // (or AT Proto service-auth) in production. See SECURITY-THREAT-MODEL.md.
  if (!repoDidToSpindle.has(repo)) return c.json({ error: "Forbidden", message: "repo not authorized for this spindle" }, 403);
  const m = repoSecrets(repo);
  if (m.has(key)) return c.json({ error: "InvalidRequest", message: "key already present" }, 400);
  const host = c.req.header("host") ?? HOSTNAME;
  m.set(key, { key, value, repo, createdAt: new Date().toISOString(), createdBy: getOwnerDid(host) });
  return c.body(null, 200);
});

// /xrpc/sh.tangled.repo.removeSecret  { repo, key }
app.post("/xrpc/sh.tangled.repo.removeSecret", async (c) => {
  let body: { repo?: string; key?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "InvalidRequest", message: "invalid JSON" }, 400); }
  const { repo, key } = body;
  if (!repo || !key) return c.json({ error: "InvalidRequest", message: "missing repo or key" }, 400);
  if (!repoDidToSpindle.has(repo)) return c.json({ error: "Forbidden", message: "repo not authorized for this spindle" }, 403);
  const m = secretsStore.get(repo);
  if (!m?.has(key)) return c.json({ error: "InvalidRequest", message: "key not found" }, 404);
  m.delete(key);
  return c.body(null, 200);
});

// /xrpc/com.publicdomainrelay.temp.market.submitBid  { uri, cid, rfpUri }
// Bidders POST here when RFP.sendBid is set, bypassing the firehose.
// uri+cid identify the bid AT record; rfpUri routes it to the right collector.
app.post("/xrpc/com.publicdomainrelay.temp.market.submitBid", async (c) => {
  let body: { uri?: string; cid?: string; rfpUri?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "InvalidRequest", message: "invalid JSON" }, 400); }
  const { uri, cid, rfpUri } = body;
  if (!uri || !cid || !rfpUri) return c.json({ error: "InvalidRequest", message: "missing uri, cid, or rfpUri" }, 400);

  const did = uri.replace("at://", "").split("/")[0];
  const queue = pendingBids.get(rfpUri) ?? [];
  queue.push({
    did,
    uri,
    cid,
    record: {
      $type: "com.publicdomainrelay.temp.market.bid",
      rfp: { $type: "com.atproto.repo.strongRef", uri: rfpUri, cid: "" },
      payload: { $type: "com.atproto.repo.strongRef", uri: "", cid: "" },
    },
  });
  pendingBids.set(rfpUri, queue);

  log("info", "submitBid received", { uri, cid, rfpUri });
  return c.json({ ok: true });
});

// /trigger — accept a pipeline trigger and kick off workflow execution.
// Body mirrors the fields from sh.tangled.pipeline that the knot
// dispatches to the spindle when a push/PR event fires:
//   knot, pipelineRkey, actor, repoDid, repoName, ref, inputs?
app.post("/trigger", async (c) => {
  let body: Partial<TriggerPayload>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const missing = (["knot", "pipelineRkey", "actor", "repoDid", "repoName", "ref"] as const)
    .filter((k) => !body[k]);
  if (missing.length) {
    return c.json({ error: `missing fields: ${missing.join(", ")}` }, 400);
  }

  const trigger = body as TriggerPayload;

  // Authorization: only run pipelines for repos that have opted into this
  // spindle (this mirrors the jetstream knot-event path, which silently drops
  // triggers whose repoDid is not in repoDidToSpindle). Without this gate an
  // unauthenticated caller could POST an arbitrary { knot, repoDid, ref } and
  // make the spindle (a) fetch workflow files from an attacker-chosen knot host
  // — an SSRF primitive, since `knot` is used verbatim to build outbound URLs —
  // and (b) execute those workflows / provision paid VMs via market.rfp on the
  // operator's behalf.
  if (!repoDidToSpindle.has(trigger.repoDid)) {
    log("warn", "trigger rejected: repo not authorized for this spindle", { repoDid: trigger.repoDid, knot: trigger.knot });
    return c.json({ error: "Forbidden", message: "repo not authorized for this spindle" }, 403);
  }

  // Respond immediately; workflow fetch + submission runs in background.
  const responsePromise = triggerWorkflows(trigger);

  // Return the list of workflow stems we expect to run (fetched inline so
  // the caller knows what to watch).  If the fetch is slow we still return
  // quickly because we race it inside triggerWorkflows.
  const submitted = await responsePromise;

  return c.json({
    submitted: true,
    knot: trigger.knot,
    pipelineRkey: trigger.pipelineRkey,
    ref: trigger.ref,
    workflows: submitted.map((stem) => ({
      workflow: stem,
      logsUrl: `https://${hostnameForRepo(trigger.repoDid)}/logs/${trigger.knot}/${trigger.pipelineRkey}/${stem}`,
      statusUrl: `https://${hostnameForRepo(trigger.repoDid)}/status/${trigger.knot}/${trigger.pipelineRkey}/${stem}`,
    })),
  });
});

app.get("/healthz", (c) => c.json({ ok: true }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

log("info", "tangled-spindle-minimal starting", {
  port: PORT,
  owner: OWNER_DID || "(derived from subdomain)",
  hostname: HOSTNAME,
  policyEngine: POLICY_ENGINE_URL,
  defaultKnot: DEFAULT_KNOT,
  jetstreamUrl: JETSTREAM_URL,
  dbPath: DB_PATH,
  logsDbPath: LOGS_DB_PATH,
});

startKnotDiscovery().catch((err) => log("error", "knot discovery startup failed", { err: String(err) }));

if (UNIX_SOCKET) {
  // Remove stale socket file if present.
  try { Deno.removeSync(UNIX_SOCKET); } catch { /* ignore */ }
  log("info", "listening on unix socket", { path: UNIX_SOCKET });
  Deno.serve({ path: UNIX_SOCKET } as Deno.ServeUnixOptions, app.fetch);
} else {
  Deno.serve({ port: PORT }, app.fetch);
}
