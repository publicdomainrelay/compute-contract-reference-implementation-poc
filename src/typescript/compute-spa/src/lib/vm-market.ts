import { pendingBids, type CollectedBid } from './relay-client.svelte.ts';
import { VM_NSID, RFP_NSID, ACCEPT_NSID, VOUCH_NSID } from './constants.ts';

type AttestationKeypair = {
  did: () => string;
  privateKey: { type: 'k256'; bytes: Uint8Array };
} | null;

export interface RequestVMParams {
  agent: unknown;
  proxyRef: string;
  keypair: AttestationKeypair;
  vmName: string;
  cloudInitScript: string;
  bidWindowSec: number;
  onLog: (msg: string) => void;
}

export interface RequestVMResult {
  vmUri: string;
  rfpUri: string;
  acceptUri: string;
  bidUri: string;
}

export async function requestVM(params: RequestVMParams): Promise<RequestVMResult> {
  const { agent, proxyRef, keypair, vmName, cloudInitScript, bidWindowSec, onLog } = params;

  if (!keypair) throw new Error('relay keypair not ready');
  const signer = { keypair, issuer: proxyRef };

  const { createRecord, createSignedRecord, createMarketClient, listRecordsAll, OFFERING_NSID } =
    await import('@publicdomainrelay/market') as {
      createRecord: (agent: unknown, col: string, rec: Record<string, unknown>) => Promise<{ uri: string; cid: string }>;
      createSignedRecord: (agent: unknown, col: string, rec: Record<string, unknown>, signer: unknown) => Promise<{ uri: string; cid: string }>;
      createMarketClient: (session: unknown, opts: Record<string, unknown>) => {
        submitRfp: (target: string, input: { rfpUri: string; rfpCid: string }) => Promise<{ ok: boolean }>;
        submitAccept: (target: string, input: Record<string, unknown>) => Promise<{ uri?: string; cid?: string }>;
      };
      listRecordsAll: (pdsUrl: string, did: string, collection: string) => Promise<Array<{ uri: string; cid: string; value: Record<string, unknown> }>>;
      OFFERING_NSID: string;
    };

  // 1. compute.vm record
  onLog('creating compute.vm record…');
  const vmRef = await createRecord(agent, VM_NSID, {
    $type: VM_NSID,
    role: vmName.trim() || 'compute',
    user_data: cloudInitScript,
    createdAt: new Date().toISOString(),
  });
  onLog(`compute.vm: ${vmRef.uri}`);

  // 2. market.rfp
  onLog('creating market.rfp…');
  const rfpRecord: Record<string, unknown> = {
    $type: RFP_NSID,
    domain: 'compute',
    payload: { $type: 'com.atproto.repo.strongRef', uri: vmRef.uri, cid: vmRef.cid },
    submitBid: `${proxyRef}#pdr_temp_market`,
    createdAt: new Date().toISOString(),
  };
  const rfpRef = await createSignedRecord(agent, RFP_NSID, rfpRecord, signer);
  onLog(`market.rfp: ${rfpRef.uri}`);

  // 2.5. discover vouched bidders and notify via OFFERING_NSID
  const { IdResolver } = await import('@atproto/identity');
  const idResolver = new IdResolver();
  const mc = createMarketClient(agent, {});

  const userDid = (agent as { did?: string }).did ?? '';
  onLog(`discovering vouched bidders for ${userDid}…`);
  let vouchedDids: string[] = [];
  try {
    const userDoc = await idResolver.did.resolve(userDid);
    const userPdsSvc = (userDoc?.service ?? []).find((s: { id: string }) => s.id === '#atproto_pds');
    const userPds = (userPdsSvc as { serviceEndpoint?: string } | undefined)?.serviceEndpoint;
    if (userPds) {
      const vouchRecords = await listRecordsAll(userPds, userDid, VOUCH_NSID);
      vouchedDids = Array.from(new Set(
        vouchRecords
          .filter((r) => (r.value.kind as string | undefined) !== 'denounce')
          .map((r) => r.uri.split('/').pop() ?? '')
          .filter((rkey) => rkey.startsWith('did:'))
      ));
      onLog(`found ${vouchedDids.length} vouched DID(s)`);
    } else {
      onLog('could not resolve user PDS — skipping vouch discovery');
    }
  } catch (err) {
    onLog(`vouch discovery error — ${String(err)}`);
  }

  await Promise.all(vouchedDids.map(async (bidderDid) => {
    try {
      const doc = await idResolver.did.resolve(bidderDid);
      const pdsService = (doc?.service ?? []).find((s: { id: string }) => s.id === '#atproto_pds');
      const pdsUrl = (pdsService as { serviceEndpoint?: string } | undefined)?.serviceEndpoint;
      if (!pdsUrl) { onLog(`  ${bidderDid}: no PDS found`); return; }
      const offerings = await listRecordsAll(pdsUrl, bidderDid, OFFERING_NSID);
      for (const offering of offerings) {
        const appliesTo = offering.value.appliesTo as string[] | undefined;
        const endpointUrl = offering.value.endpointUrl as string | undefined;
        if (!endpointUrl || !Array.isArray(appliesTo) || !appliesTo.includes(VM_NSID)) continue;
        onLog(`  ${bidderDid}: submitting RFP to ${endpointUrl}`);
        try {
          const res = await mc.submitRfp(endpointUrl, { rfpUri: rfpRef.uri, rfpCid: rfpRef.cid });
          onLog(`  ${bidderDid}: ${res.ok ? 'ok' : 'no-ok'}`);
        } catch (err) {
          onLog(`  ${bidderDid}: submitRfp error — ${String(err)}`);
        }
        break;
      }
    } catch (err) {
      onLog(`  ${bidderDid}: offering discovery error — ${String(err)}`);
    }
  }));

  // 3. collect bids
  onLog(`waiting ${bidWindowSec}s for bids…`);
  await new Promise<void>((resolve) => setTimeout(resolve, bidWindowSec * 1000));

  const bids = pendingBids.get(rfpRef.uri) ?? [];
  pendingBids.delete(rfpRef.uri);
  onLog(`${bids.length} bid(s) received`);

  if (bids.length === 0) throw new Error(`no bids within ${bidWindowSec}s`);

  // 4. pick lowest-cost winner
  const winner: CollectedBid = bids.reduce((best, b) => {
    const cost = (n: CollectedBid) => Number((n.record.payload as Record<string, unknown> | undefined)?.cost ?? Infinity);
    return cost(b) < cost(best) ? b : best;
  }, bids[0]);
  onLog(`winner: ${winner.uri} (did: ${winner.did})`);

  const bidRef = { $type: 'com.atproto.repo.strongRef', uri: winner.uri, cid: winner.cid };

  // 5. market.accept
  onLog('creating market.accept…');
  const acceptRecord: Record<string, unknown> = {
    $type: ACCEPT_NSID,
    rfp: { $type: 'com.atproto.repo.strongRef', uri: rfpRef.uri, cid: rfpRef.cid },
    bid: bidRef,
    submitEvent: `${proxyRef}#pdr_temp_compute_event`,
    createdAt: new Date().toISOString(),
  };
  const acceptRef = await createSignedRecord(agent, ACCEPT_NSID, acceptRecord, signer);
  onLog(`market.accept: ${acceptRef.uri}`);

  // 6. submit accept to bidder
  const submitAcceptTarget = winner.record.submitAccept as string | undefined;
  if (submitAcceptTarget) {
    onLog('submitting accept to bidder…');
    const mc2 = createMarketClient(agent, {});
    const body = await mc2.submitAccept(submitAcceptTarget, {
      acceptUri: acceptRef.uri,
      acceptCid: acceptRef.cid,
    });
    onLog(`receipt: ${body.uri ?? 'n/a'}`);
  } else {
    onLog('no submitAccept endpoint on bid — skipping');
  }

  return { vmUri: vmRef.uri, rfpUri: rfpRef.uri, acceptUri: acceptRef.uri, bidUri: winner.uri };
}
