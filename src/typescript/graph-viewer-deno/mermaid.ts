import { type RecordNode, type GraphEdge, nsidLabel } from "./graph.ts";

// ---------------------------------------------------------------------------
// Mermaid flowchart generator
// ---------------------------------------------------------------------------

/**
 * Escape a string for use inside a Mermaid node label.
 * Replaces `"` with `#quot;`.
 */
function escapeLabel(text: string): string {
  return text.replace(/"/g, "#quot;");
}

/**
 * Compute a dedup key for a record node.  Two nodes with the same key share a
 * single visual Mermaid node.
 *
 * For most NSIDs the key is just the collection — all records of the same type
 * merge.  For com.fedproxy.rbac the key includes protects[].service and
 * protects[].scope so that RBAC records for different resources get distinct
 * nodes.
 */
function dedupKey(n: RecordNode): string {
  if (n.collection !== "com.fedproxy.rbac") return n.collection;

  const protects = n.record["protects"];
  if (protects && typeof protects === "object") {
    const entries = Object.values(protects as Record<string, unknown>);
    if (entries.length > 0) {
      const first = entries[0] as Record<string, unknown> | undefined;
      if (first && typeof first === "object") {
        const svc = String(first.service ?? "");
        const scope = String(first.scope ?? "");
        if (svc || scope) return `${n.collection}::${svc}::${scope}`;
      }
    }
  }
  // No protects or empty — key on collection alone.
  return n.collection;
}

/**
 * Mermaid-safe node id from a dedup key.
 */
let _nodeIdCounter = 0;
const _nodeIdByKey = new Map<string, string>();
function nodeId(key: string): string {
  const existing = _nodeIdByKey.get(key);
  if (existing) return existing;
  const id = `n${_nodeIdCounter++}`;
  _nodeIdByKey.set(key, id);
  return id;
}

/**
 * Build a Mermaid `flowchart LR` diagram string representing the full current
 * graph state: every node and every edge whose both endpoints are present.
 * Nodes with the same dedup key are merged into a single visual node.
 */
export function toMermaid(nodes: RecordNode[], edges: GraphEdge[]): string {
  const lines: string[] = ["flowchart LR"];

  // Map uri → mermaid node id (deduped by content-aware key)
  const idMap = new Map<string, string>();
  const emitted = new Set<string>();

  for (const n of nodes) {
    const mid = nodeId(dedupKey(n));
    idMap.set(n.uri, mid);
    if (!emitted.has(mid)) {
      emitted.add(mid);
      const label = nsidLabel(n.collection);
      lines.push(`  ${mid}["${escapeLabel(label)}"]`);
    }
  }

  // Count how many URIs map to each mermaid id so we can detect merged nodes.
  const idUriCount = new Map<string, number>();
  for (const mid of idMap.values()) {
    idUriCount.set(mid, (idUriCount.get(mid) ?? 0) + 1);
  }

  // Only emit edges where both endpoints are known.  Dedup by Mermaid node
  // ids — two records of the same collection collapse to one visual node, so
  // their edges would produce duplicate `A -->|label| B` lines.
  // For merged (deduped) source nodes keep the full `${rkey}:${field}` label
  // so arrows are distinguishable.  For unmerged source nodes strip the rkey
  // prefix and show only the field name.
  const edgeDedup = new Set<string>();
  for (const edge of edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to) continue; // dangling reference
    const isMerged = (idUriCount.get(from) ?? 1) > 1;
    const displayLabel = isMerged
      ? edge.label
      : edge.label.slice(edge.label.indexOf(":") + 1);
    const key = `${from}-->|${displayLabel}|${to}`;
    if (edgeDedup.has(key)) continue;
    edgeDedup.add(key);
    lines.push(`  ${from} -->|${displayLabel}| ${to}`);
  }

  return lines.join("\n");
}
