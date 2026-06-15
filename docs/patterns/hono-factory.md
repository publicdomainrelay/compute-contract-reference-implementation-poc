# Hono Factory Pattern

Typed Hono app factories with dependency injection, conditional route mounting, and framework-agnostic handlers.

## Where used

- `lib/hono-factory-market/mod.ts` — `createMarketFactory`
- `lib/hono-factory-xrpc-relay/mod.ts` — `createRelayFactory`
- `lib/hono-factory-compute/mod.ts` — `createComputeFactory`
- `lib/hono-factory-package-registry/mod.ts` — `createPackageRegistryFactory`
- `lib/hono-factory-atproto-repo/factory/factory.ts` — `createRepoFactory`
- `lib/hono-factory-did-plc-directory/mod.ts` — `createPlcDirectoryFactory`
- `lib/hono-factory-xrpc-subscriber/mod.ts` — `createSubscriberFactory`
- `lib/hono-factory-market-bids/mod.ts` — `createMarketBidsFactory`
- `lib/hono-factory-compute-provider-local/mod.ts` — `createComputeProviderLocalFactory`
- `lib/hono-factory-ephemeral-compute-bidder/mod.ts` — `createEphemeralBidder`
- `lib/hono-factory-workload-identity-droplet-oidc-poc/mod.ts` — `createWorkloadIdentityDropletOidcPoc`

## Core pattern

```ts
import { createFactory } from "hono/factory";

export function createXxxFactory(opts: XxxOptions) {
  return createFactory<XxxEnv>({
    initApp: (app) => {
      // 1. Middleware for dependency injection
      app.use(async (c, next) => {
        c.set("deps", deps);
        await next();
      });

      // 2. Conditional route mounting
      if (opts.handlers?.someFeature) {
        app.post("/xrpc/com.example.someFeature", handler);
      }

      // 3. Error middleware
      app.onError((err, c) => { ... });
    },
  });
}
// Consumer calls: const app = factory.createApp()
```

## Key conventions

1. **`createFactory<Env>({initApp})`** is the base Hono primitive. All hono-factory libs wrap it.

2. **Typed env** — each factory defines its own `Env` type with `Variables` for dependency injection:
   ```ts
   type MarketEnv = {
     Variables: { marketDeps: MarketServerDeps };
   };
   ```

3. **DI via middleware** — deps injected once in `initApp` via `c.set()`:
   ```ts
   app.use(async (c, next) => {
     c.set("marketDeps", deps);
     await next();
   });
   ```

4. **Conditional route mounting** — routes only mounted when handler config is supplied:
   ```ts
   if (handlers?.rfp) {
     const h = createSubmitRfpHandler({ deps, callbacks: handlers.rfp });
     app.post(`/xrpc/${SUBMIT_RFP_NSID}`, (c) => h(c.req.raw));
   }
   ```

5. **Framework-agnostic handlers** — inner handlers take `(req: Request) => Promise<Response>`, not Hono context. Hono routes wrap them: `(c) => handler(c.req.raw)`. This keeps domain logic portable across Deno.serve, Node, Hono, etc.

6. **Barrel re-exports** — `mod.ts` re-exports types + factory function. No default export.

7. **CORS + structured logging** — standard middleware stack in `initApp`:
   ```ts
   app.use("*", cors());
   app.use("*", async (c, next) => {
     log("info", { component: "relay", event: "request", method, path });
     await next();
   });
   ```

## When to use

- Building a new AT Protocol XRPC service
- Creating a server with multiple optional feature modules
- Need typed dependency injection without a DI framework
- Want to offer both a full-featured factory and manual route mounting

## Anti-patterns

- Don't put business logic in the factory's `initApp` — delegate to handler factories
- Don't read env vars inside the factory — accept opts, let the caller resolve env
- Don't export a singleton app — always return a factory so callers control lifecycle
