import { log } from "./log.ts";

export interface RelayResult {
  status: number;
  body: unknown;
  contentType?: string;
}

interface PendingRequest {
  subdomain: string;
  resolve: (r: RelayResult) => void;
  reject: (e: Error) => void;
  timer?: number;
  frame: string;
}

interface QueuedRelay {
  requestId: string;
  frame: string;
  resolve: (r: RelayResult) => void;
  reject: (e: Error) => void;
}

export interface ActiveSubscription {
  callerWs: WebSocket;
  subdomain: string;
  nsid: string;
}

export interface RelayStateOptions {
  relayTimeoutMs: number;
  reconnectGraceMs: number;
}

export class RelayState {
  readonly subscribers = new Map<string, WebSocket>();
  readonly pendingRequests = new Map<string, PendingRequest>();
  readonly reconnectQueues = new Map<string, { entries: QueuedRelay[]; graceTimer: number }>();
  readonly activeSubscriptions = new Map<string, ActiveSubscription>();

  constructor(private readonly opts: RelayStateOptions) {}

  drainToReconnectQueue(subdomain: string) {
    const existing = this.reconnectQueues.get(subdomain);
    if (existing) clearTimeout(existing.graceTimer);
    const entries: QueuedRelay[] = existing?.entries ?? [];
    for (const [reqId, p] of this.pendingRequests) {
      if (p.subdomain !== subdomain) continue;
      if (p.timer) clearTimeout(p.timer);
      this.pendingRequests.delete(reqId);
      entries.push({ requestId: reqId, frame: p.frame, resolve: p.resolve, reject: p.reject });
    }
    const graceTimer = setTimeout(() => {
      this.reconnectQueues.delete(subdomain);
      for (const e of entries) e.reject(new Error(`subscriber for ${subdomain} did not reconnect in time`));
      log("warn", { component: "relay", event: "reconnect_grace_expired", subdomain, dropped: entries.length });
    }, this.opts.reconnectGraceMs) as unknown as number;
    this.reconnectQueues.set(subdomain, { entries, graceTimer });
  }

  flushReconnectQueue(subdomain: string, ws: WebSocket) {
    const queue = this.reconnectQueues.get(subdomain);
    if (!queue) return;
    clearTimeout(queue.graceTimer);
    this.reconnectQueues.delete(subdomain);
    for (const e of queue.entries) {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(e.requestId);
        e.reject(new Error(`relay timeout after ${this.opts.relayTimeoutMs}ms`));
      }, this.opts.relayTimeoutMs) as unknown as number;
      this.pendingRequests.set(e.requestId, { subdomain, resolve: e.resolve, reject: e.reject, timer, frame: e.frame });
      ws.send(e.frame);
    }
    log("info", { component: "relay", event: "reconnect_queue_flushed", subdomain, replayed: queue.entries.length });
  }

  rejectSubscriberSubscriptions(subdomain: string) {
    for (const [id, sub] of this.activeSubscriptions) {
      if (sub.subdomain !== subdomain) continue;
      this.activeSubscriptions.delete(id);
      if (sub.callerWs.readyState === WebSocket.OPEN) {
        sub.callerWs.close(4001, "subscriber disconnected");
      }
    }
  }

  async dispatchRequest(subdomain: string, requestId: string, frame: string): Promise<RelayResult> {
    const ws = this.subscribers.get(subdomain);
    const queue = this.reconnectQueues.get(subdomain);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!queue) {
        throw Object.assign(
          new Error(`no active subscriber for subdomain ${subdomain} (did:key with colons replaced by hyphens)`),
          { code: "NO_SUBSCRIBER" },
        );
      }
      return new Promise<RelayResult>((resolve, reject) => {
        queue.entries.push({ requestId, frame, resolve, reject });
      });
    }
    return new Promise<RelayResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`relay timeout after ${this.opts.relayTimeoutMs}ms`));
      }, this.opts.relayTimeoutMs) as unknown as number;
      this.pendingRequests.set(requestId, { subdomain, resolve, reject, timer, frame });
      ws.send(frame);
    });
  }

  handleResponse(requestId: string, status: number, body: unknown, contentType?: string) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve({ status, body, contentType });
  }
}
