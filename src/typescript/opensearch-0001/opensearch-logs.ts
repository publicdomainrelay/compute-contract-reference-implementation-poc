#!/usr/bin/env -S deno run --allow-env --allow-run --allow-net
// Pull logs from the DigitalOcean Managed OpenSearch cluster that the Droplets
// ship to via Fluent Bit (see deploy-fluent-bit.sh). Mirrors that script's
// conventions: connection details are derived from doctl, the index is the
// Logstash prefix (default droplet-logs), auth is HTTP basic over TLS.
//
//   usage:
//     ./opensearch-logs.ts [options]
//
//   Connection is resolved automatically:
//     1. OPENSEARCH_HOST/PORT/USER/PASS env -> used directly (skips doctl).
//     2. DB_CLUSTER=<name|id> -> resolved via doctl.
//     3. neither set -> auto-pick the sole opensearch cluster via doctl.
//
//   options (env or flags):
//     --query <lucene>     OpenSearch query_string (default: spindle/bidder/qemu)
//     --all                show all logs (overrides the default service filter)
//     --host <name>        filter on the record_modifier `hostname` field
//     --since <duration>   relative time window, e.g. 15m, 2h, 1d (default 1h)
//     --size <n>           max documents to return (default 100)
//     --index <prefix>     Logstash index prefix (default droplet-logs)
//     --follow             poll every --interval seconds for new logs
//     --interval <sec>     poll interval when --following (default 5)
//     --json               emit raw JSON docs, one per line (default pretty)
//     --private            use the cluster's VPC (private) connection host
//
// Auth/connection resolution matches deploy-fluent-bit.sh: cluster name -> ID via
// `doctl databases list`, then `doctl databases connection`.

import { parseArgs } from "jsr:@std/cli/parse-args";

export interface Conn {
  host: string;
  port: string;
  user: string;
  pass: string;
}

async function doctl(args: string[]): Promise<string> {
  const cmd = new Deno.Command("doctl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`doctl ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout);
}

// Resolve cluster name -> ID (accept an ID passed directly), matching the awk
// name||id match in deploy-fluent-bit.sh. When `cluster` is undefined, auto-pick
// the sole opensearch cluster on the account; error if there are zero or many.
export async function resolveClusterId(cluster?: string): Promise<string> {
  const out = await doctl([
    "databases", "list", "--format", "Name,ID,Engine", "--no-header",
  ]);
  const rows = out.trim().split("\n").filter((l) => l.trim()).map((l) => {
    const [name, id, engine] = l.trim().split(/\s+/);
    return { name, id, engine };
  });
  if (cluster) {
    const hit = rows.find((r) => r.name === cluster || r.id === cluster);
    if (hit) return hit.id;
    throw new Error(`could not resolve DB_CLUSTER '${cluster}' to a cluster ID`);
  }
  const os = rows.filter((r) => r.engine === "opensearch");
  if (os.length === 1) return os[0].id;
  if (os.length === 0) throw new Error("no opensearch cluster found; set DB_CLUSTER");
  throw new Error(
    `multiple opensearch clusters (${os.map((r) => r.name).join(", ")}); set DB_CLUSTER`,
  );
}

export async function getConnection(id: string, priv: boolean): Promise<Conn> {
  const args = ["databases", "connection", id, "--format", "Host,Port,User,Password", "--no-header"];
  if (priv) args.push("--private");
  const out = await doctl(args);
  const [host, port, user, pass] = out.trim().split(/\s+/);
  if (!host) throw new Error("empty host from doctl databases connection");
  return { host, port, user, pass };
}

// Build a bool query: time range + optional hostname term + query_string.
export function buildQuery(opts: {
  query: string;
  host?: string;
  since: string;
  size: number;
}) {
  const filter: unknown[] = [
    { range: { "@timestamp": { gte: `now-${opts.since}`, lte: "now" } } },
  ];
  if (opts.host) filter.push({ term: { hostname: opts.host } });
  return {
    size: opts.size,
    sort: [{ "@timestamp": { order: "asc" } }],
    query: {
      bool: {
        must: [{ query_string: { query: opts.query } }],
        filter,
      },
    },
  };
}

export async function search(conn: Conn, index: string, body: unknown, scheme: string) {
  const url = `${scheme}://${conn.host}:${conn.port}/${index}-*/_search`;
  const auth = "Basic " + btoa(`${conn.user}:${conn.pass}`);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`OpenSearch ${resp.status}: ${await resp.text()}`);
  }
  return await resp.json();
}

interface Hit {
  _source: Record<string, unknown> & {
    "@timestamp"?: string;
    hostname?: string;
    message?: string;
    MESSAGE?: string;
  };
}

function printHit(hit: Hit, asJson: boolean) {
  const s = hit._source;
  if (asJson) {
    console.log(JSON.stringify(s));
    return;
  }
  const ts = s["@timestamp"] ?? "";
  const host = s.hostname ?? "";
  const msg = s.message ?? s.MESSAGE ?? JSON.stringify(s);
  console.log(`${ts} ${host} ${msg}`);
}

// Resolve an OpenSearch connection using the same order main() uses:
//  1. OPENSEARCH_HOST/PORT/USER/PASS env, 2. DB_CLUSTER via doctl,
//  3. auto-pick the sole opensearch cluster via doctl.
export async function getConn(priv = false): Promise<Conn> {
  const envHost = Deno.env.get("OPENSEARCH_HOST");
  if (envHost) {
    return {
      host: envHost,
      port: Deno.env.get("OPENSEARCH_PORT") ?? "25060",
      user: Deno.env.get("OPENSEARCH_USER") ?? "doadmin",
      pass: Deno.env.get("OPENSEARCH_PASS") ?? "",
    };
  }
  const id = await resolveClusterId(Deno.env.get("DB_CLUSTER") ?? undefined);
  return await getConnection(id, priv);
}

async function main() {
  // Default service filter: match spindle, bidder, or qemu across the message
  // body and journald unit fields. --query overrides; --all disables it.
  const DEFAULT_SERVICES = ["spindle", "bidder", "qemu"];
  const defaultQuery = DEFAULT_SERVICES.map((s) => `*${s}*`).join(" OR ");

  const flags = parseArgs(Deno.args, {
    string: ["query", "host", "since", "size", "index", "interval"],
    boolean: ["follow", "json", "private", "all"],
    default: {
      query: defaultQuery,
      since: "1h",
      size: "100",
      index: Deno.env.get("OPENSEARCH_INDEX") ?? "droplet-logs",
      interval: "5",
    },
  });

  // Connection resolution order:
  //  1. Explicit env (OPENSEARCH_HOST/PORT/USER/PASS) -> use as-is, skip doctl.
  //  2. DB_CLUSTER set -> resolve that cluster via doctl.
  //  3. Neither set -> auto-pick the sole opensearch cluster via doctl.
  const envHost = Deno.env.get("OPENSEARCH_HOST");
  let conn: Conn;
  if (envHost) {
    conn = {
      host: envHost,
      port: Deno.env.get("OPENSEARCH_PORT") ?? "25060",
      user: Deno.env.get("OPENSEARCH_USER") ?? "doadmin",
      pass: Deno.env.get("OPENSEARCH_PASS") ?? "",
    };
  } else {
    const id = await resolveClusterId(Deno.env.get("DB_CLUSTER") ?? undefined);
    conn = await getConnection(id, flags.private);
  }
  // Public host: Let's Encrypt cert, system CA. Private host: DO self-signed CA.
  // Deno verifies against the system store; for the private endpoint run with
  // DENO_CERT=<do-ca.crt> or --cert. Both use https.
  const scheme = "https";

  const hitKey = (h: Hit) =>
    `${h._source["@timestamp"]}|${h._source.hostname}|${h._source.message ?? h._source.MESSAGE}`;

  const query = flags.all ? "*" : flags.query;

  const run = async (since: string, seen?: Set<string>) => {
    const body = buildQuery({
      query,
      host: flags.host,
      since,
      size: Number(flags.size),
    });
    const res = await search(conn, flags.index, body, scheme);
    const hits: Hit[] = res.hits?.hits ?? [];
    for (const h of hits) {
      if (seen) {
        const k = hitKey(h);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      printHit(h, flags.json);
    }
    return hits;
  };

  if (!flags.follow) {
    await run(flags.since);
    return;
  }

  // Follow mode: poll a trailing window each tick, de-duping on
  // @timestamp+hostname+message so overlapping windows don't re-print.
  const seen = new Set<string>();
  const intervalMs = Number(flags.interval) * 1000;
  let since = flags.since;
  while (true) {
    await run(since, seen);
    // After the first window, poll a window slightly larger than the interval.
    since = `${Number(flags.interval) + 5}s`;
    // Cap memory: drop oldest keys once the set grows large.
    if (seen.size > 10000) seen.clear();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  });
}
