// ---------------------------------------------------------------------------
// POST /hook/rfp  (firehose-style webhook envelope)
// https://airglow.run/dashboard/automations/3mm66tgw5fs22
// ---------------------------------------------------------------------------

type WebhookPayload = {
  automation?: string;
  lexicon?: string;
  conditions?: unknown[];
  event: {
    did: string;
    time_us?: number;
    kind?: string;
    commit: { operation: string; collection: string; rkey: string; record: Record<string, unknown>; cid?: string };
  };
};

app.post("/hook/rfp", async (c) => {
  const hookData = await c.req.json();
  log("info", "hit /hook/rfp", { hookData: hookData });
  const payload = hookData as WebhookPayload;
  const commit = payload.event?.commit;
  if (!commit) throw new HTTPError(400, "missing event.commit");
  if (commit.operation !== "create") return c.json({ skipped: "operation", operation: commit.operation });
  if (commit.collection !== RFP_NSID) return c.json({ skipped: "collection", collection: commit.collection });
  if (!commit.cid) throw new HTTPError(400, "commit.cid required");

  const rfpAtUri = `at://${payload.event.did}/${commit.collection}/${commit.rkey}`;
  const rfpCid = commit.cid;

  const rfpRecord = await resolveAs<RFP>(rfpAtUri, rfpCid);

  const { configUri, configCid, payloadUri, payloadCid, bidUri, bidCid } =
    await createAndSubmitBid(rfpAtUri, rfpCid, rfpRecord, x402UrlTemplate(BASE_URL, c.req.url));

  return c.json({
    success: true,
    rfp: { uri: rfpAtUri, cid: rfpCid },
    bid: { $type: "com.atproto.repo.strongRef", uri: bidUri, cid: bidCid },
    bid_payload: { $type: "com.atproto.repo.strongRef", uri: payloadUri, cid: payloadCid },
    bid_config: { $type: "com.atproto.repo.strongRef", uri: configUri, cid: configCid },
  });
});
