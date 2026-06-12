export const SUBSCRIBE_NSID = "com.fedproxy.temp.xrpc.subscribe";
export const GET_NONCE_NSID = "com.fedproxy.temp.xrpc.getRegistrationNonce";

// ── protocol frames ───────────────────────────────────────────────

export interface RegisteredFrame {
  $type: `${typeof SUBSCRIBE_NSID}#registered`;
  subdomain: string;
  proxyRef: string;
}

export interface RequestFrame {
  $type: `${typeof SUBSCRIBE_NSID}#request`;
  requestId: string;
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export interface ResponseFrame {
  $type: `${typeof SUBSCRIBE_NSID}#response`;
  requestId: string;
  status: number;
  body: unknown;
  contentType?: string;
}

export interface SubscribeFrame {
  $type: `${typeof SUBSCRIBE_NSID}#subscribe`;
  subscriptionId: string;
  nsid: string;
  params?: Record<string, string>;
}

export interface SubscriptionOpenFrame {
  $type: `${typeof SUBSCRIBE_NSID}#subscriptionOpen`;
  subscriptionId: string;
}

export interface SubscriptionEventFrame {
  $type: `${typeof SUBSCRIBE_NSID}#subscriptionEvent`;
  subscriptionId: string;
  message: unknown;
}

export interface SubscriptionCloseFrame {
  $type: `${typeof SUBSCRIBE_NSID}#subscriptionClose`;
  subscriptionId: string;
  code?: number;
  reason?: string;
}

export interface SubscriptionCancelFrame {
  $type: `${typeof SUBSCRIBE_NSID}#subscriptionCancel`;
  subscriptionId: string;
  reason?: string;
}

export type ProtocolFrame = RegisteredFrame | RequestFrame | SubscribeFrame
  | SubscriptionOpenFrame | SubscriptionEventFrame | SubscriptionCloseFrame
  | SubscriptionCancelFrame;

// ── subscribeRepos frame types (union message) ─────────────────────

export interface SubscribeReposCommit {
  seq: number;
  repo: string;
  commit: { $link: string };
  rev: string;
  since: string | null;
  blocks: unknown;
  ops: Array<{ action: string; path: string; cid: { $link: string } | null; prev: null }>;
  blobs: unknown[];
  time: string;
}

export interface SubscribeReposIdentity {
  seq: number;
  did: string;
  time: string;
  handle?: string;
}

export interface SubscribeReposAccount {
  seq: number;
  did: string;
  time: string;
  active: boolean;
  status?: string;
}

export interface SubscribeReposInfo {
  name: string;
  message?: string;
}

export type SubscribeReposFrame = SubscribeReposCommit | SubscribeReposIdentity
  | SubscribeReposAccount | SubscribeReposInfo;

// ── utility ───────────────────────────────────────────────────────

export function didToSubdomain(did: string): string {
  return did.replaceAll(":", "-").toLowerCase();
}

/** Strip port from host, return bare hostname. */
export function hostnameOnly(host: string): string {
  return host.split(":")[0];
}

/** Return http:// or https:// origin, including port if present. */
export function httpOrigin(host: string): string {
  if (host.includes(":") || host === "localhost") return `http://${host}`;
  return `https://${host}`;
}

/** Return ws:// or wss:// origin, including port if present. */
export function wsOrigin(host: string): string {
  if (host.includes(":") || host === "localhost") return `ws://${host}`;
  return `wss://${host}`;
}

export function hostnameToDid(hostname: string): string {
  return `did:web:${hostname}`;
}
