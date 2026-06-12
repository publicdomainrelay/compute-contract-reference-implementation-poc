// Tangled Pipelines Viewer + Market Graph Viewer — merged SPA.
//
// Two tabs:
//   "Tangled Pipelines" — resolve repos, stream live spindle logs, trigger runs.
//   "Market Graph"      — live D3 force-directed graph of market record flow via Jetstream.
//
// All DOM-free logic for pipelines lives in ./tangled.js.
// All DOM-free logic for the graph lives in ./graph.js.

import { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";
import { XrpcClient } from "@atproto/xrpc";
import * as d3 from "d3";

import {
	REPO_NSID,
	resolveOwner, listAllRecords, findRepoRecord,
	appviewPipelinesUrl, appviewWorkflowUrl, spindleLogsUrl,
	spindleEventsUrl, parsePipelineStatusEnvelope, upsertPipelineRun, pipelineStorageKey,
	parseRoute, buildRoute,
	TRIGGER_LXM, TRIGGER_LEXICON, spindleProxyHeader, buildTriggerPayload, resolveLatestSha,
} from "./tangled.js";

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

/* =========================================================================
   TAB SWITCHING
   ========================================================================= */

let graphInitialized = false;

function switchTab(name) {
	const isPipelines = name === "pipelines";
	document.getElementById("tab-pipelines").style.display = isPipelines ? "" : "none";
	document.getElementById("tab-graph").style.display = isPipelines ? "none" : "flex";
	document.getElementById("tab-btn-pipelines").classList.toggle("active", isPipelines);
	document.getElementById("tab-btn-graph").classList.toggle("active", !isPipelines);

	if (!isPipelines && !graphInitialized) {
		graphInitialized = true;
		initGraph();
		buildLegend();
		buildNsidToggles();
		buildSessionDropdown();
		startRecording();
		connectJetstream();
	}
	if (!isPipelines) {
		resizeGraph();
	}
}

/* =========================================================================
   PIPELINES TAB
   ========================================================================= */

let activeSocket;
let activeEventsSocket;
let pipelineRuns = [];
let suppressNextHashChange = false;
let currentView = {};

/* --- OAuth --- */

let oauthClient;
let session;
let agent;
let triggerClient;

function buildClientId() {
	const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
	if (isLocal) {
		return `http://localhost?${new URLSearchParams({
			scope: "atproto",
			redirect_uri: Object.assign(new URL(window.location.origin), { hostname: "127.0.0.1" }).href,
		})}`;
	}
	return `${window.location.origin}/oauth-client-metadata.json`;
}

function renderSession() {
	if (session && agent) {
		hide("login-nav", "login-container");
		show("logout-nav", "inline");
		document.getElementById("session-handle").textContent = agent.assertDid ? agent.did : session.did;
	} else {
		hide("logout-nav");
		show("login-nav", "inline");
	}
	updateTriggerVisibility();
}

async function doSignIn(handle) {
	const errorEl = document.getElementById("login-error");
	const button = document.getElementById("login-button");
	errorEl.textContent = "";
	button.setAttribute("aria-busy", "true");
	try {
		await oauthClient.signIn(handle, { state: window.location.hash });
	} catch (err) {
		errorEl.textContent = `Sign-in failed: ${err.message || err}`;
		button.removeAttribute("aria-busy");
	}
}

async function doSignOut() {
	if (session) await oauthClient.revoke(session.did).catch(() => {});
	window.location.reload();
}

async function initOAuth() {
	oauthClient = await BrowserOAuthClient.load({
		clientId: buildClientId(),
		handleResolver: "https://bsky.social",
	});

	const result = await oauthClient.init();
	if (result) {
		session = result.session;
		agent = new Agent(session);
		triggerClient = new XrpcClient(session, [TRIGGER_LEXICON]);
		if (typeof result.state === "string" && result.state.startsWith("#")) {
			suppressNextHashChange = true;
			window.location.hash = result.state;
		}
	}

	oauthClient.addEventListener("deleted", () => {
		session = undefined;
		agent = undefined;
		triggerClient = undefined;
		renderSession();
	});

	renderSession();
}

/* --- Trigger --- */

function updateTriggerVisibility() {
	const { repoRecord } = currentView;
	const canTrigger = !!(triggerClient && agent && repoRecord?.value?.spindle && repoRecord?.value?.knot);
	if (canTrigger) {
		document.getElementById("trigger-default-branch").textContent = repoRecord.value.defaultBranch || "the default branch";
		show("trigger-container");
	} else {
		hide("trigger-container");
	}
}

async function triggerPipeline() {
	const statusEl = document.getElementById("trigger-status");
	const button = document.getElementById("trigger-button");
	statusEl.textContent = "";
	button.setAttribute("aria-busy", "true");

	try {
		const { repoRecord } = currentView;
		const { knot, spindle, repoDid, defaultBranch } = repoRecord.value;
		const repoName = currentView.repoName;

		statusEl.textContent = `Resolving latest commit on ${defaultBranch}…`;
		const ref = await resolveLatestSha(knot, repoDid, defaultBranch);

		const payload = buildTriggerPayload({ knot, repoDid, repoName, ref, actorDid: agent.did });

		statusEl.textContent = `Submitting trigger to ${spindle} via your PDS…`;
		const res = await triggerClient.call(TRIGGER_LXM, {}, payload, {
			headers: { "atproto-proxy": spindleProxyHeader(spindle) },
		});
		const body = res.data ?? {};

		const workflows = (body.workflows || []).map((w) => w.workflow).join(", ") || "no workflows";
		statusEl.textContent = `Triggered ${payload.pipelineRkey} (${ref.slice(0, 12)}) — submitted: ${workflows}`;
	} catch (err) {
		statusEl.textContent = `Trigger failed: ${err.message || err}`;
	} finally {
		button.removeAttribute("aria-busy");
	}
}

/* --- DOM helpers --- */

function hide(...ids) {
	for (const id of ids) document.getElementById(id).style.display = "none";
}
function show(id, display = "inherit") {
	document.getElementById(id).style.display = display;
}

function closeLogSocket() {
	if (activeSocket) {
		activeSocket.close();
		activeSocket = undefined;
	}
	hide("logs-container");
}

function closeEventsSocket() {
	if (activeEventsSocket) {
		activeEventsSocket.close();
		activeEventsSocket = undefined;
	}
	hide("events-container");
	document.getElementById("events-output").innerHTML = "";
	document.getElementById("events-status").textContent = "";
}

/* --- localStorage --- */

function loadPersistedPipelineRuns(owner, repoName) {
	try {
		const raw = localStorage.getItem(pipelineStorageKey(owner, repoName));
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function savePersistedPipelineRuns(owner, repoName, runs) {
	try {
		localStorage.setItem(pipelineStorageKey(owner, repoName), JSON.stringify(runs));
	} catch { /* storage unavailable/full */ }
}

/* --- Routing --- */

function navigateToRepo(owner, repo) {
	setHash(buildRoute(owner, repo));
	document.getElementById("owner-input").value = owner;
	document.getElementById("repo-input").value = repo;
	loadRepo(owner, repo);
}

function navigateToLogs(owner, repo, pipeline, workflow) {
	setHash(buildRoute(owner, repo, pipeline, workflow));
	document.getElementById("pipeline-input").value = pipeline;
	document.getElementById("workflow-input").value = workflow;
	openLogStream(pipeline, workflow);
}

function setHash(hash) {
	if (window.location.hash !== hash) {
		suppressNextHashChange = true;
		window.location.hash = hash;
	}
}

async function handleHashChange() {
	if (suppressNextHashChange) {
		suppressNextHashChange = false;
		return;
	}
	await followRoute(parseRoute(window.location.hash));
}

async function followRoute(route) {
	if (!route) return;

	document.getElementById("owner-input").value = route.owner;
	document.getElementById("repo-input").value = route.repo;
	await loadRepo(route.owner, route.repo);

	if (route.pipeline && route.workflow && currentView.repoRecord) {
		document.getElementById("pipeline-input").value = route.pipeline;
		document.getElementById("workflow-input").value = route.workflow;
		openLogStream(route.pipeline, route.workflow);
	}
}

/* --- Repo load --- */

async function loadRepo(ownerIdentifier, repoName) {
	const errorEl = document.getElementById("lookup-error");
	const lookupButton = document.getElementById("lookup-button");
	errorEl.textContent = "";
	lookupButton.setAttribute("aria-busy", "true");

	closeLogSocket();
	closeEventsSocket();
	hide("repo-container", "pipelines-container", "events-container");

	try {
		const owner = await resolveOwner(ownerIdentifier);

		const repoRecords = await listAllRecords(owner.pds, owner.did, REPO_NSID);
		const repoRecord = findRepoRecord(repoRecords, repoName);

		if (!repoRecord) {
			throw new Error(`no "${REPO_NSID}" record named "${repoName}" found for ${owner.did}`);
		}

		currentView = {
			owner: { identifier: ownerIdentifier, ...owner },
			repoName,
			repoRecord,
		};

		renderRepo();
		renderPipelinesPanel();
		updateTriggerVisibility();
		startEventsStream();
		setBreadcrumb();
	} catch (err) {
		currentView = {};
		updateTriggerVisibility();
		errorEl.textContent = `${err.message || err}`;
	} finally {
		lookupButton.removeAttribute("aria-busy");
	}
}

function setBreadcrumb() {
	const nav = document.getElementById("breadcrumbs");
	const list = document.getElementById("breadcrumb-list");
	list.innerHTML = "";

	const li = document.createElement("li");
	li.textContent = `${currentView.owner.identifier} / ${currentView.repoName}`;
	list.appendChild(li);

	nav.style.display = "inherit";
}

function renderRepo() {
	const { repoRecord, owner, repoName } = currentView;
	const value = repoRecord.value;

	document.getElementById("repo-title").textContent = value.name || repoName;
	document.getElementById("repo-description").textContent = value.description || "";

	const meta = document.getElementById("repo-meta");
	meta.innerHTML = "";
	const addMeta = (label, content) => {
		if (!content) return;
		const li = document.createElement("li");
		const strong = document.createElement("strong");
		strong.textContent = `${label}: `;
		li.appendChild(strong);
		if (content instanceof Node) {
			li.appendChild(content);
		} else {
			li.appendChild(document.createTextNode(content));
		}
		meta.appendChild(li);
	};

	const code = (text) => { const c = document.createElement("code"); c.textContent = text; return c; };
	const link = (href, text) => {
		const a = document.createElement("a");
		a.target = "_blank";
		a.href = href;
		a.textContent = text;
		return a;
	};

	addMeta("Owner", code(owner.identifier));
	addMeta("Knot", code(value.knot));
	addMeta("Spindle (CI runner)", value.spindle ? code(value.spindle) : "none configured — this repo cannot run pipelines");
	addMeta("Default branch", code(value.defaultBranch));
	addMeta("Repo DID", code(value.repoDid));
	addMeta("Record", link(`https://pdsls.dev/${repoRecord.uri}`, repoRecord.uri));

	show("repo-container");
}

function renderPipelinesPanel() {
	const { owner, repoName } = currentView;

	document.getElementById("appview-pipelines-link").href = appviewPipelinesUrl(owner.identifier, repoName);
	document.getElementById("pipeline-input").value = "";
	document.getElementById("workflow-input").value = "";

	show("pipelines-container");
}

/* --- Events stream --- */

function appendEventLine(text, className = "log-line-control") {
	const output = document.getElementById("events-output");
	const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 16;

	const line = document.createElement("span");
	line.className = className;
	line.textContent = text;
	output.appendChild(line);

	if (atBottom) output.scrollTop = output.scrollHeight;
}

function renderPipelinesList() {
	const { owner, repoName } = currentView;
	const list = document.getElementById("pipelines-list");
	const empty = document.getElementById("pipelines-list-empty");
	list.innerHTML = "";

	if (pipelineRuns.length === 0) {
		empty.style.display = "inherit";
		return;
	}
	empty.style.display = "none";

	for (const run of pipelineRuns) {
		const li = document.createElement("li");
		li.className = "list-item";
		const when = run.createdAt ? new Date(run.createdAt).toLocaleString() : "";
		li.textContent = `${run.pipelineRkey} / ${run.workflow} — ${run.status || "unknown"}${when ? ` (${when})` : ""}`;
		li.onclick = () => navigateToLogs(owner.identifier, repoName, run.pipelineRkey, run.workflow);
		list.appendChild(li);
	}
}

function handlePipelineStatusEnvelope(raw) {
	let envelope;
	try { envelope = JSON.parse(raw); } catch { return; }

	const run = parsePipelineStatusEnvelope(envelope);
	if (!run) return;

	appendEventLine(`${run.pipelineRkey} / ${run.workflow} → ${run.status}`, "log-line-data");

	pipelineRuns = upsertPipelineRun(pipelineRuns, run);
	renderPipelinesList();

	const { owner, repoName } = currentView;
	if (owner && repoName) savePersistedPipelineRuns(owner.identifier, repoName, pipelineRuns);
}

function startEventsStream() {
	const { repoRecord, owner, repoName } = currentView;
	if (!repoRecord) return;

	const spindle = repoRecord.value.spindle;
	closeEventsSocket();
	if (!spindle) return;

	pipelineRuns = loadPersistedPipelineRuns(owner.identifier, repoName);
	renderPipelinesList();
	show("events-container");

	const url = spindleEventsUrl(spindle);
	const statusEl = document.getElementById("events-status");

	let socket;
	try {
		socket = new WebSocket(url);
	} catch (err) {
		statusEl.textContent = `Failed to subscribe to pipeline events: ${err.message || err}`;
		return;
	}
	activeEventsSocket = socket;

	socket.onopen = () => {
		statusEl.textContent = `Subscribed to ${url}`;
		appendEventLine(`connected to ${url}`);
	};
	socket.onmessage = (event) => handlePipelineStatusEnvelope(event.data);
	socket.onerror = () => {
		statusEl.textContent = "Pipeline event stream error";
	};
	socket.onclose = (event) => {
		appendEventLine(`pipeline event stream closed (${event.code})`);
		if (activeEventsSocket === socket) activeEventsSocket = undefined;
	};
}

/* --- Log stream --- */

function appendLogLine(raw) {
	const output = document.getElementById("log-output");
	const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 16;

	const line = document.createElement("span");

	let parsed;
	try { parsed = JSON.parse(raw); } catch { /* not JSON */ }

	if (parsed && typeof parsed === "object" && "kind" in parsed) {
		if (parsed.kind === "control") {
			line.className = "log-line-control";
			line.textContent = `--- ${parsed.content} ${parsed.step_status || ""} ---`;
		} else {
			line.className = `log-line-data${parsed.stream === "stderr" ? " log-line-stderr" : ""}`;
			line.textContent = parsed.content;
		}
	} else {
		line.className = "log-line-data";
		line.textContent = raw;
	}

	output.appendChild(line);

	if (atBottom) output.scrollTop = output.scrollHeight;
}

function openLogStream(pipelineRkey, workflowName) {
	const { repoRecord, owner, repoName } = currentView;
	const errorEl = document.getElementById("lookup-error");
	errorEl.textContent = "";

	if (!repoRecord) {
		errorEl.textContent = "Look up a repo first.";
		return;
	}

	const spindle = repoRecord.value.spindle;
	const knot = repoRecord.value.knot;

	closeLogSocket();

	if (!spindle) {
		errorEl.textContent = "This repo has no spindle (CI runner) configured — there are no logs to stream.";
		return;
	}

	document.getElementById("logs-workflow-name").textContent = `${pipelineRkey} / ${workflowName}`;
	document.getElementById("appview-workflow-link").href =
		appviewWorkflowUrl(owner.identifier, repoName, pipelineRkey, workflowName);

	const output = document.getElementById("log-output");
	output.innerHTML = "";
	show("logs-container");
	document.getElementById("logs-container").scrollIntoView({ behavior: "smooth", block: "start" });

	const url = spindleLogsUrl(spindle, knot, pipelineRkey, workflowName);

	let socket;
	try {
		socket = new WebSocket(url);
	} catch (err) {
		errorEl.textContent = `Failed to open log stream: ${err.message || err}`;
		return;
	}
	activeSocket = socket;

	socket.onopen = () => {
		appendLogLine(JSON.stringify({ kind: "control", content: `connected to ${url}`, step_id: 0 }));
	};
	socket.onmessage = (event) => appendLogLine(event.data);
	socket.onerror = () => {
		appendLogLine(JSON.stringify({ kind: "control", content: "log stream error", step_id: 0 }));
	};
	socket.onclose = (event) => {
		appendLogLine(JSON.stringify({ kind: "control", content: `log stream closed (${event.code})`, step_id: 0 }));
		if (activeSocket === socket) activeSocket = undefined;
	};
}

/* =========================================================================
   GRAPH TAB
   ========================================================================= */

const JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe";
const GRAPH_STORAGE_KEY = "market-graph-recordings";

let jetstreamSocket;
let graphPaused = false;
const recordNodes = [];
const nodeMap = new Map();
const edgeList = [];
const hiddenNsids = new Set();

let recordingFrames = [];
let isRecording = false;

const graphStatusEl = () => document.getElementById("graph-status");
const nodeCountEl = () => document.getElementById("node-count");
const edgeCountEl = () => document.getElementById("edge-count");

let simulation;
let svg, gZoom, linkG, nodeG, labelG;
let nodeSel, linkSel, labelSel, edgeLabelSel;
let zoomBehavior;
let pendingCenterNode = null;

let pinnedUri = null;

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

function buildNsidToggles() {
	const nsidFiltersEl = document.getElementById("nsid-filters");
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

function showDetail(node) {
	document.getElementById("detail-empty").style.display = "none";
	document.getElementById("detail-header").style.display = "";
	document.getElementById("detail-yaml").style.display = "";
	document.getElementById("detail-actions").style.display = "flex";

	document.getElementById("detail-title").textContent = `${nsidLabel(node.collection)} · ${node.rkey}`;
	document.getElementById("detail-uri").textContent = node.uri;
	document.getElementById("detail-meta").textContent = `DID: ${shortDid(node.did, 32)} · ${node.createdAt}`;

	let yaml;
	try {
		yaml = toYaml(node.record);
	} catch {
		yaml = JSON.stringify(node.record, null, 2);
	}
	document.getElementById("detail-yaml").textContent = yaml;

	document.getElementById("detail-pdsls-link").onclick = () => {
		window.open(pdslsUrl(node.uri), "_blank");
	};

	const pinBtn = document.getElementById("detail-pin-button");
	pinBtn.textContent = pinnedUri === node.uri ? "Unpin node" : "Pin node";
	pinBtn.onclick = () => {
		if (pinnedUri === node.uri) {
			pinnedUri = null;
			pinBtn.textContent = "Pin node";
		} else {
			pinnedUri = node.uri;
			pinBtn.textContent = "Unpin node";
		}
	};
}

function hideDetail() {
	if (pinnedUri && nodeMap.has(pinnedUri)) {
		showDetail(recordNodes[nodeMap.get(pinnedUri)]);
		return;
	}
	pinnedUri = null;
	document.getElementById("detail-empty").style.display = "";
	document.getElementById("detail-header").style.display = "none";
	document.getElementById("detail-yaml").style.display = "none";
	document.getElementById("detail-actions").style.display = "none";
}

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

	zoomBehavior = d3.zoom()
		.scaleExtent([0.1, 8])
		.on("zoom", (event) => gZoom.attr("transform", event.transform));
	svg.call(zoomBehavior);

	linkG = gZoom.append("g").attr("class", "links");
	nodeG = gZoom.append("g").attr("class", "nodes");
	labelG = gZoom.append("g").attr("class", "labels");

	simulation = d3.forceSimulation()
		.force("link", d3.forceLink().id(d => d.uri).distance(150).iterations(2))
		.force("charge", d3.forceManyBody().strength(-800).distanceMin(30).distanceMax(600))
		.force("collide", d3.forceCollide(45).strength(0.8).iterations(3))
		.force("center", d3.forceCenter(0, 0).strength(0.1))
		.alphaDecay(0.02)
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
	if (!svg) return;
	const pane = document.getElementById("graph-pane");
	if (!pane) return;
	svg.attr("viewBox", [-pane.clientWidth / 2, -pane.clientHeight / 2, pane.clientWidth, pane.clientHeight]);
}

window.addEventListener("resize", resizeGraph);

function restartSimulation() {
	pendingCenterNode = null;
	const nodes = visibleNodes();
	const edges = visibleEdges();

	nodeCountEl().textContent = nodes.length;
	edgeCountEl().textContent = edges.length;

	linkSel = linkG.selectAll("line").data(edges, d => `${d.from}→${d.to}@${d.label}`);
	linkSel.exit().remove();
	const linkEnter = linkSel.enter().append("line")
		.attr("stroke", "#999")
		.attr("stroke-width", 1.5)
		.attr("stroke-opacity", 0.6);
	linkSel = linkEnter.merge(linkSel);

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

	labelSel = labelG.selectAll("text.node-label").data(nodes, d => d.uri);
	labelSel.exit().remove();
	const labelEnter = labelSel.enter().append("text")
		.attr("class", "node-label")
		.text(d => nsidLabel(d.collection));
	labelSel = labelEnter.merge(labelSel);

	edgeLabelSel = labelG.selectAll("text.edge-label").data(edges, d => `${d.from}→${d.to}@${d.label}`);
	edgeLabelSel.exit().remove();
	const edgeLabelEnter = edgeLabelSel.enter().append("text")
		.attr("class", "edge-label")
		.text(d => d.label.slice(d.label.indexOf(':') + 1));
	edgeLabelSel = edgeLabelEnter.merge(edgeLabelSel);

	const degree = new Map(nodes.map(n => [n.uri, 0]));
	for (const e of edges) {
		if (degree.has(e.from)) degree.set(e.from, degree.get(e.from) + 1);
		if (degree.has(e.to))   degree.set(e.to,   degree.get(e.to)   + 1);
	}
	const radialR = Math.max(200, Math.sqrt(nodes.length) * 70);
	simulation.force("radial", d3.forceRadial(radialR, 0, 0).strength(d => {
		return (degree.get(d.uri) || 0) <= 1 ? 1.0 : 0;
	}));

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
		nodeSel.attr("cx", d => d.x).attr("cy", d => d.y);
	}
	if (labelSel) {
		labelSel.attr("x", d => d.x).attr("y", d => d.y + 16);
	}
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

function _pushEdge(e) {
	if (!edgeList.some((x) => x.from === e.from && x.to === e.to && x.label === e.label)) {
		edgeList.push(e);
	}
}

function _applyFixUps(node) {
	const uriToNode = new Map(recordNodes.map((n) => [n.uri, n]));
	const { nodes: synthNodes, edges: fixEdges } = fixUps(node, uriToNode);
	for (const synth of synthNodes) {
		if (_ingestNode(synth)) _applyFixUps(synth);
	}
	for (const e of fixEdges) _pushEdge(e);
}

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
	restartSimulation();
	pendingCenterNode = node;
}

function centerOnNode(node) {
	const currentTransform = d3.zoomTransform(svg.node());
	const k = currentTransform.k;
	const tx = -node.x * k;
	const ty = -node.y * k;
	svg.transition().duration(600).call(
		zoomBehavior.transform,
		d3.zoomIdentity.translate(tx, ty).scale(k),
	);
}

/* --- Recording --- */

function getRecordings() {
	try {
		return JSON.parse(localStorage.getItem(GRAPH_STORAGE_KEY) || "[]");
	} catch {
		return [];
	}
}

function setRecordings(arr) {
	localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(arr));
}

function buildSessionDropdown() {
	const sessionSelect = document.getElementById("session-select");
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
	const sessionSelect = document.getElementById("session-select");
	const hasSelection = sessionSelect.value !== "";
	document.getElementById("session-load-button").disabled = !hasSelection;
	document.getElementById("session-download-button").disabled = !hasSelection;
}

function updateRecUI() {
	const recButton = document.getElementById("rec-button");
	const recIndicator = document.getElementById("rec-indicator");
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

	const referencedDids = new Set();
	for (const frame of recordingFrames) {
		if (frame.kind === "commit" && frame.commit && frame.did) {
			referencedDids.add(frame.did);
		}
	}

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

function importRecording(file) {
	const reader = new FileReader();
	reader.onload = () => {
		try {
			const data = JSON.parse(reader.result);
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
			const gs = graphStatusEl();
			gs.textContent = `📂 imported ${added} recording(s)`;
			setTimeout(() => {
				if (gs.textContent.startsWith("📂")) {
					gs.textContent = jetstreamSocket && jetstreamSocket.readyState === WebSocket.OPEN ? "● live" : "● disconnected";
				}
			}, 3000);
		} catch (err) {
			alert(`Failed to import recording: ${err.message}`);
		}
	};
	reader.readAsText(file);
}

/* --- Jetstream --- */

function connectJetstream() {
	const url = new URL(JETSTREAM_URL);
	for (const nsid of WATCHED_NSIDS) {
		url.searchParams.append("wantedCollections", nsid);
	}

	const gs = graphStatusEl();
	gs.textContent = "● connecting…";
	gs.className = "";

	let socket;
	try {
		socket = new WebSocket(url.toString());
	} catch (err) {
		gs.textContent = `● connection failed: ${err.message || err}`;
		gs.className = "disconnected";
		setTimeout(connectJetstream, 5000);
		return;
	}
	jetstreamSocket = socket;

	socket.onopen = () => {
		gs.textContent = "● live";
		gs.className = "connected";
	};

	socket.onmessage = (event) => {
		if (graphPaused) return;
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		if (isRecording) recordingFrames.push(frame);
		const rec = parseJetstreamFrame(frame);
		if (rec) addRecord(rec);
	};

	socket.onerror = () => {
		gs.textContent = "● stream error";
		gs.className = "disconnected";
	};

	socket.onclose = (event) => {
		jetstreamSocket = undefined;
		gs.textContent = `● disconnected (code ${event.code})`;
		gs.className = "disconnected";
		if (!graphPaused) {
			setTimeout(connectJetstream, 3000);
		}
	};
}

/* =========================================================================
   INIT
   ========================================================================= */

function init() {
	/* tab buttons */
	document.getElementById("tab-btn-pipelines").addEventListener("click", () => switchTab("pipelines"));
	document.getElementById("tab-btn-graph").addEventListener("click", () => switchTab("graph"));

	/* pipelines forms */
	document.getElementById("lookup-form").onsubmit = (e) => {
		e.preventDefault();
		const owner = document.getElementById("owner-input").value.trim();
		const repo = document.getElementById("repo-input").value.trim();
		if (owner && repo) navigateToRepo(owner, repo);
	};

	document.getElementById("logs-lookup-form").onsubmit = (e) => {
		e.preventDefault();
		const { owner, repoName, repoRecord } = currentView;
		if (!repoRecord) return;
		const pipeline = document.getElementById("pipeline-input").value.trim();
		const workflow = document.getElementById("workflow-input").value.trim();
		if (pipeline && workflow) navigateToLogs(owner.identifier, repoName, pipeline, workflow);
	};

	document.getElementById("logs-disconnect-button").onclick = () => closeLogSocket();

	document.getElementById("login-link").onclick = (e) => {
		e.preventDefault();
		show("login-container");
	};
	document.getElementById("login-form").onsubmit = (e) => {
		e.preventDefault();
		const handle = document.getElementById("login-handle-input").value.trim();
		if (handle) doSignIn(handle);
	};
	document.getElementById("logout-link").onclick = (e) => {
		e.preventDefault();
		doSignOut();
	};
	document.getElementById("trigger-button").onclick = () => triggerPipeline();

	window.addEventListener("hashchange", handleHashChange);

	/* graph controls (wired up now but graph init deferred until tab switch) */
	document.getElementById("pause-button").addEventListener("click", () => {
		graphPaused = !graphPaused;
		document.getElementById("pause-button").textContent = graphPaused ? "Resume" : "Pause";
		if (graphPaused) {
			if (jetstreamSocket) {
				jetstreamSocket.close();
				jetstreamSocket = undefined;
			}
			const gs = graphStatusEl();
			gs.textContent = "⏸ paused";
			gs.className = "";
		} else {
			connectJetstream();
		}
	});

	document.getElementById("graph-clear-button").addEventListener("click", () => {
		recordNodes.length = 0;
		nodeMap.clear();
		edgeList.length = 0;
		pinnedUri = null;
		hideDetail();
		restartSimulation();
	});

	document.getElementById("rec-button").addEventListener("click", () => {
		if (isRecording) stopRecording(); else startRecording();
	});

	document.getElementById("session-select").addEventListener("change", updateSessionButtons);

	document.getElementById("session-load-button").addEventListener("click", () => {
		const recordings = getRecordings();
		const idx = parseInt(document.getElementById("session-select").value);
		if (isNaN(idx) || !recordings[idx]) return;
		replaySession(recordings[idx]);
	});

	document.getElementById("session-download-button").addEventListener("click", () => {
		const recordings = getRecordings();
		const idx = parseInt(document.getElementById("session-select").value);
		if (isNaN(idx) || !recordings[idx]) return;
		downloadRecording(recordings[idx]);
	});

	document.getElementById("session-import-button").addEventListener("click", () => {
		document.getElementById("import-file-input").click();
	});

	document.getElementById("import-file-input").addEventListener("change", () => {
		const file = document.getElementById("import-file-input").files[0];
		if (file) importRecording(file);
		document.getElementById("import-file-input").value = "";
	});

	/* pipelines OAuth + deep-link routing */
	initOAuth()
		.catch((err) => console.error("OAuth init failed:", err))
		.finally(() => followRoute(parseRoute(window.location.hash)));
}

document.addEventListener("DOMContentLoaded", init);
