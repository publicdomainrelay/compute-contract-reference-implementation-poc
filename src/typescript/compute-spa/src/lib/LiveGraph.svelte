<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import * as d3 from 'd3';
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
  } from './graph.js';
  import {
    getRecordings,
    setRecordings,
    downloadStoredSession,
    parseImportData,
    type StoredSession,
  } from './recordings.ts';
  import { JetstreamClient } from './jetstream-client.ts';

  // DOM refs
  let graphPane: HTMLDivElement;
  let svgEl: SVGSVGElement;

  // Reactive state
  let status = $state('● connecting…');
  let statusClass = $state('');
  let nodeCount = $state(0);
  let edgeCount = $state(0);
  let paused = $state(false);
  let isRecording = $state(false);
  let detailNode = $state<any>(null);
  let pinnedUri = $state<string | null>(null);
  let sessions = $state<StoredSession[]>([]);
  let selectedSessionIdx = $state('');

  // Graph data (not reactive — mutated directly, d3 owns rendering)
  const recordNodes: any[] = [];
  const nodeMap = new SvelteMap<string, number>();
  const edgeList: any[] = [];
  const hiddenNsids = new SvelteSet<string>();
  const nsidToggles = $state<Record<string, boolean>>(
    Object.fromEntries(WATCHED_NSIDS.map((n: string) => [n, true]))
  );

  let recordingFrames: any[] = [];

  // D3 handles
  let simulation: d3.Simulation<any, any>;
  let svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  let gZoom: d3.Selection<SVGGElement, unknown, null, undefined>;
  let linkG: d3.Selection<SVGGElement, unknown, null, undefined>;
  let nodeG: d3.Selection<SVGGElement, unknown, null, undefined>;
  let labelG: d3.Selection<SVGGElement, unknown, null, undefined>;
  let nodeSel: any, linkSel: any, labelSel: any, edgeLabelSel: any;
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown>;
  let pendingCenterNode: any = null;

  const jetstreamClient = new JetstreamClient({
    onFrame(frame) {
      if (isRecording) recordingFrames.push(frame);
      const rec = parseJetstreamFrame(frame);
      if (rec) addRecord(rec);
    },
    onStatusChange(s, cls) { status = s; statusClass = cls; },
    onClose() {
      if (!paused) setTimeout(() => jetstreamClient.connect(), 3000);
    },
  });

  // ── graph helpers ───────────────────────────────────────────────────────────

  function visibleNodes() {
    return recordNodes.filter((n) => !hiddenNsids.has(n.collection));
  }

  function visibleEdges() {
    const uris = new Set(visibleNodes().map((n: any) => n.uri));
    return edgeList.filter((e) => uris.has(e.from) && uris.has(e.to));
  }

  function initGraph() {
    svg = d3.select(svgEl);
    gZoom = svg.append('g');

    zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .on('zoom', (event) => {
        const t = event.transform;
        if (isFinite(t.x) && isFinite(t.y) && isFinite(t.k)) {
          gZoom.attr('transform', t);
        }
      });
    svg.call(zoomBehavior);

    linkG = gZoom.append('g').attr('class', 'links');
    nodeG = gZoom.append('g').attr('class', 'nodes');
    labelG = gZoom.append('g').attr('class', 'labels');

    simulation = d3.forceSimulation()
      .force('link', d3.forceLink().id((d: any) => d.uri).distance(150).iterations(2))
      .force('charge', d3.forceManyBody().strength(-800).distanceMin(30).distanceMax(600))
      .force('collide', d3.forceCollide(45).strength(0.8).iterations(3))
      .force('center', d3.forceCenter(0, 0).strength(0.1))
      .alphaDecay(0.02)
      .on('tick', () => {
        ticked();
        if (pendingCenterNode && simulation.alpha() < 0.05) {
          centerOnNode(pendingCenterNode);
          pendingCenterNode = null;
        }
      });

    resizeGraph();
  }

  function resizeGraph() {
    if (!graphPane || !svgEl) return;
    const w = graphPane.clientWidth;
    const h = graphPane.clientHeight;
    svg.attr('viewBox', [-w / 2, -h / 2, w, h] as any);
  }

  function restartSimulation() {
    pendingCenterNode = null;
    const nodes = visibleNodes();
    const edges = visibleEdges();
    nodeCount = nodes.length;
    edgeCount = edges.length;

    linkSel = linkG.selectAll('line').data(edges, (d: any) => `${d.from}→${d.to}@${d.label}`);
    linkSel.exit().remove();
    linkSel = linkSel.enter().append('line')
      .attr('stroke', '#cbd5e1').attr('stroke-width', 1.5).attr('stroke-opacity', 0.8)
      .merge(linkSel);

    nodeSel = nodeG.selectAll('circle').data(nodes, (d: any) => d.uri);
    nodeSel.exit().remove();
    nodeSel = nodeSel.enter().append('circle')
      .attr('r', 8)
      .attr('fill', (d: any) => nsidColor(d.collection))
      .attr('stroke', '#fff').attr('stroke-width', 1.5).attr('cursor', 'pointer')
      .call(d3.drag<SVGCircleElement, any>()
        .on('start', (event: any, d: any) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (event: any, d: any) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event: any, d: any) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
      .on('mouseenter', (event: any, d: any) => {
        detailNode = d;
        d3.select(event.target).attr('stroke', '#1c2333').attr('stroke-width', 3);
      })
      .on('mouseleave', (event: any) => {
        if (!pinnedUri) detailNode = null;
        d3.select(event.target).attr('stroke', '#fff').attr('stroke-width', 1.5);
      })
      .on('click', (_event: any, d: any) => {
        window.open(pdslsUrl(d.uri), '_blank');
      })
      .merge(nodeSel);

    labelSel = labelG.selectAll('text.node-label').data(nodes, (d: any) => d.uri);
    labelSel.exit().remove();
    labelSel = labelSel.enter().append('text').attr('class', 'node-label')
      .text((d: any) => nsidLabel(d.collection))
      .merge(labelSel);

    edgeLabelSel = labelG.selectAll('text.edge-label').data(edges, (d: any) => `${d.from}→${d.to}@${d.label}`);
    edgeLabelSel.exit().remove();
    edgeLabelSel = edgeLabelSel.enter().append('text').attr('class', 'edge-label')
      .text((d: any) => d.label.slice(d.label.indexOf(':') + 1))
      .merge(edgeLabelSel);

    const degree = new Map(nodes.map((n: any) => [n.uri, 0]));
    for (const e of edges) {
      if (degree.has(e.from)) degree.set(e.from, degree.get(e.from)! + 1);
      if (degree.has(e.to))   degree.set(e.to,   degree.get(e.to)!   + 1);
    }
    const radialR = Math.max(200, Math.sqrt(nodes.length) * 70);
    simulation.force('radial', d3.forceRadial(radialR, 0, 0).strength((d: any) =>
      (degree.get(d.uri) || 0) <= 1 ? 1.0 : 0));

    simulation.nodes(nodes);
    (simulation.force('link') as d3.ForceLink<any, any>).links(edges);
    simulation.alpha(0.3).restart();
  }

  function ticked() {
    if (linkSel) {
      linkSel.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
             .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
    }
    if (nodeSel) {
      nodeSel.attr('cx', (d: any) => d.x).attr('cy', (d: any) => d.y);
    }
    if (labelSel) {
      labelSel.attr('x', (d: any) => d.x).attr('y', (d: any) => d.y + 16);
    }
    if (edgeLabelSel) {
      edgeLabelSel
        .attr('x', (d: any) => (d.source.x + d.target.x) / 2)
        .attr('y', (d: any) => (d.source.y + d.target.y) / 2);
    }
  }

  function centerOnNode(node: any) {
    if (!svgEl || !isFinite(node.x) || !isFinite(node.y)) return;
    const t = d3.zoomTransform(svgEl);
    const k = t.k;
    svg.transition().duration(600).call(
      zoomBehavior.transform,
      d3.zoomIdentity.translate(-node.x * k, -node.y * k).scale(k),
    );
  }

  // ── graph ingestion ─────────────────────────────────────────────────────────

  function _ingestNode(node: any): boolean {
    if (!node || !node.uri) return false;
    if (nodeMap.has(node.uri)) return false;
    if (hiddenNsids.has(node.collection)) return false;
    const idx = recordNodes.length;
    recordNodes.push(node);
    nodeMap.set(node.uri, idx);
    for (const e of extractEdges(node)) edgeList.push(e);
    return true;
  }

  function _pushEdge(e: any) {
    if (!edgeList.some((x) => x.from === e.from && x.to === e.to && x.label === e.label)) {
      edgeList.push(e);
    }
  }

  function _applyFixUps(node: any) {
    const uriToNode = new Map(recordNodes.map((n: any) => [n.uri, n]));
    const { nodes: synthNodes, edges: fixEdges } = fixUps(node, uriToNode);
    for (const synth of synthNodes) {
      if (_ingestNode(synth)) _applyFixUps(synth);
    }
    for (const e of fixEdges) _pushEdge(e);
  }

  function _mergeMarketEventIfSynthetic(node: any): boolean {
    if (node.collection !== 'com.publicdomainrelay.temp.market.event') return false;
    if (node.cid === 'synthetic') return false;
    const receiptUri = node.record['receipt']?.uri;
    if (!receiptUri) return false;
    const synth = recordNodes.find(
      (n) => n.collection === 'com.publicdomainrelay.temp.market.event' &&
             n.cid === 'synthetic' && n.record['receipt']?.uri === receiptUri,
    );
    if (!synth) return false;
    const payloadUri = node.record['payload']?.uri;
    if (payloadUri) {
      _pushEdge({ from: synth.uri, to: payloadUri, source: synth.uri, target: payloadUri, label: `${node.rkey}:payload` });
    }
    return true;
  }

  function addRecord(node: any) {
    if (_mergeMarketEventIfSynthetic(node)) { restartSimulation(); return; }
    if (!_ingestNode(node)) return;
    _applyFixUps(node);
    restartSimulation();
    pendingCenterNode = node;
  }

  // ── NSID toggles ────────────────────────────────────────────────────────────

  function toggleNsid(nsid: string, checked: boolean) {
    if (checked) hiddenNsids.delete(nsid);
    else hiddenNsids.add(nsid);
    restartSimulation();
  }

  // ── recording ───────────────────────────────────────────────────────────────

  function refreshSessions() {
    sessions = getRecordings();
  }

  function startRecording() {
    recordingFrames = [];
    isRecording = true;
  }

  function stopRecording() {
    isRecording = false;
    if (recordingFrames.length === 0) return;
    const referencedDids = new Set<string>();
    for (const f of recordingFrames) {
      if ((f as any).kind === 'commit' && (f as any).commit && (f as any).did) {
        referencedDids.add((f as any).did);
      }
    }
    const filtered = recordingFrames.filter((f: any) => {
      if (f.kind === 'identity' || f.kind === 'account') {
        const did = f.kind === 'identity' ? f.identity?.did : f.account?.did;
        return did && referencedDids.has(did);
      }
      return true;
    });
    const recs = getRecordings();
    recs.push({
      id: Date.now().toString(36),
      name: `Session ${recs.length + 1} — ${new Date().toLocaleString()}`,
      nodeCount: recordNodes.length,
      edgeCount: edgeList.length,
      createdAt: new Date().toISOString(),
      events: filtered,
    });
    setRecordings(recs);
    recordingFrames = [];
    refreshSessions();
  }

  function toggleRecording() {
    if (isRecording) stopRecording(); else startRecording();
  }

  function replaySession(stored: StoredSession) {
    recordNodes.length = 0; nodeMap.clear(); edgeList.length = 0;
    pinnedUri = null; detailNode = null;
    for (const frame of stored.events) {
      const rec = parseJetstreamFrame(frame);
      if (!rec) continue;
      if (_mergeMarketEventIfSynthetic(rec)) continue;
      if (_ingestNode(rec)) _applyFixUps(rec);
    }
    restartSimulation();
  }

  function loadSession() {
    const idx = parseInt(selectedSessionIdx);
    const recs = getRecordings();
    if (!isNaN(idx) && recs[idx]) replaySession(recs[idx]);
  }

  function downloadSession() {
    const idx = parseInt(selectedSessionIdx);
    const recs = getRecordings();
    if (isNaN(idx) || !recs[idx]) return;
    downloadStoredSession(recs[idx]);
  }

  function importFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        const items = parseImportData(data);
        if (items.length === 0) throw new Error('No valid recording (missing events array).');
        const recs = getRecordings();
        recs.push(...items);
        setRecordings(recs);
        refreshSessions();
        status = `📂 imported ${items.length} recording(s)`;
        setTimeout(() => {
          if (status.startsWith('📂')) status = jetstreamClient.isOpen ? '● live' : '● disconnected';
        }, 3000);
      } catch (err: any) {
        alert(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
    (e.target as HTMLInputElement).value = '';
  }

  // ── jetstream ───────────────────────────────────────────────────────────────

  function togglePause() {
    paused = !paused;
    if (paused) {
      jetstreamClient.close();
      status = '⏸ paused'; statusClass = '';
    } else {
      jetstreamClient.connect();
    }
  }

  function clearGraph() {
    recordNodes.length = 0; nodeMap.clear(); edgeList.length = 0;
    pinnedUri = null; detailNode = null;
    restartSimulation();
  }

  function pinDetail(node: any) {
    if (pinnedUri === node.uri) { pinnedUri = null; }
    else { pinnedUri = node.uri; }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  onMount(() => {
    initGraph();
    refreshSessions();
    startRecording();
    jetstreamClient.connect();
    window.addEventListener('resize', resizeGraph);
  });

  onDestroy(() => {
    jetstreamClient.close();
    window.removeEventListener('resize', resizeGraph);
    simulation?.stop();
  });

  // ── derived detail YAML ──────────────────────────────────────────────────────

  let detailYaml = $derived.by(() => {
    if (!detailNode) return '';
    try { return toYaml(detailNode.record); } catch { return JSON.stringify(detailNode.record, null, 2); }
  });
</script>

<div class="live-graph">
  <!-- toolbar -->
  <div class="toolbar">
    <span class="status {statusClass}">{status}</span>
    <span class="counts">nodes: {nodeCount} · edges: {edgeCount}</span>
    <div class="controls">
      <button onclick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
      <button onclick={clearGraph}>Clear</button>
      <button class:recording={isRecording} onclick={toggleRecording}>
        {isRecording ? '⏹ Stop' : '⏺ Record'}
      </button>
    </div>
    <div class="session-row">
      <select bind:value={selectedSessionIdx}>
        <option value="">— saved sessions —</option>
        {#each sessions as s, i (i)}
          <option value={String(i)}>{s.name} ({s.nodeCount}n)</option>
        {/each}
      </select>
      <button disabled={!selectedSessionIdx} onclick={loadSession}>Load</button>
      <button disabled={!selectedSessionIdx} onclick={downloadSession}>⬇</button>
      <label class="file-btn">📂 Import<input type="file" accept=".json" onchange={importFile} /></label>
    </div>
  </div>

  <div class="body">
    <!-- left sidebar: filters + legend -->
    <aside class="sidebar">
      <div class="sidebar-section">
        <div class="sidebar-title">Filter</div>
        {#each WATCHED_NSIDS as nsid (nsid)}
          <label class="nsid-toggle" class:off={hiddenNsids.has(nsid)} title={nsid}>
            <input
              type="checkbox"
              checked={nsidToggles[nsid]}
              onchange={(e) => {
                nsidToggles[nsid] = (e.target as HTMLInputElement).checked;
                toggleNsid(nsid, (e.target as HTMLInputElement).checked);
              }}
            />
            <span class="swatch" style="background:{nsidColor(nsid)}"></span>
            {nsidLabel(nsid)}
          </label>
        {/each}
      </div>
    </aside>

    <!-- graph canvas -->
    <div class="graph-pane" bind:this={graphPane}>
      <svg bind:this={svgEl} width="100%" height="100%"></svg>
    </div>

    <!-- detail panel -->
    <aside class="detail-panel">
      {#if detailNode}
        <div class="detail-header">
          <div class="detail-title">{nsidLabel(detailNode.collection)} · {detailNode.rkey}</div>
          <div class="detail-uri">{detailNode.uri}</div>
          <div class="detail-meta">DID: {shortDid(detailNode.did, 32)} · {detailNode.createdAt}</div>
          <div class="detail-actions">
            <button onclick={() => window.open(pdslsUrl(detailNode.uri), '_blank')}>Open pdsls.dev</button>
            <button onclick={() => pinDetail(detailNode)}>
              {pinnedUri === detailNode.uri ? 'Unpin' : 'Pin'}
            </button>
          </div>
        </div>
        <pre class="detail-yaml">{detailYaml}</pre>
      {:else}
        <div class="detail-empty">Hover a node to inspect</div>
      {/if}
    </aside>
  </div>
</div>

<style>
  .live-graph {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 120px);
    background: #f4f6fb;
    color: #1c2333;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #dde3ec;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 1rem;
    background: #ffffff;
    border-bottom: 1px solid #dde3ec;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .status { font-size: 0.85rem; font-weight: 600; color: #64748b; }
  .status.connected { color: #16a34a; }
  .status.disconnected { color: #dc2626; }
  .counts { font-size: 0.8rem; color: #94a3b8; }

  .controls { display: flex; gap: 0.4rem; }
  .controls button, .session-row button {
    padding: 0.25rem 0.7rem;
    border-radius: 5px;
    border: 1px solid #dde3ec;
    background: #f8fafc;
    color: #475569;
    cursor: pointer;
    font-size: 0.8rem;
    transition: all 0.15s;
  }
  .controls button:hover, .session-row button:hover:not(:disabled) { border-color: #4a9eff; color: #4a9eff; background: #f0f7ff; }
  .controls button.recording { color: #dc2626; border-color: #fca5a5; background: #fef2f2; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  .session-row { display: flex; gap: 0.4rem; align-items: center; }
  .session-row select {
    padding: 0.2rem 0.5rem; border-radius: 5px;
    border: 1px solid #dde3ec; background: #f8fafc; color: #475569; font-size: 0.8rem;
  }

  .file-btn {
    padding: 0.25rem 0.7rem;
    border-radius: 5px; border: 1px solid #dde3ec;
    background: #f8fafc; color: #475569; cursor: pointer; font-size: 0.8rem;
    transition: all 0.15s;
  }
  .file-btn input { display: none; }
  .file-btn:hover { border-color: #4a9eff; color: #4a9eff; background: #f0f7ff; }

  .body {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .sidebar {
    width: 180px;
    flex-shrink: 0;
    overflow-y: auto;
    background: #ffffff;
    border-right: 1px solid #dde3ec;
    padding: 0.5rem;
  }
  .sidebar-title { font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
  .nsid-toggle {
    display: flex; align-items: center; gap: 0.4rem;
    font-size: 0.75rem; cursor: pointer; padding: 0.2rem 0;
    color: #475569;
  }
  .nsid-toggle.off { color: #cbd5e1; }
  .nsid-toggle input { display: none; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

  .graph-pane {
    flex: 1;
    background: #f0f4fa;
    overflow: hidden;
    position: relative;
  }

  .detail-panel {
    width: 280px;
    flex-shrink: 0;
    background: #ffffff;
    border-left: 1px solid #dde3ec;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .detail-empty {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: #cbd5e1; font-size: 0.85rem;
  }
  .detail-header { padding: 0.75rem; border-bottom: 1px solid #e8edf4; }
  .detail-title { font-size: 0.9rem; font-weight: 600; color: #1c2333; margin-bottom: 0.25rem; }
  .detail-uri { font-size: 0.7rem; color: #94a3b8; word-break: break-all; margin-bottom: 0.25rem; }
  .detail-meta { font-size: 0.7rem; color: #94a3b8; margin-bottom: 0.5rem; }
  .detail-actions { display: flex; gap: 0.4rem; }
  .detail-actions button {
    padding: 0.2rem 0.6rem; border-radius: 4px;
    border: 1px solid #dde3ec; background: #f8fafc; color: #475569; cursor: pointer; font-size: 0.75rem;
    transition: all 0.15s;
  }
  .detail-actions button:hover { border-color: #4a9eff; color: #4a9eff; }
  .detail-yaml {
    flex: 1; margin: 0; padding: 0.75rem;
    font-family: 'Courier New', monospace; font-size: 0.72rem;
    color: #3b6fd4; white-space: pre-wrap; word-break: break-word;
    background: #f8fafc;
  }

  :global(.live-graph .node-label) {
    font-size: 10px;
    fill: #334155;
    pointer-events: none;
    text-anchor: middle;
  }
  :global(.live-graph .edge-label) {
    font-size: 9px;
    fill: #94a3b8;
    pointer-events: none;
    text-anchor: middle;
  }
</style>
