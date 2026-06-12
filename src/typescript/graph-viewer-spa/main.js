// Market Graph Viewer — DOM glue, jetstream, d3 force graph.
//
// Subscribes to the Bluesky jetstream for createRecord events on all NSIDs
// in the bidder↔spindle market flow (see graph.js). Builds a live force-directed
// graph with d3 where each node is an atproto record and each edge is a
// StrongRef relationship (rfp, bid, accept, receipt, payload, config).
//
// Hover a node → see the record as YAML. Click a node → open it on pdsls.dev.
// Pin a node to keep it visible in the detail pane.
//
// D3 force simulation runs continuously; new nodes are added in real time.
//
// Recording: captures raw jetstream frames. Recordings persist in localStorage,
// can be replayed, downloaded as JSON, or imported from file.

import * as d3 from "d3";

import {
  WATCHED_NSIDS,
  nsidLabel,
  nsidColor,
  parseJetstreamFrame,
  extractEdges,
  fixUps,
  toYaml,
  pdslsUrl,
  shortDid,
} from "./graph.js";

// ---------------------------------------------------------------------------
// Jetstream
// ---------------------------------------------------------------------------

const JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe";

let jetstreamSocket;
let paused = false;
const recordNodes = [];  // ordered list of all received record nodes
const nodeMap = new Map(); // uri → index in recordNodes
const edgeList = [];      // { from: uri, to: uri, label }
const hiddenNsids = new Set(); // NSIDs the user has hidden via toggles

// ---------------------------------------------------------------------------
// Recording state
// ---------------------------------------------------------------------------

const STORAGE_KEY = "market-graph-recordings";
let recordingFrames = [];   // raw jetstream frames captured during recording
let isRecording = false;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusEl = document.getElementById("status");
const nodeCountEl = document.getElementById("node-count");
const edgeCountEl = document.getElementById("edge-count");
const nsidFiltersEl = document.getElementById("nsid-filters");
const pauseBtn = document.getElementById("pause-button");
const clearBtn = document.getElementById("clear-button");

const recIndicator = document.getElementById("rec-indicator");
const recButton = document.getElementById("rec-button");
const sessionSelect = document.getElementById("session-select");
const sessionLoadBtn = document.getElementById("session-load-button");
const sessionDownloadBtn = document.getElementById("session-download-button");
const sessionImportBtn = document.getElementById("session-import-button");
const importFileInput = document.getElementById("import-file-input");

const detailEmpty = document.getElementById("detail-empty");
const detailHeader = document.getElementById("detail-header");
const detailTitle = document.getElementById("detail-title");
const detailUri = document.getElementById("detail-uri");
const detailMeta = document.getElementById("detail-meta");
const detailYaml = document.getElementById("detail-yaml");
const detailActions = document.getElementById("detail-actions");
const detailPdslsLink = document.getElementById("detail-pdsls-link");
const detailPinBtn = document.getElementById("detail-pin-button");

let pinnedUri = null;

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function buildLegend() {
  const legend = document.getElementById("legend");
  let html = '<table>';
  for (const nsid of WATCHED_NSIDS) {
    const color = nsidColor(nsid);
    html += `<tr><td><span class="swatch" style="background:${color};"></span>${nsidLabel(nsid)}</td></tr>`;
  }
  html += '</table>';
  legend.innerHTML = html;
}

// ---------------------------------------------------------------------------
// NSID filter toggles
// ---------------------------------------------------------------------------

function buildNsidToggles() {
  nsidFiltersEl.innerHTML = "";
  for (const nsid of WATCHED_NSIDS) {
    const label = document.createElement("label");
    label.title = nsid;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.addEventListener("change", () => {
      if (input.checked) {
        hiddenNsids.delete(nsid);
        label.classList.remove("off");
      } else {
        hiddenNsids.add(nsid);
        label.classList.add("off");
      }
      restartSimulation();
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(nsidLabel(nsid)));
    nsidFiltersEl.appendChild(label);
  }
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function showDetail(node) {
  detailEmpty.style.display = "none";
  detailHeader.style.display = "";
  detailYaml.style.display = "";
  detailActions.style.display = "flex";

  detailTitle.textContent = `${nsidLabel(node.collection)} · ${node.rkey}`;
  detailUri.textContent = node.uri;
  detailMeta.textContent = `DID: ${shortDid(node.did, 32)} · ${node.createdAt}`;

  let yaml;
  try {
    yaml = toYaml(node.record);
  } catch {
    yaml = JSON.stringify(node.record, null, 2);
  }
  detailYaml.textContent = yaml;

  detailPdslsLink.onclick = () => {
    window.open(pdslsUrl(node.uri), "_blank");
  };

  detailPinBtn.textContent = pinnedUri === node.uri ? "Unpin node" : "Pin node";
  detailPinBtn.onclick = () => {
    if (pinnedUri === node.uri) {
      pinnedUri = null;
      detailPinBtn.textContent = "Pin node";
    } else {
      pinnedUri = node.uri;
      detailPinBtn.textContent = "Unpin node";
    }
  };
}

function hideDetail() {
  if (pinnedUri && nodeMap.has(pinnedUri)) {
    const node = recordNodes[nodeMap.get(pinnedUri)];
    showDetail(node);
    return;
  }
  pinnedUri = null;
  detailEmpty.style.display = "";
  detailHeader.style.display = "none";
  detailYaml.style.display = "none";
  detailActions.style.display = "none";
}

// ---------------------------------------------------------------------------
// D3 force graph
// ---------------------------------------------------------------------------

let simulation;
let svg, gZoom, linkG, nodeG, labelG;
let nodeSel, linkSel, labelSel, edgeLabelSel;
let zoomBehavior;       // stored so we can transition to new nodes
let pendingCenterNode = null; // node to center on after simulation settles

function visibleNodes() {
  return recordNodes.filter(n => !hiddenNsids.has(n.collection));
}

function visibleEdges() {
  const visibleUris = new Set(visibleNodes().map(n => n.uri));
  return edgeList.filter(e => visibleUris.has(e.from) && visibleUris.has(e.to));
}

function initGraph() {
  svg = d3.select("#graph-pane svg");
  gZoom = svg.append("g");

  // zoom/pan
  zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 8])
    .on("zoom", (event) => gZoom.attr("transform", event.transform));
  svg.call(zoomBehavior);
  // viewBox "-cx -cy w h" already maps origin to viewport centre.
  // Start with identity transform so (0,0) renders at centre.

  // layers, back-to-front
  linkG = gZoom.append("g").attr("class", "links");
  nodeG = gZoom.append("g").attr("class", "nodes");
  labelG = gZoom.append("g").attr("class", "labels");

  simulation = d3.forceSimulation()
    .force("link", d3.forceLink().id(d => d.uri).distance(150).iterations(2))
    .force("charge", d3.forceManyBody().strength(-800).distanceMin(30).distanceMax(600))
    .force("collide", d3.forceCollide(45).strength(0.8).iterations(3))
    .force("center", d3.forceCenter(0, 0).strength(0.1))
    .alphaDecay(0.02) // slow decay so the graph stays lively
    .on("tick", () => {
      ticked();
      if (pendingCenterNode && simulation.alpha() < 0.05) {
        centerOnNode(pendingCenterNode);
        pendingCenterNode = null;
      }
    });

  resizeGraph();
}

function resizeGraph() {
  const pane = document.getElementById("graph-pane");
  svg.attr("viewBox", [-pane.clientWidth / 2, -pane.clientHeight / 2, pane.clientWidth, pane.clientHeight]);
}

window.addEventListener("resize", resizeGraph);

function restartSimulation() {
  pendingCenterNode = null; // only addRecord sets this, then re-restarts
  const nodes = visibleNodes();
  const edges = visibleEdges();

  // Update counts
  nodeCountEl.textContent = nodes.length;
  edgeCountEl.textContent = edges.length;

  // --- links ---
  linkSel = linkG.selectAll("line").data(edges, d => `${d.from}→${d.to}@${d.label}`);
  linkSel.exit().remove();
  const linkEnter = linkSel.enter().append("line")
    .attr("stroke", "#999")
    .attr("stroke-width", 1.5)
    .attr("stroke-opacity", 0.6);
  linkSel = linkEnter.merge(linkSel);

  // --- nodes ---
  nodeSel = nodeG.selectAll("circle").data(nodes, d => d.uri);
  nodeSel.exit().remove();
  const nodeEnter = nodeSel.enter().append("circle")
    .attr("r", 8)
    .attr("fill", d => nsidColor(d.collection))
    .attr("stroke", "#555")
    .attr("stroke-width", 1.5)
    .attr("cursor", "pointer")
    .call(d3.drag()
      .on("start", dragStarted)
      .on("drag", dragged)
      .on("end", dragEnded))
    .on("mouseenter", (event, d) => {
      showDetail(d);
      d3.select(event.target).attr("stroke", "#000").attr("stroke-width", 3);
    })
    .on("mouseleave", (event, d) => {
      d3.select(event.target).attr("stroke", "#555").attr("stroke-width", 1.5);
    });
  nodeSel = nodeEnter.merge(nodeSel);

  // --- node labels (shortened NSID) ---
  labelSel = labelG.selectAll("text.node-label").data(nodes, d => d.uri);
  labelSel.exit().remove();
  const labelEnter = labelSel.enter().append("text")
    .attr("class", "node-label")
    .text(d => nsidLabel(d.collection));
  labelSel = labelEnter.merge(labelSel);

  // --- edge labels ---
  edgeLabelSel = labelG.selectAll("text.edge-label").data(edges, d => `${d.from}→${d.to}@${d.label}`);
  edgeLabelSel.exit().remove();
  const edgeLabelEnter = edgeLabelSel.enter().append("text")
    .attr("class", "edge-label")
    .text(d => d.label.slice(d.label.indexOf(':') + 1));
  edgeLabelSel = edgeLabelEnter.merge(edgeLabelSel);

  // Compute per-node degree to identify leaves
  const degree = new Map(nodes.map(n => [n.uri, 0]));
  for (const e of edges) {
    if (degree.has(e.from)) degree.set(e.from, degree.get(e.from) + 1);
    if (degree.has(e.to))   degree.set(e.to,   degree.get(e.to)   + 1);
  }
  const radialR = Math.max(200, Math.sqrt(nodes.length) * 70);
  simulation.force("radial", d3.forceRadial(radialR, 0, 0).strength(d => {
    return (degree.get(d.uri) || 0) <= 1 ? 1.0 : 0;
  }));

  // Update simulation
  simulation.nodes(nodes);
  simulation.force("link").links(edges);
  simulation.alpha(0.3).restart();
}

function ticked() {
  if (linkSel) {
    linkSel
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);
  }

  if (nodeSel) {
    nodeSel
      .attr("cx", d => d.x)
      .attr("cy", d => d.y);
  }

  if (labelSel) {
    labelSel
      .attr("x", d => d.x)
      .attr("y", d => d.y + 16);
  }

  // Update edge labels — place at midpoint
  if (edgeLabelSel) {
    edgeLabelSel
      .attr("x", d => (d.source.x + d.target.x) / 2)
      .attr("y", d => (d.source.y + d.target.y) / 2);
  }
}

function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}

// ---------------------------------------------------------------------------
// Graph data ingestion (used by live stream + replay)
// ---------------------------------------------------------------------------

/** Insert a node into recordNodes + nodeMap + edgeList. Returns true if added. */
function _ingestNode(node) {
  if (!node || !node.uri) return false;
  if (nodeMap.has(node.uri)) return false;
  if (hiddenNsids.has(node.collection)) return false;
  const idx = recordNodes.length;
  recordNodes.push(node);
  nodeMap.set(node.uri, idx);
  for (const e of extractEdges(node)) edgeList.push(e);
  return true;
}

// ---------------------------------------------------------------------------
// Add a record to the graph (live event)
// ---------------------------------------------------------------------------

function _pushEdge(e) {
  if (!edgeList.some((x) => x.from === e.from && x.to === e.to && x.label === e.label)) {
    edgeList.push(e);
  }
}

/** Run fixUps for `node`, ingest any synthetic nodes it returns, add deduped edges. */
function _applyFixUps(node) {
  const uriToNode = new Map(recordNodes.map((n) => [n.uri, n]));
  const { nodes: synthNodes, edges: fixEdges } = fixUps(node, uriToNode);
  for (const synth of synthNodes) {
    if (_ingestNode(synth)) _applyFixUps(synth);
  }
  for (const e of fixEdges) _pushEdge(e);
}

/**
 * For real market.event nodes: if a synthetic already exists for the same
 * receipt, merge into it (add payload edge from synthetic URI) and skip
 * creating a separate D3 node.  Returns true if merged (caller should skip
 * normal ingest).
 */
function _mergeMarketEventIfSynthetic(node) {
  if (node.collection !== "com.publicdomainrelay.temp.market.event") return false;
  if (node.cid === "synthetic") return false;
  const receiptUri = node.record["receipt"]?.uri;
  if (!receiptUri) return false;
  const synth = recordNodes.find(
    (n) =>
      n.collection === "com.publicdomainrelay.temp.market.event" &&
      n.cid === "synthetic" &&
      n.record["receipt"]?.uri === receiptUri,
  );
  if (!synth) return false;
  // Redirect the real event's payload edge to come FROM the synthetic node
  const payloadUri = node.record["payload"]?.uri;
  if (payloadUri) {
    _pushEdge({ from: synth.uri, to: payloadUri, source: synth.uri, target: payloadUri, label: `${node.rkey}:payload` });
  }
  return true;
}

function addRecord(node) {
  if (_mergeMarketEventIfSynthetic(node)) {
    restartSimulation();
    return;
  }
  if (!_ingestNode(node)) return;
  _applyFixUps(node);
  restartSimulation();        // clears pendingCenterNode
  pendingCenterNode = node;   // set after restart so tick handler sees it
}

/** Pan/zoom so `node` is at viewport center. Keeps current scale. */
function centerOnNode(node) {
  const currentTransform = d3.zoomTransform(svg.node());
  const k = currentTransform.k;
  // viewBox "-cx -cy w h" maps (0,0) to viewport centre, so
  // a node at (nx,ny) is centred when translate = (-nx*k, -ny*k).
  const tx = -node.x * k;
  const ty = -node.y * k;
  svg.transition().duration(600).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(tx, ty).scale(k),
  );
}

// ---------------------------------------------------------------------------
// Recording — localStorage persistence
// ---------------------------------------------------------------------------

function getRecordings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function setRecordings(arr) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
}

function buildSessionDropdown() {
  const recordings = getRecordings();
  sessionSelect.innerHTML = '<option value="">— saved sessions —</option>';
  for (let i = recordings.length - 1; i >= 0; i--) {
    const r = recordings[i];
    const sizeKB = Math.round(JSON.stringify(r).length / 1024);
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${r.name} (${r.nodeCount}n · ~${sizeKB}KB)`;
    sessionSelect.appendChild(opt);
  }
  updateSessionButtons();
}

function updateSessionButtons() {
  const hasSelection = sessionSelect.value !== "";
  sessionLoadBtn.disabled = !hasSelection;
  sessionDownloadBtn.disabled = !hasSelection;
}

function updateRecUI() {
  if (isRecording) {
    recButton.textContent = "⏹ Stop";
    recButton.classList.add("recording");
    recIndicator.style.display = "";
  } else {
    recButton.textContent = "⏺ Record";
    recButton.classList.remove("recording");
    recIndicator.style.display = "none";
  }
}

function startRecording() {
  recordingFrames = [];
  isRecording = true;
  updateRecUI();
}

function stopRecording() {
  isRecording = false;
  updateRecUI();
  if (recordingFrames.length === 0) return;

  // Collect DIDs referenced by commit events (the ones we actually care about).
  const referencedDids = new Set();
  for (const frame of recordingFrames) {
    if (frame.kind === "commit" && frame.commit && frame.did) {
      referencedDids.add(frame.did);
    }
  }

  // Purge identity/account events whose DID isn't referenced by any commit.
  const filtered = recordingFrames.filter(frame => {
    if (frame.kind === "identity" || frame.kind === "account") {
      const did = frame.kind === "identity"
        ? (frame.identity && frame.identity.did)
        : (frame.account && frame.account.did);
      return did && referencedDids.has(did);
    }
    return true;
  });

  const recordings = getRecordings();
  const name = `Session ${recordings.length + 1} — ${new Date().toLocaleString()}`;
  recordings.push({
    id: Date.now().toString(36),
    name,
    nodeCount: recordNodes.length,
    edgeCount: edgeList.length,
    createdAt: new Date().toISOString(),
    events: filtered,
  });
  setRecordings(recordings);
  recordingFrames = [];
  buildSessionDropdown();
}

/** Clear graph and replay a stored session's events in batch. */
function replaySession(stored) {
  recordNodes.length = 0;
  nodeMap.clear();
  edgeList.length = 0;
  pinnedUri = null;
  hideDetail();

  for (const frame of stored.events) {
    const rec = parseJetstreamFrame(frame);
    if (!rec) continue;
    if (_mergeMarketEventIfSynthetic(rec)) continue;
    if (_ingestNode(rec)) _applyFixUps(rec);
  }

  restartSimulation();
}

/** Download the selected recording as a JSON file. */
function downloadRecording(stored) {
  const blob = new Blob([JSON.stringify(stored, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `market-graph-${stored.id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Import a recording from a JSON file. */
function importRecording(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      // Accept either a single recording object or an array of them
      const items = Array.isArray(data) ? data : [data];
      const recordings = getRecordings();
      let added = 0;
      for (const item of items) {
        if (!item.events || !Array.isArray(item.events)) continue;
        item.id = item.id || Date.now().toString(36) + "_" + added;
        item.importedAt = new Date().toISOString();
        recordings.push(item);
        added++;
      }
      if (added === 0) throw new Error("No valid recording found in file (missing events array).");
      setRecordings(recordings);
      buildSessionDropdown();
      statusEl.textContent = `📂 imported ${added} recording(s)`;
      setTimeout(() => {
        if (statusEl.textContent.startsWith("📂")) {
          statusEl.textContent = jetstreamSocket && jetstreamSocket.readyState === WebSocket.OPEN ? "● live" : "● disconnected";
        }
      }, 3000);
    } catch (err) {
      alert(`Failed to import recording: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Jetstream connection
// ---------------------------------------------------------------------------

function connectJetstream() {
  const url = new URL(JETSTREAM_URL);
  for (const nsid of WATCHED_NSIDS) {
    url.searchParams.append("wantedCollections", nsid);
  }

  statusEl.textContent = "● connecting…";
  statusEl.className = "";

  let socket;
  try {
    socket = new WebSocket(url.toString());
  } catch (err) {
    statusEl.textContent = `● connection failed: ${err.message || err}`;
    statusEl.className = "disconnected";
    // Retry after 5s.
    setTimeout(connectJetstream, 5000);
    return;
  }
  jetstreamSocket = socket;

  socket.onopen = () => {
    statusEl.textContent = "● live";
    statusEl.className = "connected";
  };

  socket.onmessage = (event) => {
    if (paused) return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return; // malformed frame — skip
    }
    if (isRecording) recordingFrames.push(frame);
    const rec = parseJetstreamFrame(frame);
    if (rec) addRecord(rec);
  };

  socket.onerror = () => {
    statusEl.textContent = "● stream error";
    statusEl.className = "disconnected";
  };

  socket.onclose = (event) => {
    jetstreamSocket = undefined;
    statusEl.textContent = `● disconnected (code ${event.code})`;
    statusEl.className = "disconnected";
    if (!paused) {
      // Reconnect after a short delay.
      setTimeout(connectJetstream, 3000);
    }
  };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  if (paused) {
    if (jetstreamSocket) {
      jetstreamSocket.close();
      jetstreamSocket = undefined;
    }
    statusEl.textContent = "⏸ paused";
    statusEl.className = "";
  } else {
    connectJetstream();
  }
});

clearBtn.addEventListener("click", () => {
  recordNodes.length = 0;
  nodeMap.clear();
  edgeList.length = 0;
  pinnedUri = null;
  hideDetail();
  restartSimulation();
});

// --- Recording controls ---

recButton.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

sessionSelect.addEventListener("change", updateSessionButtons);

sessionLoadBtn.addEventListener("click", () => {
  const recordings = getRecordings();
  const idx = parseInt(sessionSelect.value);
  if (isNaN(idx) || !recordings[idx]) return;
  replaySession(recordings[idx]);
});

sessionDownloadBtn.addEventListener("click", () => {
  const recordings = getRecordings();
  const idx = parseInt(sessionSelect.value);
  if (isNaN(idx) || !recordings[idx]) return;
  downloadRecording(recordings[idx]);
});

sessionImportBtn.addEventListener("click", () => {
  importFileInput.click();
});

importFileInput.addEventListener("change", () => {
  const file = importFileInput.files[0];
  if (file) importRecording(file);
  importFileInput.value = "";
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  buildLegend();
  buildNsidToggles();
  initGraph();
  buildSessionDropdown();
  startRecording();
  connectJetstream();
}

document.addEventListener("DOMContentLoaded", init);
