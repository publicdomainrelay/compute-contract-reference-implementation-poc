// @publicdomainrelay/hono-factory-xrpc-subscriber — Hono bridge for the XRPC
// relay subscriber side.
//
// Symmetric counterpart to @publicdomainrelay/hono-factory-xrpc-relay:
//   relay factory      : inbound HTTP  → #request frame → WS
//   subscriber factory : #request frame → app.fetch()   → #response frame
//
// createSubscriberFactory({ app }).handleRequest plugs straight into
// createSubscriber({ handleRequest }) from @publicdomainrelay/xrpc-relay.
//
// Usage:
//   import { createSubscriber } from "@publicdomainrelay/xrpc-relay";
//   import { createSubscriberFactory } from "@publicdomainrelay/hono-factory-xrpc-subscriber";
//   const { handleRequest } = createSubscriberFactory({ app: myHonoApp });
//   await createSubscriber({ keypair, getServiceAuthToken, dispatcherHost, handleRequest });

export interface RelayRequest {
  requestId: string;
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export interface RelayRequestResult {
  status: number;
  body: unknown;
  contentType: string;
}

// Minimal structural type for a Hono app (avoids a hard @hono/hono dep here;
// any object with a fetch(Request): Response works, including Hono).
export interface FetchApp {
  fetch(req: Request): Response | Promise<Response>;
}

export interface SubscriberFactoryOptions {
  app: FetchApp;
  /** Synthetic origin for the reconstructed Request. Default https://subscriber.local */
  baseOrigin?: string;
}

export interface SubscriberFactory {
  handleRequest(req: RelayRequest): Promise<RelayRequestResult>;
}

/**
 * Build a handleRequest that dispatches relay #request frames into a Hono app
 * via app.fetch(), then serializes the Response back to a #response frame.
 */
export function createSubscriberFactory(opts: SubscriberFactoryOptions): SubscriberFactory {
  const origin = opts.baseOrigin ?? "https://subscriber.local";

  return {
    async handleRequest(req: RelayRequest): Promise<RelayRequestResult> {
      const url = new URL(req.path, origin);
      for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);

      const init: RequestInit = { method: req.method, headers: req.headers };
      if (!["GET", "HEAD"].includes(req.method) && req.body != null) {
        init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }

      const res = await opts.app.fetch(new Request(url, init));
      const contentType = res.headers.get("content-type") ?? "application/json";
      const body = contentType.includes("application/json")
        ? await res.json().catch(() => null)
        : await res.text();

      return { status: res.status, body, contentType };
    },
  };
}
