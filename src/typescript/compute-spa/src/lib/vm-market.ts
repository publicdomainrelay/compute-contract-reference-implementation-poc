import { pendingBids, type CollectedBid } from './relay-client.svelte.ts';
import { VM_NSID, RFP_NSID, ACCEPT_NSID, VOUCH_NSID, SSH_KEY_NSID } from './constants.ts';

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
  /** Override registry endpoints for discovery (defaults to built-in list). */
  registryEndpoints?: string[];
  /** Override hardcoded bidder DIDs (defaults to built-in list). */
  bidderDids?: string[];
  onLog: (msg: string) => void;
  /** fedproxy SERVICE name for this VM (`<role>--<handle-label>`). Used in RBAC grant. */
  serviceName?: string;
}

export interface RequestVMResult {
  vmUri: string;
  rfpUri: string;
  acceptUri: string;
  bidUri: string;
  receiptUri?: string;
  receiptCid?: string;
  submitEventRef?: string;
  /** com.fedproxy.rbac record created to authorize this VM. */
  rbacUri?: string;
}

export async function requestVM(params: RequestVMParams): Promise<RequestVMResult> {
  const { agent, proxyRef, keypair, vmName, cloudInitScript, bidWindowSec, registryEndpoints, bidderDids: bidderDidsOverride, onLog } = params;

  if (!keypair) throw new Error('relay keypair not ready');
  const signer = { keypair, issuer: proxyRef };

  const { createRecord, createSignedRecord, createMarketClient, listRecordsAll, discoverBiddersFromRegistries, DEFAULT_REGISTRY_ENDPOINTS, OFFERING_NSID, parseAtUri } =
    await import('@publicdomainrelay/market') as {
      createRecord: (agent: unknown, col: string, rec: Record<string, unknown>) => Promise<{ uri: string; cid: string }>;
      createSignedRecord: (agent: unknown, col: string, rec: Record<string, unknown>, signer: unknown) => Promise<{ uri: string; cid: string }>;
      createMarketClient: (session: unknown, opts: Record<string, unknown>) => {
        submitRfp: (target: string, input: { rfpUri: string; rfpCid: string }) => Promise<{ ok: boolean }>;
        submitAccept: (target: string, input: { acceptUri: string; acceptCid: string }) => Promise<{ id: string; uri: string; cid: string; submitEvent: string }>;
        listBidders: (target: string, params?: Record<string, unknown>) => Promise<{ bidders: Array<{ bidderDid: string; offeringEndpointUrl: string; appliesTo: string[]; lastHeartbeat: string }>; cursor?: string }>;
      };
      listRecordsAll: (pdsUrl: string, did: string, collection: string) => Promise<Array<{ uri: string; cid: string; value: Record<string, unknown> }>>;
      discoverBiddersFromRegistries: (opts: { payloadNsid: string; registryEndpoints?: string[]; marketClient?: unknown; log?: (severity: string, msg: string, extra?: Record<string, unknown>) => void }) => Promise<Set<string>>;
      DEFAULT_REGISTRY_ENDPOINTS: string[];
      OFFERING_NSID: string;
      parseAtUri: (uri: string) => { repo: string; collection: string; rkey: string };
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

  // 2.5. discover bidders: vouches + registry (run concurrently)
  const { IdResolver } = await import('@atproto/identity');
  const idResolver = new IdResolver();
  const mc = createMarketClient(agent, {});

  // Hardcoded DIDs always included in addition to discovered bidders.
  // Caller can override via params; otherwise falls back to the built-in list.
  const DEFAULT_BIDDER_DIDS = bidderDidsOverride ?? ['did:plc:5svqtrhheairglgiiyvutzik'];

  const userDid = (agent as { did?: string }).did ?? '';

  // Vouch-based discovery (from user's PDS).
  const vouchPromise = (async (): Promise<string[]> => {
    onLog(`discovering vouched bidders for ${userDid}…`);
    try {
      const userDoc = await idResolver.did.resolve(userDid);
      const userPdsSvc = (userDoc?.service ?? []).find((s: { id: string }) => s.id === '#atproto_pds');
      const userPds = (userPdsSvc as { serviceEndpoint?: string } | undefined)?.serviceEndpoint;
      if (userPds) {
        const vouchRecords = await listRecordsAll(userPds, userDid, VOUCH_NSID);
        const dids = Array.from(new Set(
          vouchRecords
            .filter((r) => (r.value.kind as string | undefined) !== 'denounce')
            .map((r) => r.uri.split('/').pop() ?? '')
            .filter((rkey) => rkey.startsWith('did:'))
        ));
        onLog(`found ${dids.length} vouched DID(s)`);
        return dids;
      } else {
        onLog('could not resolve user PDS — skipping vouch discovery');
      }
    } catch (err) {
      onLog(`vouch discovery error — ${String(err)}`);
    }
    return [];
  })();

  // Registry-based discovery (queries market registry for registered bidders).
  const registryPromise = (async (): Promise<string[]> => {
    onLog('discovering bidders from market registry…');
    try {
      const registryDids = await discoverBiddersFromRegistries({
        payloadNsid: VM_NSID,
        registryEndpoints: registryEndpoints ?? DEFAULT_REGISTRY_ENDPOINTS,
        marketClient: mc,
        log: (severity: string, msg: string) => {
          if (severity === 'warn') onLog(`registry: ${msg}`);
        },
      });
      onLog(`found ${registryDids.size} registry DID(s)`);
      return Array.from(registryDids);
    } catch (err) {
      onLog(`registry discovery error — ${String(err)}`);
    }
    return [];
  })();

  const [vouchedDids, registryDids] = await Promise.all([vouchPromise, registryPromise]);
  const bidderDids = Array.from(new Set([...DEFAULT_BIDDER_DIDS, ...vouchedDids, ...registryDids]));
  onLog(`checking ${bidderDids.length} bidder DID(s) (${DEFAULT_BIDDER_DIDS.length} default, ${vouchedDids.length} vouched, ${registryDids.length} registry)`);

  await Promise.all(bidderDids.map(async (bidderDid) => {
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

  // Resolve winner's bid config to build the RBAC grant that authorizes
  // the VM to register its SSH public key. Mirrors the spindle's
  // marketRFP.ts RBAC creation (com.fedproxy.rbac).
  const RBAC_NSID = 'com.fedproxy.rbac';
  let rbacRef: { uri: string; cid: string } | undefined;
  const winnerConfigRef = (winner.record as Record<string, unknown>).config as { uri?: string } | undefined;
  if (winnerConfigRef?.uri && params.serviceName) {
    try {
      const winnerPdsSvc = (await idResolver.did.resolve(winner.did))?.service
        ?.find((s: { id: string }) => s.id === '#atproto_pds');
      const winnerPds = (winnerPdsSvc as { serviceEndpoint?: string } | undefined)?.serviceEndpoint;
      if (winnerPds) {
        const { repo, collection, rkey } = parseAtUri(winnerConfigRef.uri);
        const configUrl = new URL(`${winnerPds}/xrpc/com.atproto.repo.getRecord`);
        configUrl.searchParams.set('repo', repo);
        configUrl.searchParams.set('collection', collection);
        configUrl.searchParams.set('rkey', rkey);
        const configRes = await fetch(configUrl.toString());
        if (configRes.ok) {
          const configData = await configRes.json() as { value: Record<string, unknown> };
          const winnerConfig = configData.value;
          const issuerUri = winnerConfig['issuer_uri'] as string | undefined;
          const actx = winnerConfig['actx'] as string | undefined;
          if (issuerUri && actx) {
            const agentDid = (agent as { did?: string }).did ?? '';
            const agentDidPlcKey = agentDid.replace(/^did:plc:/, '');
            const serviceName = params.serviceName;

            const rbacRecord = {
              $type: RBAC_NSID,
              roles: {
                [serviceName]: {
                  role_name: serviceName,
                  definition: {
                    aud: `api://ATProto?actx=${agentDid}`,
                    iss: issuerUri,
                    sub: `actx:${actx}:plc:${agentDidPlcKey}:role:${serviceName}`,
                    policies: [`${serviceName}-ssh-key-register`],
                  },
                },
              },
              policies: {
                [`${serviceName}-ssh-key-register`]: {
                  meta: { policy: 'ssh-key-register' },
                  schemas: {
                    '/xrpc/com.atproto.repo.createRecord': {
                      type: 'object',
                      $schema: 'http://json-schema.org/draft-07/schema#',
                      required: ['capability', 'body'],
                      properties: {
                        capability: { enum: ['create'] },
                        body: {
                          type: 'object',
                          additionalProperties: false,
                          required: ['collection', 'record'],
                          properties: {
                            collection: { type: 'string', const: SSH_KEY_NSID },
                            record: {
                              type: 'object',
                              properties: { service: { type: 'string', const: serviceName } },
                              required: ['service'],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              custom_claims_roles_index: { job_workflow_ref: {} },
              createdAt: new Date().toISOString(),
            };

            onLog('creating com.fedproxy.rbac record…');
            rbacRef = await createRecord(agent, RBAC_NSID, rbacRecord);
            onLog(`com.fedproxy.rbac: ${rbacRef.uri}`);
          }
        }
      }
    } catch (err) {
      onLog(`rbac record skipped — ${String(err)}`);
    }
  }

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
  let receiptUri: string | undefined;
  let receiptCid: string | undefined;
  let submitEventRef: string | undefined;
  if (submitAcceptTarget) {
    onLog('submitting accept to bidder…');
    const mc2 = createMarketClient(agent, {});
    const body = await mc2.submitAccept(submitAcceptTarget, {
      acceptUri: acceptRef.uri,
      acceptCid: acceptRef.cid,
    });
    receiptUri = body.uri;
    receiptCid = body.cid;
    submitEventRef = body.submitEvent;
    onLog(`receipt: ${body.uri ?? 'n/a'}`);
  } else {
    onLog('no submitAccept endpoint on bid — skipping');
  }

  return { vmUri: vmRef.uri, rfpUri: rfpRef.uri, acceptUri: acceptRef.uri, bidUri: winner.uri, receiptUri, receiptCid, submitEventRef, rbacUri: rbacRef?.uri };
}
