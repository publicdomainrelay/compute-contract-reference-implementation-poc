// Pure, DOM-free logic for the Tangled Pipelines Viewer.
//
// Kept separate from main.js so it can be exercised directly with `deno test`
// (no browser/DOM shims needed) — see tangled_test.js.
//
// IMPORTANT shape of the public surface this SPA relies on:
//
//   * `sh.tangled.repo` records are real atproto records, readable from the
//     owner's PDS via the standard `com.atproto.repo.listRecords` XRPC query.
//     This is how we learn a repo's `knot` and `spindle` hostnames.
//
//   * `sh.tangled.pipeline` / `sh.tangled.pipeline.status` records are NOT
//     stored as real atproto records anywhere queryable over public XRPC —
//     knots emit them onto an internal event stream using an
//     `at://did:web:{knot}/...` naming convention purely for identification
//     (see core/appview/models/pipeline.go AtUri()), and the appview indexes
//     them into its own database, rendering them only as server-side HTML at
//     https://tangled.sh/{owner}/{repo}/pipelines/... (no public JSON/XRPC,
//     no CORS headers — unreachable from a browser-based SPA on another
//     origin). So pipelines/workflows must be *browsed* on the appview; this
//     SPA links out to it rather than pretending to enumerate them itself.
//
//   * The spindle's `/logs/{knot}/{rkey}/{name}` endpoint IS a plain,
//     unauthenticated websocket (see core/spindle/server.go + stream.go) that
//     a browser can connect to directly — that's the one piece of pipeline
//     data this SPA can show natively, given a pipeline rkey + workflow name
//     (copied from the appview's URL, or deep-linked via our own route).

export const PUBLIC_RESOLVER = "https://public.api.bsky.app";
export const PLC_DIRECTORY = "https://plc.directory";
export const APPVIEW = "https://tangled.sh";

export const REPO_NSID = "sh.tangled.repo";

/* ----------------------------------------------------------------------- */
/* atproto identity + XRPC helpers                                          */
/* ----------------------------------------------------------------------- */

export async function xrpcGet(serviceUrl, nsid, params = {}) {
	const url = new URL(`/xrpc/${nsid}`, serviceUrl);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) url.searchParams.set(k, v);
	}
	const res = await fetch(url);
	if (!res.ok) {
		let detail;
		try { detail = (await res.json()).message; } catch { /* ignore */ }
		throw new Error(`${nsid} failed: ${res.status} ${detail || res.statusText}`);
	}
	return res.json();
}

// resolveHandle turns a handle into a DID using the public AppView resolver.
export async function resolveHandle(handle) {
	const out = await xrpcGet(PUBLIC_RESOLVER, "com.atproto.identity.resolveHandle", { handle });
	return out.did;
}

// resolveDidDoc fetches the DID document for a did:plc or did:web identifier.
export async function resolveDidDoc(did) {
	if (did.startsWith("did:web:")) {
		// did:web:example.com[:path:segments] -> https://example.com/[path/segments/]did.json
		const rest = did.slice("did:web:".length).split(":").map(decodeURIComponent);
		const host = rest.shift();
		const path = rest.length ? `/${rest.join("/")}/did.json` : "/.well-known/did.json";
		const res = await fetch(`https://${host}${path}`);
		if (!res.ok) throw new Error(`failed to fetch DID document for ${did}: ${res.status}`);
		return res.json();
	}
	// did:plc:* (and anything else) — ask the directory.
	const res = await fetch(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`);
	if (!res.ok) throw new Error(`failed to fetch DID document for ${did}: ${res.status}`);
	return res.json();
}

// pdsEndpoint extracts the AtprotoPersonalDataServer service endpoint from a DID document.
export function pdsEndpoint(didDoc) {
	const svc = (didDoc.service || []).find(s =>
		s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer");
	if (!svc) throw new Error(`no AtprotoPersonalDataServer service found in DID document for ${didDoc.id}`);
	return svc.serviceEndpoint;
}

// resolveOwner accepts a handle or a DID and returns { did, pds }.
export async function resolveOwner(identifier) {
	const did = identifier.startsWith("did:") ? identifier : await resolveHandle(identifier);
	const didDoc = await resolveDidDoc(did);
	return { did, pds: pdsEndpoint(didDoc) };
}

// listAllRecords pages through every record in a collection.
export async function listAllRecords(serviceUrl, repo, collection) {
	const records = [];
	let cursor;
	do {
		const out = await xrpcGet(serviceUrl, "com.atproto.repo.listRecords", {
			repo, collection, cursor, limit: 100,
		});
		records.push(...out.records);
		cursor = out.cursor && out.records.length > 0 ? out.cursor : undefined;
	} while (cursor);
	return records;
}

export function rkeyFromUri(uri) {
	return uri.split("/").pop();
}

// findRepoRecord locates the sh.tangled.repo record matching a repo name,
// matching either on the record key (rkey) or its cosmetic `name` field.
export function findRepoRecord(repoRecords, repoName) {
	return repoRecords.find(r =>
		rkeyFromUri(r.uri) === repoName || r.value?.name === repoName);
}

/* ----------------------------------------------------------------------- */
/* Outbound links: appview (HTML browsing) + spindle (live log streaming)   */
/* ----------------------------------------------------------------------- */

// appviewRepoUrl / appviewPipelinesUrl / appviewWorkflowUrl build links into
// the official tangled.sh appview, where pipelines and workflows can actually
// be browsed (that data isn't available over public XRPC — see header note).
export function appviewRepoUrl(owner, repo) {
	return `${APPVIEW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
export function appviewPipelinesUrl(owner, repo) {
	return `${appviewRepoUrl(owner, repo)}/pipelines`;
}
export function appviewWorkflowUrl(owner, repo, pipelineRkey, workflowName) {
	return `${appviewPipelinesUrl(owner, repo)}/${encodeURIComponent(pipelineRkey)}/workflow/${encodeURIComponent(workflowName)}`;
}

// spindleLogsUrl builds the websocket URL for a spindle's public, unauthenticated
// /logs/{knot}/{rkey}/{name} endpoint (see core/spindle/server.go + stream.go).
export function spindleLogsUrl(spindle, knot, pipelineRkey, workflowName) {
	return `wss://${spindle}/logs/${encodeURIComponent(knot)}/${encodeURIComponent(pipelineRkey)}/${encodeURIComponent(workflowName)}`;
}

// spindleEventsUrl builds the websocket URL for a spindle's public,
// unauthenticated /events endpoint — a fan-out of `sh.tangled.pipeline.status`
// envelopes (see spindle main.ts broadcastStatus / app.get("/events")). This is
// the "jetstream" of pipeline activity for a given spindle: subscribing to it
// is how this SPA discovers pipeline runs as they happen, without needing the
// appview's HTML-only pipelines page.
export function spindleEventsUrl(spindle) {
	return `wss://${spindle}/events`;
}

/* ----------------------------------------------------------------------- */
/* Manual triggering: xrpc service-auth proxying to POST /trigger           */
/*                                                                           */
/* The spindle's /trigger endpoint (main.ts app.post("/trigger")) now       */
/* requires an ATProto inter-service auth JWT (see                          */
/* atproto.com/specs/xrpc#inter-service-authentication-jwt):                */
/*   - iss  = the signed-in user's DID                                      */
/*   - aud  = the spindle's service DID, did:web:<spindle-hostname>         */
/*   - lxm  = TRIGGER_LXM, binding the token to this one action             */
/* The token is minted via com.atproto.server.getServiceAuth (proxied       */
/* through the user's PDS, which signs it with their repo signing key) and  */
/* sent as a Bearer token — this *is* "xrpc service auth proxying": the PDS */
/* mediates issuance, the spindle verifies the result against the issuer's  */
/* DID document. See main.ts validateTriggerServiceAuth.                    */
/* ----------------------------------------------------------------------- */

// TRIGGER_LXM is the lexicon-method identifier the service-auth token is
// bound to. It isn't a registered NSID with a schema (the endpoint is plain
// POST /trigger, not /xrpc/...) — it just needs to be a stable string both
// sides agree on, so a token minted for this purpose can't be replayed
// against some other endpoint.
export const TRIGGER_LXM = "com.publicdomainrelay.temp.spindle.trigger";

// spindleServiceDid is the audience a trigger token must be issued for — the
// spindle's own did:web identity, derived from its public hostname.
export function spindleServiceDid(spindle) {
	return `did:web:${spindle}`;
}

// spindleTriggerUrl builds the spindle's POST /trigger endpoint URL.
export function spindleTriggerUrl(spindle) {
	return `https://${spindle}/trigger`;
}

// buildTriggerPayload assembles a TriggerPayload (mirrors main.ts:162-170 /
// TriggerPayload) from what the viewer already knows about the repo plus the
// signed-in user's DID (who becomes the "actor" the run is attributed to).
export function buildTriggerPayload({ knot, repoDid, repoName, ref, actorDid, inputs }) {
	if (!knot || !repoDid || !repoName || !ref || !actorDid) {
		throw new Error("buildTriggerPayload: missing knot, repoDid, repoName, ref, or actorDid");
	}
	const payload = { knot, pipelineRkey: triggerPipelineRkey(), actor: actorDid, repoDid, repoName, ref };
	if (inputs !== undefined) payload.inputs = inputs;
	return payload;
}

// resolveLatestSha asks the knot for the tip commit of a branch (mirrors the
// `sh.tangled.repo.log?repo=...&ref=...&limit=1` lookup in trigger.sh) — the
// spindle fetches .github/workflows/*.yml at this exact SHA, so the trigger
// payload's `ref` must be a real commit, not a branch name.
export async function resolveLatestSha(knot, repoDid, branch) {
	const out = await xrpcGet(`https://${knot}`, "sh.tangled.repo.log", { repo: repoDid, ref: branch, limit: 1 });
	const sha = out?.commits?.[0]?.this;
	if (!sha) throw new Error(`could not resolve latest commit for ${repoDid}@${branch} from ${knot}`);
	return sha;
}

// triggerPipelineRkey mints a unique-enough rkey for a manually-triggered run
// (the spindle just needs uniqueness per run — it doesn't validate TID shape).
export function triggerPipelineRkey(now = new Date()) {
	return `manual-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

/* ----------------------------------------------------------------------- */
/* Pipeline-status events: parsing + accumulating a browsable run list      */
/* ----------------------------------------------------------------------- */

// parsePipelineStatusEnvelope reads one /events frame (an EventsEnvelope, see
// spindle main.ts) and — if it's a `sh.tangled.pipeline.status` record —
// extracts the fields needed to display and browse the run. Returns null for
// anything else (e.g. the periodic {"type":"ping"} keepalive frames).
export function parsePipelineStatusEnvelope(envelope) {
	if (!envelope || typeof envelope !== "object") return null;
	if (envelope.nsid !== "sh.tangled.pipeline.status") return null;

	const event = envelope.event;
	if (!event || typeof event !== "object") return null;

	const pipeline = typeof event.pipeline === "string" ? event.pipeline : undefined;
	const pipelineRkey = pipeline ? rkeyFromUri(pipeline) : undefined;
	const workflow = typeof event.workflow === "string" ? event.workflow : undefined;
	if (!pipelineRkey || !workflow) return null;

	return {
		eventRkey: envelope.rkey,
		pipeline,
		pipelineRkey,
		workflow,
		status: event.status,
		createdAt: event.createdAt,
		receivedAt: typeof envelope.created === "number" ? envelope.created : undefined,
	};
}

// pipelineRunKey identifies a run independent of its current status, so
// repeated status updates for the same pipeline+workflow collapse into one
// browsable entry (matching the spindle's own runKey scheme).
export function pipelineRunKey(run) {
	return `${run.pipelineRkey}/${run.workflow}`;
}

// upsertPipelineRun folds a freshly-seen status event into a run list: new
// pipeline+workflow pairs are added to the front (most-recent-first), existing
// ones have their status/timestamps refreshed in place. Returns a new array —
// the input is left untouched, so callers can persist the result directly.
export function upsertPipelineRun(list, run) {
	if (!run || !run.pipelineRkey || !run.workflow) return list;
	const key = pipelineRunKey(run);
	const idx = list.findIndex((r) => pipelineRunKey(r) === key);
	if (idx === -1) return [{ ...run }, ...list];
	const next = list.slice();
	next[idx] = { ...next[idx], status: run.status, createdAt: run.createdAt, receivedAt: run.receivedAt };
	return next;
}

// pipelineStorageKey namespaces localStorage entries per repo, so switching
// repos doesn't mix up unrelated pipeline runs.
export function pipelineStorageKey(owner, repo) {
	return `tangled-spa:pipelines:${owner}/${repo}`;
}

/* ----------------------------------------------------------------------- */
/* Hash routing                                                             */
/*                                                                          */
/*   #/<owner>/<repo>                          -> repo overview            */
/*   #/<owner>/<repo>/<pipeline>/<workflow>    -> deep link to live logs   */
/* ----------------------------------------------------------------------- */

// parseRoute reads a hash (with or without the leading "#") and returns
// either { owner, repo } or { owner, repo, pipeline, workflow }, or null if
// the hash doesn't match either shape.
export function parseRoute(hash) {
	if (!hash) return null;
	const trimmed = hash.replace(/^#/, "");
	const parts = trimmed.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts.length === 2) {
		const [owner, repo] = parts;
		if (!owner || !repo) return null;
		return { owner, repo };
	}
	if (parts.length === 4) {
		const [owner, repo, pipeline, workflow] = parts;
		if (!owner || !repo || !pipeline || !workflow) return null;
		return { owner, repo, pipeline, workflow };
	}
	return null;
}

// buildRoute is the inverse of parseRoute. Pass just (owner, repo) for the
// repo-overview route, or all four arguments for a deep link to live logs.
export function buildRoute(owner, repo, pipeline, workflow) {
	const segments = [owner, repo];
	if (pipeline !== undefined && workflow !== undefined) segments.push(pipeline, workflow);
	return `#/${segments.map(encodeURIComponent).join("/")}`;
}
