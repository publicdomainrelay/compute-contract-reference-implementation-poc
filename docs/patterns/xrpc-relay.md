# XRPC Relay (WebSocket Tunnel)

WebSocket-based relay that tunnels HTTP requests through a central dispatcher to subscribers behind NAT/firewalls, with subdomain routing, nonce-based registration, and service auth.

## Where used

- `lib/hono-factory-xrpc-relay/mod.ts` — `createRelayFactory` (relay server)
- `lib/hono-factory-xrpc-subscriber/mod.ts` — `createSubscriberFactory` (subscriber bridge)
- `lib/xrpc-relay-pds/` — standalone relay + subscriber implementations
- `lib/hono-factory-workload-identity-droplet-oidc-poc/mod.ts` — `startRelay()` (subscriber side)
- `lib/hono-factory-ephemeral-compute-bidder/mod.ts` — `runSubscriber` (subscriber side)
- `ephemeral-package-registry/main.ts` — `runSubscriber` (subscriber side)

## Architecture

```
┌──────────────┐     WebSocket      ┌──────────────┐     HTTP      ┌──────────────┐
│  Subscriber  │◀──────────────────▶│    Relay     │◀─────────────▶│   Caller     │
│  (bidder,    │   subscribe NSID   │  (dispatcher │  subdomain    │  (browser,   │
│   registry,  │                    │   xrpc.fed   │  proxy        │   client)    │
│   compute)   │                    │   proxy.com) │               │              │
└──────────────┘                    └──────────────┘               └──────────────┘
```

## Relay server

```ts
// lib/hono-factory-xrpc-relay/mod.ts
export function createRelayFactory(opts: RelayFactoryOptions) {
  const state = new RelayState({ relayTimeoutMs, reconnectGraceMs });
  const nonceStore = createNonceStore(nonceTtlMs);

  return createFactory({
    initApp: (app) => {
      // 1. did:web document
      app.get("/.well-known/did.json", ...);

      // 2. getRegistrationNonce — issue nonce for did:key challenge
      app.post(`/xrpc/${GET_NONCE_NSID}`, ...);

      // 3. subscribe WebSocket — subscriber registers + stays connected
      app.get(`/xrpc/${SUBSCRIBE_NSID}`, upgradeWebSocket(...));

      // 4. Caller WebSocket subscription relay — intercept WS at subdomains
      app.get("/xrpc/*", upgradeWebSocket(...));

      // 5. Universal subdomain relay — all other HTTP requests proxied
      app.all("*", async (c) => {
        // Extract subdomain from Host header
        // Dispatch request to subscriber, await response
      });
    },
  });
}
```

## Registration flow

```
Subscriber                          Relay
  │                                   │
  │ 1. POST getRegistrationNonce      │
  │    { key: "did:key:z..." }        │
  │─────────────────────────────────▶ │  nonceStore.issue(key)
  │◀───────────────────────────────── │  { nonce, signatures: [] }
  │                                   │
  │ 2. Sign nonce with did:key        │
  │    Connect WebSocket with:        │
  │    ?did=did:key:z...&registration=│
  │     {key,nonce,signatures:[{key,  │
  │      signature}]}                 │
  │─────────────────────────────────▶ │  nonceStore.verify(reg)
  │                                   │  state.subscribers.set(subdomain, ws)
  │◀───────────────────────────────── │  { $type: "#registered", subdomain, proxyRef }
  │                                   │
  │ 3. Subscriber now reachable at:   │
  │    https://<subdomain>.relay.host │
```

## Subscriber side

```ts
// lib/hono-factory-xrpc-subscriber/mod.ts
export function createSubscriberFactory(opts: { app: Hono }) {
  return {
    handleRequest: (relayReq: RelayRequest) => {
      // Reconstruct a web-standard Request from relay frame
      const url = `https://${host}${relayReq.path}?${params}`;
      const req = new Request(url, { method, headers, body });
      // Dispatch into the Hono app
      return opts.app.fetch(req);
    },
  };
}
```

`RelayRequest` frame:
```ts
interface RelayRequest {
  $type: "com.publicdomainrelay.temp.xrpc.relay.subscribe#request";
  requestId: string;
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}
```

## Subdomain routing

Relay uses `Host` header to route to the correct subscriber:

```
Host: <subdomain>.xrpc.fedproxy.com
       │          └── relay hostname
       └── subscriber's subdomain (derived from did:key)
```

Subdomain derived from DID: `did:key:zDnaemb...` → `zdnaemb` subdomain.

## Subscription relay (WebSocket proxying)

Callers can open WebSocket connections through the relay to a subscriber's subscription endpoints (e.g., AT Protocol firehose):

```
Caller                     Relay                    Subscriber
  │                         │                         │
  │ WS connect to:          │                         │
  │ wss://<sub>.relay.host  │                         │
  │ /xrpc/com.atproto.      │                         │
  │   sync.subscribeRepos   │                         │
  │───────────────────────▶ │                         │
  │                         │ #subscribe frame        │
  │                         │───────────────────────▶ │
  │                         │                         │
  │                         │ #subscriptionEvent      │
  │                         │◀─────────────────────── │
  │◀─────────────────────── │  (relayed events)       │
  │                         │                         │
```

## Relay state machine

`RelayState` manages:
- `subscribers` — Map<subdomain, WebSocket> of active subscriber connections
- `activeSubscriptions` — Map<subscriptionId, {callerWs, subdomain, nsid}> 
- `reconnectQueue` — buffered messages for disconnected subscribers (grace period)
- `dispatchRequest` — sends `#request` frame to subscriber, returns promise for `#response`
- Timeout + cleanup for stale subscribers

## Key design decisions

1. **Nonce-based registration** — prevents replay attacks. Nonce must be signed by the same `did:key` that connects the WebSocket.

2. **Subdomain routing** — no path-based tenant identification. Each subscriber gets a unique subdomain derived from its DID.

3. **WS upgrade interception** — relay inspects `Upgrade: websocket` header at subdomains to distinguish subscription relay from regular HTTP proxying.

4. **Service auth on subscribe** — subscriber must present a valid service-auth JWT to connect (or pass `service_auth` query param).

5. **Reconnect grace** — disconnected subscribers get a grace period where queued messages are delivered on reconnect.

## When to use

- Exposing local/dev services behind NAT/firewalls
- Multi-tenant SaaS where each tenant runs their own server
- AT Protocol services that need a public `did:web` endpoint

## Don't use for

- High-throughput data streaming (WebSocket proxying adds latency)
- Direct client-to-server calls when server has a public IP
- Replacing a proper reverse proxy (nginx/caddy) for production traffic
