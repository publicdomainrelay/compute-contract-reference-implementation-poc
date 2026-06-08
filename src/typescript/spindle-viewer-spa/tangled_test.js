// Deno tests for the DOM-free logic in ./tangled.js.
//
// Run with:
//   deno test --allow-net --allow-env tangled_test.js
//
// Set TANGLED_SPA_SKIP_LIVE_TESTS=1 to skip the tests that hit live
// atproto infrastructure (useful when offline).
//
// The "load repo" tests hit live atproto infrastructure (the public AppView,
// the PLC directory, and the owner's PDS) to verify the full resolution chain
// end-to-end against a real, known repo:
//
//   johnandersen777.bsky.social / compute-contract-reference-implementation-poc
//
// This is the same chain main.js drives when a user opens
// #/johnandersen777.bsky.social/compute-contract-reference-implementation-poc.

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
	REPO_NSID, APPVIEW,
	resolveOwner, resolveDidDoc, pdsEndpoint, listAllRecords, rkeyFromUri,
	findRepoRecord,
	appviewRepoUrl, appviewPipelinesUrl, appviewWorkflowUrl, spindleLogsUrl,
	spindleEventsUrl, parsePipelineStatusEnvelope, pipelineRunKey, upsertPipelineRun, pipelineStorageKey,
	parseRoute, buildRoute,
	TRIGGER_LXM, spindleServiceDid, spindleTriggerUrl, buildTriggerPayload, triggerPipelineRkey,
} from "./tangled.js";

const OWNER = "johnandersen777.bsky.social";
const REPO = "compute-contract-reference-implementation-poc";

/* ----------------------------------------------------------------------- */
/* Pure helpers — no network                                                */
/* ----------------------------------------------------------------------- */

Deno.test("rkeyFromUri extracts the final path segment", () => {
	assertEquals(rkeyFromUri("at://did:plc:abc123/sh.tangled.repo/3jzfcijpj2z2a"), "3jzfcijpj2z2a");
	assertEquals(rkeyFromUri("just-an-rkey"), "just-an-rkey");
});

Deno.test("findRepoRecord matches by rkey or by cosmetic name", () => {
	const records = [
		{ uri: "at://did:plc:abc/sh.tangled.repo/abc123", value: { name: "other-repo" } },
		{ uri: "at://did:plc:abc/sh.tangled.repo/xyz789", value: { name: REPO } },
	];
	assertEquals(findRepoRecord(records, REPO)?.uri, "at://did:plc:abc/sh.tangled.repo/xyz789");
	assertEquals(findRepoRecord(records, "abc123")?.value.name, "other-repo");
	assertEquals(findRepoRecord(records, "does-not-exist"), undefined);
});

/* ----------------------------------------------------------------------- */
/* Manual triggering: xrpc service-auth proxying to POST /trigger           */
/* ----------------------------------------------------------------------- */

Deno.test("spindleServiceDid + spindleTriggerUrl derive the spindle's service DID and trigger endpoint from its hostname", () => {
	assertEquals(spindleServiceDid("did-plc-aaa.gha.spindle.example.com"), "did:web:did-plc-aaa.gha.spindle.example.com");
	assertEquals(spindleTriggerUrl("did-plc-aaa.gha.spindle.example.com"), "https://did-plc-aaa.gha.spindle.example.com/trigger");
});

Deno.test("triggerPipelineRkey mints a unique, sortable rkey from a timestamp", () => {
	const a = triggerPipelineRkey(new Date("2026-06-08T01:02:03.456Z"));
	const b = triggerPipelineRkey(new Date("2026-06-08T01:02:04.000Z"));
	assertEquals(a, "manual-20260608T010203Z");
	assertEquals(b, "manual-20260608T010204Z");
	assert(a < b);
});

Deno.test("buildTriggerPayload assembles a TriggerPayload from repo facts + the signed-in actor's DID", () => {
	const payload = buildTriggerPayload({
		knot: "knot1.tangled.sh",
		repoDid: "did:plc:bbvpwcihkeeztqxk47s5arq3",
		repoName: REPO,
		ref: "abc123",
		actorDid: "did:plc:alice",
	});
	assertEquals(payload.knot, "knot1.tangled.sh");
	assertEquals(payload.actor, "did:plc:alice");
	assertEquals(payload.repoDid, "did:plc:bbvpwcihkeeztqxk47s5arq3");
	assertEquals(payload.repoName, REPO);
	assertEquals(payload.ref, "abc123");
	assert(payload.pipelineRkey.startsWith("manual-"));
});

Deno.test("buildTriggerPayload requires the fields the spindle's TriggerPayload needs", () => {
	let threw = false;
	try {
		buildTriggerPayload({ knot: "knot1.tangled.sh", repoDid: "did:plc:x", repoName: REPO, ref: "abc" });
	} catch {
		threw = true;
	}
	assert(threw, "expected buildTriggerPayload to throw when actorDid is missing");
});

Deno.test("TRIGGER_LXM is a stable lexicon-method identifier the service-auth token is bound to", () => {
	assertEquals(TRIGGER_LXM, "com.publicdomainrelay.temp.spindle.trigger");
});

/* ----------------------------------------------------------------------- */
/* Outbound URL builders                                                    */
/* ----------------------------------------------------------------------- */

Deno.test("appview URL builders point at tangled.sh's repo/pipeline/workflow pages", () => {
	assertEquals(appviewRepoUrl(OWNER, REPO), `${APPVIEW}/${OWNER}/${REPO}`);
	assertEquals(appviewPipelinesUrl(OWNER, REPO), `${APPVIEW}/${OWNER}/${REPO}/pipelines`);
	assertEquals(
		appviewWorkflowUrl(OWNER, REPO, "3lk2x9f7q2c2a", "build"),
		`${APPVIEW}/${OWNER}/${REPO}/pipelines/3lk2x9f7q2c2a/workflow/build`,
	);
});

Deno.test("appview URL builders escape identifiers that need it", () => {
	assertEquals(
		appviewWorkflowUrl("did:plc:abc", "my repo", "pipeline id", "build & test"),
		`${APPVIEW}/did%3Aplc%3Aabc/my%20repo/pipelines/pipeline%20id/workflow/build%20%26%20test`,
	);
});

Deno.test("spindleLogsUrl builds a wss:// URL matching the spindle's /logs/{knot}/{rkey}/{name} route", () => {
	assertEquals(
		spindleLogsUrl("spindle.example.com", "knot1.tangled.sh", "3lk2x9f7q2c2a", "build"),
		"wss://spindle.example.com/logs/knot1.tangled.sh/3lk2x9f7q2c2a/build",
	);
});

Deno.test("spindleLogsUrl escapes path segments", () => {
	assertEquals(
		spindleLogsUrl("spindle.example.com", "k n", "p i", "w f"),
		"wss://spindle.example.com/logs/k%20n/p%20i/w%20f",
	);
});

/* ----------------------------------------------------------------------- */
/* Pipeline-status jetstream: parsing + accumulating a browsable run list   */
/* ----------------------------------------------------------------------- */

Deno.test("spindleEventsUrl builds a wss:// URL matching the spindle's /events route", () => {
	assertEquals(spindleEventsUrl("spindle.example.com"), "wss://spindle.example.com/events");
});

Deno.test("parsePipelineStatusEnvelope extracts run fields from a status envelope", () => {
	const envelope = {
		rkey: "mnjfq3cub26d5",
		nsid: "sh.tangled.pipeline.status",
		event: {
			$type: "sh.tangled.pipeline.status",
			workflow: "build-containers",
			status: "running",
			createdAt: "2026-06-05T05:27:52.140Z",
			pipeline: "at://did:web:knot1.fedfork.com/sh.tangled.pipeline/3mnjfnzfohg22",
		},
		created: 1780636872140000000,
	};
	assertEquals(parsePipelineStatusEnvelope(envelope), {
		eventRkey: "mnjfq3cub26d5",
		pipeline: "at://did:web:knot1.fedfork.com/sh.tangled.pipeline/3mnjfnzfohg22",
		pipelineRkey: "3mnjfnzfohg22",
		workflow: "build-containers",
		status: "running",
		createdAt: "2026-06-05T05:27:52.140Z",
		receivedAt: 1780636872140000000,
	});
});

Deno.test("parsePipelineStatusEnvelope ignores non-status records and keepalive pings", () => {
	assertEquals(parsePipelineStatusEnvelope({ type: "ping" }), null);
	assertEquals(parsePipelineStatusEnvelope({ rkey: "x", nsid: "sh.tangled.pipeline", event: {} }), null);
	assertEquals(
		parsePipelineStatusEnvelope({ rkey: "x", nsid: "sh.tangled.pipeline.status", event: { status: "running" } }),
		null, // missing workflow/pipeline → can't browse to it
	);
});

Deno.test("pipelineRunKey + upsertPipelineRun collapse repeated status updates into one entry", () => {
	const submitted = { pipelineRkey: "3mnjfnzfohg22", workflow: "build-containers", status: "submitted", createdAt: "t0" };
	const running = { pipelineRkey: "3mnjfnzfohg22", workflow: "build-containers", status: "running", createdAt: "t1" };
	const otherWorkflow = { pipelineRkey: "3mnjfnzfohg22", workflow: "test", status: "submitted", createdAt: "t0" };

	assertEquals(pipelineRunKey(submitted), "3mnjfnzfohg22/build-containers");

	let list = [];
	list = upsertPipelineRun(list, submitted);
	assertEquals(list.length, 1);
	assertEquals(list[0].status, "submitted");

	list = upsertPipelineRun(list, running);
	assertEquals(list.length, 1, "same pipeline+workflow should update in place, not duplicate");
	assertEquals(list[0].status, "running");
	assertEquals(list[0].createdAt, "t1");

	list = upsertPipelineRun(list, otherWorkflow);
	assertEquals(list.length, 2, "a different workflow on the same pipeline is a distinct run");
	assertEquals(list[0].workflow, "test", "newest run is inserted at the front");
});

Deno.test("upsertPipelineRun ignores malformed runs", () => {
	assertEquals(upsertPipelineRun([], null), []);
	assertEquals(upsertPipelineRun([], { workflow: "build" }), []);
	assertEquals(upsertPipelineRun([], { pipelineRkey: "abc" }), []);
});

Deno.test("pipelineStorageKey namespaces localStorage entries per repo", () => {
	assertEquals(pipelineStorageKey(OWNER, REPO), `tangled-spa:pipelines:${OWNER}/${REPO}`);
	assertEquals(pipelineStorageKey("alice", "repo-a"), "tangled-spa:pipelines:alice/repo-a");
});

/* ----------------------------------------------------------------------- */
/* Hash routing                                                             */
/*                                                                          */
/*   #/<owner>/<repo>                       -> repo overview               */
/*   #/<owner>/<repo>/<pipeline>/<workflow> -> deep link to live logs      */
/* ----------------------------------------------------------------------- */

Deno.test("parseRoute parses the 2-segment repo-overview shape, with or without the leading #", () => {
	assertEquals(parseRoute(`#/${OWNER}/${REPO}`), { owner: OWNER, repo: REPO });
	assertEquals(parseRoute(`/${OWNER}/${REPO}`), { owner: OWNER, repo: REPO });
});

Deno.test("parseRoute parses the 4-segment deep-link-to-logs shape", () => {
	assertEquals(
		parseRoute(`#/${OWNER}/${REPO}/3lk2x9f7q2c2a/build`),
		{ owner: OWNER, repo: REPO, pipeline: "3lk2x9f7q2c2a", workflow: "build" },
	);
});

Deno.test("parseRoute decodes URI components in both shapes", () => {
	assertEquals(parseRoute("#/did%3Aplc%3Aabc123/my%20repo"), { owner: "did:plc:abc123", repo: "my repo" });
	assertEquals(
		parseRoute("#/did%3Aplc%3Aabc123/my%20repo/pipeline%20id/build%20%26%20test"),
		{ owner: "did:plc:abc123", repo: "my repo", pipeline: "pipeline id", workflow: "build & test" },
	);
});

Deno.test("parseRoute rejects malformed or wrong-arity hashes", () => {
	assertEquals(parseRoute(""), null);
	assertEquals(parseRoute("#/"), null);
	assertEquals(parseRoute("#/just-owner"), null);
	assertEquals(parseRoute("#/a/b/c"), null);
	assertEquals(parseRoute("#/a/b/c/d/e"), null);
	assertEquals(parseRoute("#"), null);
});

Deno.test("buildRoute + parseRoute round-trip the repo-overview shape", () => {
	const hash = buildRoute(OWNER, REPO);
	assertEquals(hash, `#/${OWNER}/${REPO}`);
	assertEquals(parseRoute(hash), { owner: OWNER, repo: REPO });
});

Deno.test("buildRoute + parseRoute round-trip the deep-link-to-logs shape", () => {
	const hash = buildRoute(OWNER, REPO, "3lk2x9f7q2c2a", "build");
	assertEquals(hash, `#/${OWNER}/${REPO}/3lk2x9f7q2c2a/build`);
	assertEquals(parseRoute(hash), { owner: OWNER, repo: REPO, pipeline: "3lk2x9f7q2c2a", workflow: "build" });
});

Deno.test("buildRoute round-trips identifiers that need escaping", () => {
	const owner = "did:plc:abc123";
	const repo = "repo with spaces";
	assertEquals(parseRoute(buildRoute(owner, repo)), { owner, repo });

	const pipeline = "pipeline id";
	const workflow = "build & test";
	assertEquals(
		parseRoute(buildRoute(owner, repo, pipeline, workflow)),
		{ owner, repo, pipeline, workflow },
	);
});

/* ----------------------------------------------------------------------- */
/* Live integration: load johnandersen777.bsky.social/compute-contract-... */
/* ----------------------------------------------------------------------- */

Deno.test({
	name: "resolveOwner resolves johnandersen777.bsky.social to a DID + PDS",
	ignore: Deno.env.get("TANGLED_SPA_SKIP_LIVE_TESTS") === "1",
	async fn() {
		const owner = await resolveOwner(OWNER);
		assert(owner.did.startsWith("did:"), `expected a DID, got ${owner.did}`);
		assert(owner.pds.startsWith("https://"), `expected an https PDS endpoint, got ${owner.pds}`);
	},
});

Deno.test({
	name: "resolveDidDoc + pdsEndpoint agree with resolveOwner for the same DID",
	ignore: Deno.env.get("TANGLED_SPA_SKIP_LIVE_TESTS") === "1",
	async fn() {
		const owner = await resolveOwner(OWNER);
		const didDoc = await resolveDidDoc(owner.did);
		assertEquals(didDoc.id, owner.did);
		assertEquals(pdsEndpoint(didDoc), owner.pds);
	},
});

Deno.test({
	name: `loading the repo record for ${OWNER}/${REPO} resolves knot + (optionally) spindle`,
	ignore: Deno.env.get("TANGLED_SPA_SKIP_LIVE_TESTS") === "1",
	async fn() {
		const owner = await resolveOwner(OWNER);

		const repoRecords = await listAllRecords(owner.pds, owner.did, REPO_NSID);
		assert(repoRecords.length > 0, `expected ${owner.did} to have at least one ${REPO_NSID} record`);

		const repoRecord = findRepoRecord(repoRecords, REPO);
		assertExists(repoRecord, `expected to find a "${REPO}" repo for ${OWNER} (${owner.did})`);

		const value = repoRecord.value;
		assertEquals(rkeyFromUri(repoRecord.uri).length > 0, true);
		assert(typeof value.knot === "string" && value.knot.length > 0, "repo record should name its knot");
		assert(typeof value.createdAt === "string", "repo record should carry a createdAt timestamp");

		// spindle is optional — only assert its shape when present, and that
		// the resulting log-stream URL is well-formed (the actual websocket
		// isn't dialed here; that's covered by browser-side smoke testing).
		if (value.spindle) {
			assert(value.spindle.length > 0, "spindle, if present, should be a non-empty hostname");
			const url = spindleLogsUrl(value.spindle, value.knot, "examplepipeline", "build");
			assertEquals(url, `wss://${value.spindle}/logs/${value.knot}/examplepipeline/build`);
		}

		// The pipelines link should always be derivable, regardless of whether
		// any pipelines have actually run yet.
		assertEquals(appviewPipelinesUrl(OWNER, REPO), `${APPVIEW}/${OWNER}/${REPO}/pipelines`);

		console.log(`[live] resolved ${OWNER}/${REPO} -> did=${owner.did} knot=${value.knot} spindle=${value.spindle ?? "(none)"}`);
	},
});

Deno.test({
	name: `the appview's pipelines page for ${OWNER}/${REPO} is reachable (browsing surface, not parsed)`,
	ignore: Deno.env.get("TANGLED_SPA_SKIP_LIVE_TESTS") === "1",
	async fn() {
		const url = appviewPipelinesUrl(OWNER, REPO);
		const res = await fetch(url);
		assertEquals(res.status, 200, `expected ${url} to be reachable`);
		await res.body?.cancel();
	},
});
