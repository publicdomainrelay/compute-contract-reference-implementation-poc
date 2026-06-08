// Tangled Pipelines Viewer — DOM glue + routing.
//
// Read-only SPA: resolves an owner (handle or DID) + repo name to its
// `sh.tangled.repo` record (knot + spindle hostnames), links out to the
// official appview for browsing pipelines/workflows (that data has no public
// XRPC/CORS surface — see the header comment in tangled.js for why), and
// opens a websocket straight to the spindle's `/logs/{knot}/{rkey}/{name}`
// endpoint to tail live logs for a given pipeline + workflow.
//
// Reading is still anonymous — every record here is public, and the spindle
// log-streaming endpoint is unauthenticated (see core/spindle/server.go) — but
// *triggering* a pipeline run requires proving who you are. Signing in (via
// @atproto/oauth-client-browser) lets us call the trigger XRPC on the user's
// own PDS with an `atproto-proxy` header; the PDS mints a short-lived
// service-auth token and proxies the request to the repo's spindle (PDS service
// proxying, see TRIGGER_LXM / spindleProxyHeader in tangled.js).
//
// URLs are hash-routed (no server-side rewrite rules needed to serve
// index.html for arbitrary paths, which static hosts for SPAs don't always
// provide):
//
//   #/<owner>/<repo>                       repo overview + pipeline browser link
//   #/<owner>/<repo>/<pipeline>/<workflow> deep link straight to live logs
//
// e.g. #/johnandersen777.bsky.social/compute-contract-reference-implementation-poc
//
// All the DOM-free logic (XRPC calls, identity resolution, route parsing,
// URL building, …) lives in ./tangled.js so it can be unit-tested with
// `deno test` without a browser — see tangled_test.js.

import { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";
import { XrpcClient } from "@atproto/xrpc";

import {
	REPO_NSID,
	resolveOwner, listAllRecords, findRepoRecord,
	appviewPipelinesUrl, appviewWorkflowUrl, spindleLogsUrl,
	spindleEventsUrl, parsePipelineStatusEnvelope, upsertPipelineRun, pipelineStorageKey,
	parseRoute, buildRoute,
	TRIGGER_LXM, TRIGGER_LEXICON, spindleProxyHeader, buildTriggerPayload, resolveLatestSha,
} from "./tangled.js";

let activeSocket; // undefined | WebSocket — the currently open log stream
let activeEventsSocket; // undefined | WebSocket — the currently open /events jetstream
let pipelineRuns = []; // accumulated, most-recent-first; persisted to localStorage per repo
let suppressNextHashChange = false; // set when we update the hash ourselves

// currentView holds everything we need to re-render or drill further down.
let currentView = {}; // { owner: { identifier, did, pds }, repoName, repoRecord }

/* ----------------------------------------------------------------------- */
/* Sign-in (OAuth) — needed so the PDS can proxy the trigger XRPC for us     */
/* ----------------------------------------------------------------------- */

let oauthClient; // undefined | BrowserOAuthClient
let session; // undefined | OAuthSession — set once signed in
let agent; // undefined | Agent — wraps `session`, used for agent.did
// triggerClient — an XrpcClient bound to the user's OAuth session (their PDS)
// and taught the TRIGGER_LEXICON, so triggerPipeline can issue the trigger call
// with an `atproto-proxy` header and have the PDS proxy it to the spindle.
let triggerClient; // undefined | XrpcClient

// buildClientId mirrors the loopback-client special case from the OAuth spec
// (atproto.com/specs/oauth#localhost-client-development) for local dev, and
// otherwise points at the static oauth-client-metadata.json served alongside
// this SPA — whose `client_id`/`redirect_uris` must be kept in sync with
// wherever this SPA is actually deployed.
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
		// Never resolves — the browser navigates away to the user's PDS.
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
		// The OAuthSession is a FetchHandlerObject: requests it handles go to the
		// user's PDS with OAuth/DPoP auth applied, so this XrpcClient's calls are
		// authenticated PDS calls that the PDS will proxy onward (per the
		// atproto-proxy header we set on each trigger).
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

/* ----------------------------------------------------------------------- */
/* Manual trigger — calls the trigger XRPC via PDS service proxying          */
/* ----------------------------------------------------------------------- */

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

// triggerPipeline calls the trigger procedure on the user's OWN PDS with an
// `atproto-proxy: did:web:<spindle>#tangled_spindle` header. The PDS mints and
// signs the inter-service auth token (lxm=TRIGGER_LXM) with the user's repo key
// and proxies the request to the spindle, which verifies the token against the
// issuer's DID document and requires iss === actor. The browser never mints or
// sees a token, and never talks to the spindle directly.
// See atproto.com/specs/xrpc#service-proxying.
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

/* ----------------------------------------------------------------------- */
/* DOM helpers                                                              */
/* ----------------------------------------------------------------------- */

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

/* ----------------------------------------------------------------------- */
/* localStorage persistence — pipeline runs survive a reload                */
/* ----------------------------------------------------------------------- */

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
	} catch { /* storage unavailable/full — live view still works */ }
}

/* ----------------------------------------------------------------------- */
/* Routing                                                                  */
/* ----------------------------------------------------------------------- */

// navigateToRepo / navigateToLogs update the address bar (without
// retriggering a redundant load) and drive the corresponding view.
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

// followRoute drives the app from a parsed route, loading the repo first and
// — for the four-segment "deep link to logs" shape — opening the log stream
// once the repo (and therefore its spindle hostname) is known.
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

/* ----------------------------------------------------------------------- */
/* Step 1: resolve + render the repo                                        */
/* ----------------------------------------------------------------------- */

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

/* ----------------------------------------------------------------------- */
/* Step 2: pipelines/logs panel — link out to the appview, jump to logs     */
/* ----------------------------------------------------------------------- */

function renderPipelinesPanel() {
	const { owner, repoName } = currentView;

	document.getElementById("appview-pipelines-link").href = appviewPipelinesUrl(owner.identifier, repoName);
	document.getElementById("pipeline-input").value = "";
	document.getElementById("workflow-input").value = "";

	show("pipelines-container");
}

/* ----------------------------------------------------------------------- */
/* Step 2.5: subscribe to the spindle's /events jetstream of pipeline runs  */
/* ----------------------------------------------------------------------- */

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
	if (!run) return; // not a pipeline-status record (e.g. the {"type":"ping"} keepalive)

	appendEventLine(`${run.pipelineRkey} / ${run.workflow} → ${run.status}`, "log-line-data");

	pipelineRuns = upsertPipelineRun(pipelineRuns, run);
	renderPipelinesList();

	const { owner, repoName } = currentView;
	if (owner && repoName) savePersistedPipelineRuns(owner.identifier, repoName, pipelineRuns);
}

// startEventsStream subscribes to the repo's spindle /events websocket — a
// fan-out of `sh.tangled.pipeline.status` updates — as soon as the repo (and
// therefore its spindle hostname) is known. Past runs are loaded from
// localStorage first so a reload doesn't lose the browsable pipeline list.
function startEventsStream() {
	const { repoRecord, owner, repoName } = currentView;
	if (!repoRecord) return;

	const spindle = repoRecord.value.spindle;
	closeEventsSocket();
	if (!spindle) return; // no spindle configured — nothing to subscribe to

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

/* ----------------------------------------------------------------------- */
/* Step 3: live logs from the spindle, over its public /logs websocket      */
/* ----------------------------------------------------------------------- */

function appendLogLine(raw) {
	const output = document.getElementById("log-output");
	const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 16;

	const line = document.createElement("span");

	let parsed;
	try { parsed = JSON.parse(raw); } catch { /* not JSON — render verbatim */ }

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

/* ----------------------------------------------------------------------- */
/* Init                                                                     */
/* ----------------------------------------------------------------------- */

function init() {
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

	// Deep link on first load (state restoration from initOAuth may also set
	// the hash and suppress the resulting hashchange — see suppressNextHashChange).
	initOAuth()
		.catch((err) => console.error("OAuth init failed:", err))
		.finally(() => followRoute(parseRoute(window.location.hash)));
}

document.addEventListener("DOMContentLoaded", init);
