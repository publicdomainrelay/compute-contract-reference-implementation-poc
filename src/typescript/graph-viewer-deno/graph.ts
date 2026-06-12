// Pure, runtime-agnostic logic for the Market Graph — ported from
// graph-viewer-spa/graph.js.  No DOM, no Deno-specific APIs.
//
// Watches the Bluesky jetstream for createRecord events on NSIDs that describe
// the bidder↔spindle contract flow and builds a directed graph of records and
// their StrongRef relationships.
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
  "com.publicdomainrelay.temp.compute.events.provisioning",
];

const NSID_LABELS: Record<string, string> = {
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
  "com.publicdomainrelay.temp.compute.events.provisioning": "events.provisioning",
  "com.fedcicd.tangled.spindle.gha": "spindle.gha",
  "com.fedproxy.tunnel": "tunnel",
};

export function nsidLabel(nsid: string): string {
  return NSID_LABELS[nsid] || nsid.split(".").pop() || nsid;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single jetstream frame (abridged — only fields we consume). */
export interface JetstreamFrame {
  did?: unknown;
  time_us?: unknown;
  kind?: unknown;
  commit?: {
    rev?: unknown;
    operation?: unknown;
    collection?: unknown;
    rkey?: unknown;
    record?: Record<string, unknown>;
    cid?: unknown;
  };
}

/** A parsed, graph-ready record node. */
export interface RecordNode {
  uri: string;
  cid: string;
  did: string;
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
  createdAt: string;
}

/** A directed edge between two records via a StrongRef field. */
export interface GraphEdge {
  from: string; // source URI (never mutated)
  to: string; // target URI (never mutated)
  label: string;
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
export function parseJetstreamFrame(frame: JetstreamFrame): RecordNode | null {
  if (!frame || typeof frame !== "object") return null;
  const commit = frame.commit;
  if (!commit || typeof commit !== "object") return null;
  if (commit.operation !== "create") return null;

  const collection = commit.collection;
  if (typeof collection !== "string" || !WATCHED_NSIDS.includes(collection)) {
    return null;
  }

  const did = typeof frame.did === "string" ? frame.did : "";
  const rkey = typeof commit.rkey === "string" ? commit.rkey : "";
  const cid = typeof commit.cid === "string" ? commit.cid : "";
  const record = commit.record ?? {};
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
 */
const REF_FIELDS: Record<string, [string, string][]> = {
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
 * Returns an array of { from, to, label }.
 */
export function extractEdges(node: RecordNode): GraphEdge[] {
  const fields = REF_FIELDS[node.collection] ?? [];
  const edges: GraphEdge[] = [];
  for (const [field, label] of fields) {
    const ref = node.record[field];
    if (!ref || typeof ref !== "object") continue;
    const refObj = ref as Record<string, unknown>;
    if (typeof refObj.uri !== "string") continue;
    edges.push({
      from: node.uri,
      to: refObj.uri,
      label: `${node.rkey}:${label}`,
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Fix-ups: synthetic record generation
// ---------------------------------------------------------------------------

/** Result of a fix-up pass. */
export interface FixUpResult {
  nodes: RecordNode[];
  edges: GraphEdge[];
}

/**
 * Resolve the compute.vm URI referenced by a receipt, if the full chain
 * receipt → rfp → vm is present in the node map.
 */
function resolveReceiptVm(
  node: RecordNode,
  nodeMap: Map<string, RecordNode>,
): string | null {
  const rfpRef = node.record["rfp"];
  if (!rfpRef || typeof rfpRef !== "object") return null;
  const rfpUri = (rfpRef as Record<string, unknown>).uri;
  if (typeof rfpUri !== "string") return null;
  const rfpNode = nodeMap.get(rfpUri);
  if (!rfpNode) return null;
  const payloadRef = rfpNode.record["payload"];
  if (!payloadRef || typeof payloadRef !== "object") return null;
  const vmUri = (payloadRef as Record<string, unknown>).uri;
  if (typeof vmUri !== "string") return null;
  return vmUri;
}

/**
 * Find an events.provisioning node whose vm strongRef points to `vmUri`.
 */
function findProvisioningForVm(
  vmUri: string,
  nodeMap: Map<string, RecordNode>,
): RecordNode | null {
  for (const n of nodeMap.values()) {
    if (n.collection !== "com.publicdomainrelay.temp.compute.events.provisioning") continue;
    const ref = n.record["vm"];
    if (!ref || typeof ref !== "object") continue;
    if (((ref as Record<string, unknown>).uri as string) === vmUri) return n;
  }
  return null;
}

/**
 * Find an existing market.event that references the given receipt URI.
 */
function findMarketEventForReceipt(
  receiptUri: string,
  nodeMap: Map<string, RecordNode>,
): RecordNode | null {
  for (const n of nodeMap.values()) {
    if (n.collection !== "com.publicdomainrelay.temp.market.event") continue;
    const ref = n.record["receipt"];
    if (!ref || typeof ref !== "object") continue;
    if (((ref as Record<string, unknown>).uri as string) === receiptUri) return n;
  }
  return null;
}

/** Role name hints from an rbac record: direct keys + ":role:<name>" sub suffixes. */
function rbacRoleSubs(rbacRecord: Record<string, unknown>): Set<string> {
  const roles = rbacRecord["roles"];
  if (!roles || typeof roles !== "object") return new Set();
  const subs = new Set<string>(Object.keys(roles as Record<string, unknown>));
  for (const roleVal of Object.values(roles as Record<string, unknown>)) {
    const sub = ((roleVal as Record<string, unknown>)["definition"] as Record<string, unknown> | undefined)?.["sub"];
    if (typeof sub === "string") {
      const m = sub.match(/:role:([^:]+)$/);
      if (m) subs.add(m[1]);
    }
  }
  return subs;
}

/** HTTP routes from an rbac record's policies[*].schemas keys. */
function rbacRoutes(rbacRecord: Record<string, unknown>): string[] {
  const policies = rbacRecord["policies"] as Record<string, unknown> | undefined;
  if (!policies || typeof policies !== "object") return [];
  const routes: string[] = [];
  for (const policy of Object.values(policies)) {
    const schemas = (policy as Record<string, unknown>)["schemas"];
    if (schemas && typeof schemas === "object") routes.push(...Object.keys(schemas as Record<string, unknown>));
  }
  return routes;
}

/**
 * When certain records arrive, generate synthetic companion records and edges
 * that fill in implicit graph relationships.
 *
 * Current fix-ups:
 *   market.receipt → events.provisioning (→vm) + synthetic market.event wrapping it
 *   market.event   → find events.provisioning for same vm, add payload edge
 *
 * Returns { nodes, edges } — nodes will be ingested, edges added directly.
 */
export function fixUps(
  node: RecordNode,
  nodeMap: Map<string, RecordNode>,
): FixUpResult {
  const synthetic: RecordNode[] = [];
  const extraEdges: GraphEdge[] = [];

  if (node.collection === "com.publicdomainrelay.temp.market.receipt") {
    const vmUri = resolveReceiptVm(node, nodeMap);
    if (!vmUri) return { nodes: [], edges: [] };
    const vmNode = nodeMap.get(vmUri);
    if (!vmNode) return { nodes: [], edges: [] };

    // 1) events.provisioning — only create if one doesn't already exist for this VM.
    const existingProv = findProvisioningForVm(vmUri, nodeMap);
    let provNode: RecordNode;
    if (existingProv) {
      provNode = existingProv;
    } else {
      const provRkey = `${node.rkey}_provisioning`;
      const provUri = `at://${node.did}/com.publicdomainrelay.temp.compute.events.provisioning/${provRkey}`;
      provNode = {
        uri: provUri,
        cid: "synthetic",
        did: node.did,
        collection: "com.publicdomainrelay.temp.compute.events.provisioning",
        rkey: provRkey,
        record: {
          $type: "com.publicdomainrelay.temp.compute.events.provisioning",
          vm: {
            $type: "com.atproto.repo.strongRef",
            cid: vmNode.cid,
            uri: vmNode.uri,
          },
        },
        createdAt: node.createdAt,
      };
      synthetic.push(provNode);
    }

    // 2) Synthetic market.event — wraps the provisioning event + points to receipt.
    //    Skip if a market.event already references this receipt (e.g. dedup across
    //    receipt+event events or computed from prior receipt).
    const existingEvent = findMarketEventForReceipt(node.uri, nodeMap);
    if (!existingEvent) {
      const eventRkey = `${node.rkey}_event`;
      const eventUri = `at://${node.did}/com.publicdomainrelay.temp.market.event/${eventRkey}`;
      const marketEvent: RecordNode = {
        uri: eventUri,
        cid: "synthetic",
        did: node.did,
        collection: "com.publicdomainrelay.temp.market.event",
        rkey: eventRkey,
        record: {
          $type: "com.publicdomainrelay.temp.market.event",
          receipt: {
            $type: "com.atproto.repo.strongRef",
            cid: node.cid,
            uri: node.uri,
          },
          payload: {
            $type: "com.atproto.repo.strongRef",
            cid: "synthetic",
            uri: provNode.uri,
          },
        },
        createdAt: node.createdAt,
      };
      synthetic.push(marketEvent);
    } else {
      // real market.event already exists — link it to provisioning
      extraEdges.push({
        from: existingEvent.uri,
        to: provNode.uri,
        label: `${existingEvent.rkey}:payload`,
      });
    }
  }

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
          ? (roleSubs.has(node.record["role"] as string) ? node : null)
          : allNodes.find(
              (n) =>
                n.collection === "com.publicdomainrelay.temp.compute.vm" &&
                roleSubs.has(n.record["role"] as string),
            ) ?? null;

      if (!vmNode) continue;

      const sshNodes =
        node.collection === "com.fedproxy.sshPublicKey"
          ? [node]
          : allNodes.filter((n) => n.collection === "com.fedproxy.sshPublicKey");
      const matchingSsh = sshNodes.find((n) => n.record["service"] === vmNode.record["role"]) ?? null;

      for (const route of rbacRoutes(rbacNode.record)) {
        if (route.endsWith(".createRecord")) {
          // sshPublicKey → rbac for the createRecord route
          if (matchingSsh && !extraEdges.some((e) => e.from === matchingSsh.uri && e.to === rbacNode.uri && e.label === route)) {
            extraEdges.push({ from: matchingSsh.uri, to: rbacNode.uri, label: route });
          }
        } else {
          // vm → rbac for all other routes
          if (!extraEdges.some((e) => e.from === vmNode.uri && e.to === rbacNode.uri && e.label === route)) {
            extraEdges.push({ from: vmNode.uri, to: rbacNode.uri, label: route });
          }
        }
      }

      // vm → sshPublicKey labeled "post public key"
      if (matchingSsh && !extraEdges.some((e) => e.from === vmNode.uri && e.to === matchingSsh.uri && e.label === "post public key")) {
        extraEdges.push({ from: vmNode.uri, to: matchingSsh.uri, label: "post public key" });
      }
    }
  }

  // ── market.rfp → synthetic spindle.gha ──────────────────────────────────────
  if (node.collection === "com.publicdomainrelay.temp.market.rfp") {
    const ghaUri = `at://${node.did}/com.fedcicd.tangled.spindle.gha/${node.rkey}`;
    if (!nodeMap.has(ghaUri)) {
      const ghaNode: RecordNode = {
        uri: ghaUri,
        cid: "synthetic",
        did: node.did,
        collection: "com.fedcicd.tangled.spindle.gha",
        rkey: node.rkey,
        record: { $type: "com.fedcicd.tangled.spindle.gha" },
        createdAt: node.createdAt,
      };
      synthetic.push(ghaNode);
      extraEdges.push({ from: ghaUri, to: node.uri, label: "created" });
    }
  }

  // ── sshPublicKey → spindle.gha edge labeled "tunnel" ───────────────────────
  if (node.collection === "com.fedproxy.sshPublicKey") {
    const ghaNode = [...nodeMap.values()].find((n) => n.collection === "com.fedcicd.tangled.spindle.gha") ?? null;
    if (ghaNode && !extraEdges.some((e) => e.from === node.uri && e.to === ghaNode.uri && e.label === "tunnel")) {
      extraEdges.push({ from: node.uri, to: ghaNode.uri, label: "tunnel" });
    }
  }

  if (node.collection === "com.publicdomainrelay.temp.market.event") {
    // Skip if this is a synthetic node we just created (cid === "synthetic").
    if (node.cid === "synthetic") return { nodes: synthetic, edges: extraEdges };

    // Real market.event — walk receipt → rfp → vm, find provisioning, add edge.
    const ref = node.record["receipt"];
    if (!ref || typeof ref !== "object") return { nodes: synthetic, edges: extraEdges };
    const receiptUri = (ref as Record<string, unknown>).uri;
    if (typeof receiptUri !== "string") return { nodes: synthetic, edges: extraEdges };

    const receiptNode = nodeMap.get(receiptUri);
    if (!receiptNode) return { nodes: synthetic, edges: extraEdges };

    const vmUri = resolveReceiptVm(receiptNode, nodeMap);
    if (!vmUri) return { nodes: synthetic, edges: extraEdges };

    const provNode = findProvisioningForVm(vmUri, nodeMap);
    // Only add the payload→provisioning edge if the synthetic market.event
    // (created during receipt fixUp) doesn't already carry it.  The synthetic
    // has uri ending in "_event" and already has extractEdges emit that edge.
    const syntheticEventUri = `at://${receiptNode.did}/com.publicdomainrelay.temp.market.event/${receiptNode.rkey}_event`;
    const syntheticAlreadyExists = nodeMap.has(syntheticEventUri);
    if (provNode && !syntheticAlreadyExists) {
      extraEdges.push({
        from: node.uri,
        to: provNode.uri,
        label: `${node.rkey}:payload`,
      });
    }
  }

  return { nodes: synthetic, edges: extraEdges };
}
