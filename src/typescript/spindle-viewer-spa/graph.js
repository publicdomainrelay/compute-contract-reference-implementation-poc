// Pure, DOM-free logic for the Market Graph Viewer.
//
// Watches the Bluesky jetstream for createRecord events on NSIDs that describe
// the bidder↔spindle contract flow, builds a live force-directed graph of
// records and their relationships, and renders any record as YAML for inspection.
//
// NSID coverage — the full bidder/spindle market flow:
//   com.publicdomainrelay.temp.market.rfp          spindle creates
//   com.publicdomainrelay.temp.market.bid           bidder creates
//   com.publicdomainrelay.temp.market.accept        spindle creates
//   com.publicdomainrelay.temp.market.receipt       bidder creates
//   com.publicdomainrelay.temp.market.event         spindle creates (teardown)
//   com.publicdomainrelay.temp.market.offering      bidder creates
//   com.publicdomainrelay.temp.compute.vm           spindle creates
//   com.fedproxy.rbac                               spindle creates
//   com.fedproxy.sshPublicKey                       VM creates
//   com.publicdomainrelay.temp.market.bids.x402     bidder creates (payment)
//   com.publicdomainrelay.temp.market.bids.free     bidder creates (free grant)
//   com.publicdomainrelay.temp.compute.events.vm.delete  spindle creates

// ---------------------------------------------------------------------------
// NSID catalogue
// ---------------------------------------------------------------------------

export const WATCHED_NSIDS = [
  "com.publicdomainrelay.temp.market.rfp",
  "com.publicdomainrelay.temp.market.bid",
  "com.publicdomainrelay.temp.market.accept",
  "com.publicdomainrelay.temp.market.receipt",
  "com.publicdomainrelay.temp.market.event",
  "com.publicdomainrelay.temp.market.offering",
  "com.publicdomainrelay.temp.compute.vm",
  "com.fedproxy.rbac",
  "com.fedproxy.sshPublicKey",
  "com.publicdomainrelay.temp.market.bids.x402",
  "com.publicdomainrelay.temp.market.bids.free",
  "com.publicdomainrelay.temp.compute.events.vm.delete",
];

// Short human-readable labels for the graph.
const NSID_LABELS = {
  "com.publicdomainrelay.temp.market.rfp": "market.rfp",
  "com.publicdomainrelay.temp.market.bid": "market.bid",
  "com.publicdomainrelay.temp.market.accept": "market.accept",
  "com.publicdomainrelay.temp.market.receipt": "market.receipt",
  "com.publicdomainrelay.temp.market.event": "market.event",
  "com.publicdomainrelay.temp.market.offering": "market.offering",
  "com.publicdomainrelay.temp.compute.vm": "compute.vm",
  "com.fedproxy.rbac": "fedproxy.rbac",
  "com.fedproxy.sshPublicKey": "fedproxy.sshPublicKey",
  "com.publicdomainrelay.temp.market.bids.x402": "bids.x402",
  "com.publicdomainrelay.temp.market.bids.free": "bids.free",
  "com.publicdomainrelay.temp.compute.events.vm.delete": "events.vm.delete",
  "com.fedcicd.tangled.spindle.gha": "spindle.gha",
  "com.fedproxy.tunnel": "tunnel",
};

// Colours per NSID for the graph (hue wheel, roughly grouped by actor).
const NSID_COLORS = {
  "com.publicdomainrelay.temp.market.rfp": "#4dc9f6",
  "com.publicdomainrelay.temp.market.bid": "#f67019",
  "com.publicdomainrelay.temp.market.accept": "#4dc9f6",
  "com.publicdomainrelay.temp.market.receipt": "#f67019",
  "com.publicdomainrelay.temp.market.event": "#4dc9f6",
  "com.publicdomainrelay.temp.market.offering": "#f67019",
  "com.publicdomainrelay.temp.compute.vm": "#537bc4",
  "com.fedproxy.rbac": "#537bc4",
  "com.fedproxy.sshPublicKey": "#acc236",
  "com.publicdomainrelay.temp.market.bids.x402": "#f67019",
  "com.publicdomainrelay.temp.market.bids.free": "#f67019",
  "com.publicdomainrelay.temp.compute.events.vm.delete": "#4dc9f6",
  "com.fedcicd.tangled.spindle.gha": "#9b59b6",
  "com.fedproxy.tunnel": "#1abc9c",
};

export function nsidLabel(nsid) {
  return NSID_LABELS[nsid] || nsid.split(".").pop();
}

export function nsidColor(nsid) {
  return NSID_COLORS[nsid] || "#888";
}

// ---------------------------------------------------------------------------
// Jetstream event parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single jetstream frame into a graph-ready record node, or null if
 * the frame is not a createRecord for one of our watched NSIDs.
 *
 * Jetstream frame shape (abridged):
 *   { did, time_us, kind, commit: { collection, operation, rkey, record, cid, rev } }
 */
export function parseJetstreamFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  const commit = frame.commit;
  if (!commit || typeof commit !== "object") return null;
  if (commit.operation !== "create") return null;

  const collection = commit.collection;
  if (!collection || !WATCHED_NSIDS.includes(collection)) return null;

  const did = typeof frame.did === "string" ? frame.did : "";
  const rkey = typeof commit.rkey === "string" ? commit.rkey : "";
  const cid = typeof commit.cid === "string" ? commit.cid : "";
  const record = commit.record || {};
  const time_us = typeof frame.time_us === "number" ? frame.time_us : Date.now() * 1000;

  const uri = `at://${did}/${collection}/${rkey}`;

  return {
    uri,
    cid,
    did,
    collection,
    rkey,
    record,
    createdAt: new Date(time_us / 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Graph data model
// ---------------------------------------------------------------------------

/**
 * StrongRef fields on each NSID that point to other records. Each entry is
 *   [fieldName, edgeLabel].
 * "payload" is included generically — most records use it for a nested ref.
 */
const REF_FIELDS = {
  "com.publicdomainrelay.temp.market.rfp": [["payload", "payload"]],
  "com.publicdomainrelay.temp.market.bid": [
    ["rfp", "rfp"],
    ["payload", "payload"],
    ["config", "config"],
  ],
  "com.publicdomainrelay.temp.market.accept": [
    ["rfp", "rfp"],
    ["bid", "bid"],
    ["payload", "payload"],
  ],
  "com.publicdomainrelay.temp.market.receipt": [
    ["rfp", "rfp"],
    ["bid", "bid"],
    ["accept", "accept"],
    ["payload", "payload"],
  ],
  "com.publicdomainrelay.temp.market.event": [
    ["receipt", "receipt"],
    ["payload", "payload"],
  ],
  "com.publicdomainrelay.temp.compute.events.vm.delete": [],
  "com.publicdomainrelay.temp.compute.events.provisioning": [["vm", "vm"]],
};

/**
 * Extract edges from a record node by walking its StrongRef fields.
 * Returns an array of { from, to, source, target, label }.
 * `from`/`to` are preserved string URIs for key functions (never mutated).
 * `source`/`target` are consumed by d3.forceLink — it mutates them to node
 * objects during simulation, so key functions MUST use `from`/`to`.
 */
export function extractEdges(node) {
  const fields = REF_FIELDS[node.collection] || [];
  const edges = [];
  for (const [field, label] of fields) {
    const ref = node.record[field];
    if (!ref || typeof ref.uri !== "string") continue;
    edges.push({
      from: node.uri,
      to: ref.uri,
      source: node.uri,
      target: ref.uri,
      label: `${node.rkey}:${label}`,
    });
  }
  return edges;
}

/**
 * Build the full graph: { nodes: Map<uri, node>, edges: edge[] }.
 * `records` is an array of parsed record nodes (from parseJetstreamFrame).
 */
export function buildGraph(records) {
  const nodeMap = new Map();
  const edges = [];

  for (const rec of records) {
    if (!rec.uri) continue;
    nodeMap.set(rec.uri, rec);
  }

  for (const rec of records) {
    for (const edge of extractEdges(rec)) {
      edges.push(edge);
    }
  }

  return { nodes: nodeMap, edges };
}

// ---------------------------------------------------------------------------
// Fix-ups: synthetic edge generation for com.fedproxy.rbac ↔ compute.vm
// ---------------------------------------------------------------------------

/**
 * Build role-name hints from an rbac record: direct role keys + ":role:<name>"
 * suffix extracted from definition.sub fields.
 */
function rbacRoleSubs(rbacRecord) {
  const roles = rbacRecord["roles"];
  if (!roles || typeof roles !== "object") return new Set();
  const subs = new Set(Object.keys(roles));
  for (const roleVal of Object.values(roles)) {
    const sub = roleVal?.definition?.sub;
    if (typeof sub === "string") {
      const m = sub.match(/:role:([^:]+)$/);
      if (m) subs.add(m[1]);
    }
  }
  return subs;
}

/**
 * Extract HTTP routes from an rbac record's policies[*].schemas keys.
 */
function rbacRoutes(rbacRecord) {
  const policies = rbacRecord["policies"];
  if (!policies || typeof policies !== "object") return [];
  const routes = [];
  for (const policy of Object.values(policies)) {
    const schemas = policy?.schemas;
    if (schemas && typeof schemas === "object") routes.push(...Object.keys(schemas));
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Fix-up helpers (receipt → vm chain)
// ---------------------------------------------------------------------------

function resolveReceiptVm(node, nodeMap) {
  const rfpRef = node.record["rfp"];
  if (!rfpRef || typeof rfpRef !== "object") return null;
  const rfpUri = rfpRef.uri;
  if (typeof rfpUri !== "string") return null;
  const rfpNode = nodeMap.get(rfpUri);
  if (!rfpNode) return null;
  const payloadRef = rfpNode.record["payload"];
  if (!payloadRef || typeof payloadRef !== "object") return null;
  const vmUri = payloadRef.uri;
  return typeof vmUri === "string" ? vmUri : null;
}

function findProvisioningForVm(vmUri, nodeMap) {
  for (const n of nodeMap.values()) {
    if (n.collection !== "com.publicdomainrelay.temp.compute.events.provisioning") continue;
    if (n.record["vm"]?.uri === vmUri) return n;
  }
  return null;
}

function findMarketEventForReceipt(receiptUri, nodeMap) {
  for (const n of nodeMap.values()) {
    if (n.collection !== "com.publicdomainrelay.temp.market.event") continue;
    if (n.record["receipt"]?.uri === receiptUri) return n;
  }
  return null;
}

function makeEdge(from, to, label) {
  return { from, to, source: from, target: to, label };
}

/**
 * Generate synthetic nodes and extra edges for implicit graph relationships.
 * Mirrors the deno graph.ts fixUps exactly.
 * Caller must ingest returned nodes before adding edges.
 */
export function fixUps(node, nodeMap) {
  const synthetic = [];
  const extraEdges = [];

  // ── market.receipt → synthetic provisioning + synthetic market.event ────────
  if (node.collection === "com.publicdomainrelay.temp.market.receipt") {
    const vmUri = resolveReceiptVm(node, nodeMap);
    if (!vmUri) return { nodes: [], edges: [] };
    const vmNode = nodeMap.get(vmUri);
    if (!vmNode) return { nodes: [], edges: [] };

    let provNode = findProvisioningForVm(vmUri, nodeMap);
    if (!provNode) {
      const provRkey = `${node.rkey}_provisioning`;
      const provUri = `at://${node.did}/com.publicdomainrelay.temp.compute.events.provisioning/${provRkey}`;
      provNode = {
        uri: provUri, cid: "synthetic", did: node.did,
        collection: "com.publicdomainrelay.temp.compute.events.provisioning",
        rkey: provRkey,
        record: {
          $type: "com.publicdomainrelay.temp.compute.events.provisioning",
          vm: { $type: "com.atproto.repo.strongRef", cid: vmNode.cid, uri: vmNode.uri },
        },
        createdAt: node.createdAt,
      };
      synthetic.push(provNode);
    }

    const existingEvent = findMarketEventForReceipt(node.uri, nodeMap);
    if (!existingEvent) {
      const eventRkey = `${node.rkey}_event`;
      const eventUri = `at://${node.did}/com.publicdomainrelay.temp.market.event/${eventRkey}`;
      synthetic.push({
        uri: eventUri, cid: "synthetic", did: node.did,
        collection: "com.publicdomainrelay.temp.market.event",
        rkey: eventRkey,
        record: {
          $type: "com.publicdomainrelay.temp.market.event",
          receipt: { $type: "com.atproto.repo.strongRef", cid: node.cid, uri: node.uri },
          payload: { $type: "com.atproto.repo.strongRef", cid: "synthetic", uri: provNode.uri },
        },
        createdAt: node.createdAt,
      });
    } else {
      extraEdges.push(makeEdge(existingEvent.uri, provNode.uri, `${existingEvent.rkey}:payload`));
    }
  }

  // ── market.rfp → synthetic spindle.gha ──────────────────────────────────────
  if (node.collection === "com.publicdomainrelay.temp.market.rfp") {
    const ghaUri = `at://${node.did}/com.fedcicd.tangled.spindle.gha/${node.rkey}`;
    if (!nodeMap.has(ghaUri)) {
      synthetic.push({
        uri: ghaUri, cid: "synthetic", did: node.did,
        collection: "com.fedcicd.tangled.spindle.gha",
        rkey: node.rkey,
        record: { $type: "com.fedcicd.tangled.spindle.gha" },
        createdAt: node.createdAt,
      });
      extraEdges.push(makeEdge(ghaUri, node.uri, "created"));
    }
  }

  // ── sshPublicKey → spindle.gha edge labeled "tunnel" ───────────────────────
  if (node.collection === "com.fedproxy.sshPublicKey") {
    const ghaNode = [...nodeMap.values()].find((n) => n.collection === "com.fedcicd.tangled.spindle.gha") ?? null;
    if (ghaNode && !extraEdges.some((e) => e.from === node.uri && e.to === ghaNode.uri && e.label === "tunnel")) {
      extraEdges.push(makeEdge(node.uri, ghaNode.uri, "tunnel"));
    }
  }

  // ── market.event → link to provisioning ─────────────────────────────────────
  if (node.collection === "com.publicdomainrelay.temp.market.event") {
    if (node.cid === "synthetic") return { nodes: synthetic, edges: extraEdges };
    const receiptUri = node.record["receipt"]?.uri;
    if (typeof receiptUri !== "string") return { nodes: synthetic, edges: extraEdges };
    const receiptNode = nodeMap.get(receiptUri);
    if (!receiptNode) return { nodes: synthetic, edges: extraEdges };
    const vmUri = resolveReceiptVm(receiptNode, nodeMap);
    if (!vmUri) return { nodes: synthetic, edges: extraEdges };
    const provNode = findProvisioningForVm(vmUri, nodeMap);
    const syntheticEventUri = `at://${receiptNode.did}/com.publicdomainrelay.temp.market.event/${receiptNode.rkey}_event`;
    if (provNode && !nodeMap.has(syntheticEventUri)) {
      extraEdges.push(makeEdge(node.uri, provNode.uri, `${node.rkey}:payload`));
    }
  }

  // ── rbac / compute.vm / sshPublicKey ────────────────────────────────────────
  if (
    node.collection === "com.fedproxy.rbac" ||
    node.collection === "com.publicdomainrelay.temp.compute.vm" ||
    node.collection === "com.fedproxy.sshPublicKey"
  ) {
    const allNodes = [...nodeMap.values()];
    const rbacNodes =
      node.collection === "com.fedproxy.rbac"
        ? [node]
        : allNodes.filter((n) => n.collection === "com.fedproxy.rbac");

    for (const rbacNode of rbacNodes) {
      const roleSubs = rbacRoleSubs(rbacNode.record);
      if (!roleSubs.size) continue;

      const vmNode =
        node.collection === "com.publicdomainrelay.temp.compute.vm"
          ? (roleSubs.has(node.record["role"]) ? node : null)
          : allNodes.find(
              (n) => n.collection === "com.publicdomainrelay.temp.compute.vm" && roleSubs.has(n.record["role"]),
            ) ?? null;
      if (!vmNode) continue;

      const sshNodes =
        node.collection === "com.fedproxy.sshPublicKey"
          ? [node]
          : allNodes.filter((n) => n.collection === "com.fedproxy.sshPublicKey");
      const matchingSsh = sshNodes.find((n) => n.record["service"] === vmNode.record["role"]) ?? null;

      for (const route of rbacRoutes(rbacNode.record)) {
        if (route.endsWith(".createRecord")) {
          if (matchingSsh && !extraEdges.some((e) => e.from === matchingSsh.uri && e.to === rbacNode.uri && e.label === route)) {
            extraEdges.push(makeEdge(matchingSsh.uri, rbacNode.uri, route));
          }
        } else {
          if (!extraEdges.some((e) => e.from === vmNode.uri && e.to === rbacNode.uri && e.label === route)) {
            extraEdges.push(makeEdge(vmNode.uri, rbacNode.uri, route));
          }
        }
      }

      if (matchingSsh && !extraEdges.some((e) => e.from === vmNode.uri && e.to === matchingSsh.uri && e.label === "post public key")) {
        extraEdges.push(makeEdge(vmNode.uri, matchingSsh.uri, "post public key"));
      }
    }
  }

  return { nodes: synthetic, edges: extraEdges };
}

// ---------------------------------------------------------------------------
// YAML serialisation (hand-rolled, no dependency)
// ---------------------------------------------------------------------------

/**
 * Serialise any value to YAML-ish string. Handles nested objects, arrays,
 * strings, numbers, booleans, null. $type is hoisted to first key for atproto
 * records. Output is not a full YAML 1.2 emitter — no anchors/aliases, no
 * flow-style — but it's readable and faithful for inspection.
 */
export function toYaml(value, indent = 0) {
  const pad = "  ".repeat(indent);
  const deeper = indent + 1;

  if (value === null || value === undefined) return `${pad}null`;

  if (typeof value === "string") {
    // Multi-line strings → literal block scalar
    if (value.includes("\n")) {
      const lines = value.split("\n");
      const out = [`${pad}|`];
      for (const line of lines) out.push(`${pad}  ${line}`);
      return out.join("\n");
    }
    // Quote strings that could be ambiguous (look like bools, numbers, or
    // contain YAML-special chars).
    if (/[:\{\}\[\],&*#?|>!%@`"'\n]/.test(value) || /^\s/.test(value) || /\s$/.test(value)) {
      return `${pad}"${value.replace(/"/g, '\\"')}"`;
    }
    if (value === "true" || value === "false" || value === "yes" || value === "no" ||
        value === "null" || value === "~" || /^-?[\d.]+$/.test(value)) {
      return `${pad}"${value}"`;
    }
    return `${pad}${value}`;
  }

  if (typeof value === "number") return `${pad}${String(value)}`;
  if (typeof value === "boolean") return `${pad}${String(value)}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    const out = [];
    for (const item of value) {
      if (typeof item === "object" && item !== null) {
        const child = toYaml(item, deeper);
        out.push(`${pad}-${child.slice(pad.length + 1)}`);
      } else {
        const child = toYaml(item, 0);
        out.push(`${pad}- ${child.trimStart()}`);
      }
    }
    return out.join("\n");
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}`;

    // Hoist $type to first key.
    const ordered = keys.filter(k => k !== "$type");
    if (keys.includes("$type")) ordered.unshift("$type");

    const out = [];
    for (const key of ordered) {
      const v = value[key];
      if (typeof v === "object" && v !== null) {
        out.push(`${pad}${key}:`);
        out.push(toYaml(v, deeper));
      } else {
        const valStr = toYaml(v, 0).trimStart();
        out.push(`${pad}${key}: ${valStr}`);
      }
    }
    return out.join("\n");
  }

  return `${pad}${String(value)}`;
}

// ---------------------------------------------------------------------------
// pdsls.dev URL builder
// ---------------------------------------------------------------------------

export function pdslsUrl(uri) {
  return `https://pdsls.dev/${uri}`;
}

// ---------------------------------------------------------------------------
// DID shortening
// ---------------------------------------------------------------------------

export function shortDid(did, maxLen = 20) {
  if (!did) return "";
  if (did.length <= maxLen) return did;
  const parts = did.split(":");
  if (parts.length >= 3) {
    const method = parts.slice(0, 2).join(":");
    const id = parts.slice(2).join(":");
    const keep = maxLen - method.length - 5;
    if (keep <= 0) return `${method}:…`;
    return `${method}:${id.slice(0, keep)}…`;
  }
  return `${did.slice(0, maxLen - 1)}…`;
}
