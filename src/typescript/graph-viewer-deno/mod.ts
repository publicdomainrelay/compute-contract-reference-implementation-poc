// Market Graph → Mermaid NDJSON (Deno CLI)
//
// Three input modes:
//   deno run mod.ts --input recording.json    replay a stored recording
//   deno run mod.ts --jetstream               connect to Bluesky jetstream
//   cat frames.ndjson | deno run mod.ts       pipe raw jetstream NDJSON
//
// Output: NDJSON to stdout. Each line is a JSON object with a mermaid flowchart
// showing the full current graph state after ingesting that record.

import {
  WATCHED_NSIDS,
  parseJetstreamFrame,
  extractEdges,
  fixUps,
  type JetstreamFrame,
  type RecordNode,
  type GraphEdge,
} from "./graph.ts";
import { toMermaid } from "./mermaid.ts";

// ---------------------------------------------------------------------------
// Shared graph accumulator
// ---------------------------------------------------------------------------

const nodeMap = new Map<string, RecordNode>();
const nodes: RecordNode[] = [];
const edges: GraphEdge[] = [];

/** Insert one record node into the graph. Returns true if it was new. */
function ingest(node: RecordNode): boolean {
  if (!node?.uri || nodeMap.has(node.uri)) return false;
  nodeMap.set(node.uri, node);
  nodes.push(node);
  for (const e of extractEdges(node)) edges.push(e);
  return true;
}

/** Emit one NDJSON line for the triggering record. */
function emit(trigger: RecordNode): void {
  const mermaid = toMermaid(nodes, edges);
  const out = { uri: trigger.uri, collection: trigger.collection, rkey: trigger.rkey, mermaid };
  console.log(JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// Processing helpers
// ---------------------------------------------------------------------------

function processFrame(frame: JetstreamFrame): void {
  const rec = parseJetstreamFrame(frame);
  if (!rec) return;
  const wasNew = ingest(rec);
  // Run fix-ups after the triggering node is in the map.
  const result = fixUps(rec, nodeMap);
  for (const synth of result.nodes) {
    if (ingest(synth)) emit(synth);
  }
  for (const e of result.edges) {
    // Avoid duplicates.
    if (!edges.some((x) => x.from === e.from && x.to === e.to && x.label === e.label)) {
      edges.push(e);
    }
  }
  if (wasNew) emit(rec);
}

// ---------------------------------------------------------------------------
// --input mode: replay a recording file
// ---------------------------------------------------------------------------

async function processRecordingFile(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    console.error(`cannot read ${path}: ${(err as Error).message}`);
    Deno.exit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`invalid JSON in ${path}: ${(err as Error).message}`);
    Deno.exit(1);
  }

  // Accept: recording object with .events, a bare array, or NDJSON text
  let frames: JetstreamFrame[];
  if (Array.isArray(data)) {
    frames = data as JetstreamFrame[];
  } else if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).events)) {
    frames = (data as Record<string, unknown>).events as JetstreamFrame[];
  } else {
    // Try NDJSON (one JSON object per line)
    frames = [];
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
    if (frames.length === 0) {
      console.error(`no parseable frames found in ${path}`);
      Deno.exit(1);
    }
  }

  for (const frame of frames) processFrame(frame);
}

// ---------------------------------------------------------------------------
// stdin mode: auto-detect JSON recording or NDJSON stream
// ---------------------------------------------------------------------------

async function processStdin(): Promise<void> {
  // Read entire stdin — acceptable for a CLI tool; recordings are finite.
  const raw = await new Response(Deno.stdin.readable).text();

  // Try parsing as a single JSON recording (object with .events, or array).
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const frame of data as JetstreamFrame[]) processFrame(frame);
      return;
    }
    if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).events)) {
      for (const frame of (data as Record<string, unknown>).events as JetstreamFrame[]) processFrame(frame);
      return;
    }
  } catch { /* not valid JSON — fall through to NDJSON */ }

  // NDJSON: one JSON object per line.
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      processFrame(JSON.parse(line));
    } catch { /* skip malformed */ }
  }
}

// ---------------------------------------------------------------------------
// --jetstream mode: live WebSocket
// ---------------------------------------------------------------------------

function connectJetstream(): Promise<void> {
  const params = new URLSearchParams();
  for (const nsid of WATCHED_NSIDS) {
    params.append("wantedCollections", nsid);
  }
  const url = `wss://jetstream2.us-east.bsky.network/subscribe?${params.toString()}`;

  return new Promise((_resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error(`failed to create WebSocket: ${(err as Error).message}`);
      Deno.exit(1);
    }

    ws.onopen = () => {
      console.error("jetstream: connected");
    };

    ws.onmessage = (event) => {
      try {
        processFrame(JSON.parse(event.data as string));
      } catch { /* skip malformed */ }
    };

    ws.onerror = (err) => {
      console.error("jetstream: error", err);
    };

    ws.onclose = (event) => {
      console.error(`jetstream: disconnected (code ${event.code})`);
      Deno.exit(event.code === 1000 ? 0 : 1);
    };

    // Keep alive until WebSocket closes
  });
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error(`Market Graph → Mermaid NDJSON

USAGE:
  deno run mod.ts --input <recording.json>   replay a stored recording
  deno run mod.ts --jetstream                connect to Bluesky jetstream (live)
  deno run mod.ts < frames.ndjson            pipe recording JSON or NDJSON via stdin

OPTIONS:
  --input, -i <path>   path to a recording JSON file (object with .events, or array)
  --jetstream, -j      connect to wss://jetstream2.us-east.bsky.network/subscribe
  --help, -h           show this help`);
}

if (import.meta.main) {
  const args = Deno.args;

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    Deno.exit(0);
  }

  if (args.includes("--jetstream") || args.includes("-j")) {
    await connectJetstream();
  } else if (args.includes("--input") || args.includes("-i")) {
    // Find path after --input or -i
    let path = "";
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "--input" || args[i] === "-i") && i + 1 < args.length) {
        path = args[i + 1];
        break;
      }
    }
    if (!path) {
      console.error("error: --input requires a file path");
      printUsage();
      Deno.exit(1);
    }
    await processRecordingFile(path);
  } else if (!Deno.isatty(Deno.stdin.rid)) {
    // stdin is piped — read NDJSON
    await processStdin();
  } else {
    printUsage();
    Deno.exit(1);
  }
}
