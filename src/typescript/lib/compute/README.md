# @publicdomainrelay/compute

Handler factories for the `com.publicdomainrelay.temp.compute.*` event payloads
that ride inside `com.publicdomainrelay.temp.market.event` records — a companion
to [`@publicdomainrelay/market`](../market/README.md).

The core market library routes a `submitEvent` by `serviceId → payload NSID` and
hands your callback the resolved `market.event`. This library provides the
callback for the payloads compute cares about, starting with **vm.delete**
(teardown).

It also re-exports the compute lexicon types and NSID constants
(`@publicdomainrelay/lexicons-compute`): `ComputeVM`, `ComputeConfigWifSimple`,
`VMDeleteEvent`, `COMPUTE_VM_NSID`, `COMPUTE_EVENTS_VM_DELETE_NSID`, …

## vm.delete

`createComputeEventDeleteHandler` builds the `EventCallback` you slot into
`createSubmitEventHandler`. It:

1. calls your `assertRunningCompute` (return a `HandlerResult` to refuse, e.g.
   "unknown receipt"; return nothing to proceed),
2. resolves the event's `receipt` and requires the inter-service-auth token
   issuer to be the **market.accept author** — only the requester who settled the
   contract may tear it down,
3. resolves the `vm.delete` payload and hands off to your `deleteRunningCompute`.

```ts
import { COMPUTE_EVENTS_VM_DELETE_NSID, createComputeEventDeleteHandler } from "./mod.ts";
import { createSubmitEventHandler, DEFAULT_COMPUTE_EVENT_SERVICE_ID } from "../market/mod.ts";

const submitEvent = createSubmitEventHandler({
  deps,
  callbacks: {
    [DEFAULT_COMPUTE_EVENT_SERVICE_ID]: {
      [COMPUTE_EVENTS_VM_DELETE_NSID]: createComputeEventDeleteHandler({
        assertRunningCompute: ({ event }) => {
          if (!tracked(event.receipt)) return { status: 400, body: { error: "InvalidRequest", message: "unknown receipt" } };
        },
        deleteRunningCompute: async ({ event, deleteEvent }) => {
          await provider.deleteVm(lookup(event.receipt), deleteEvent.reason);
          return { body: { ok: true } };
        },
      }),
    },
  },
});
```

## Examples

[`examples/vmDelete.ts`](./examples/vmDelete.ts) is a complete, self-contained
`submitEvent` server that tracks contracts in a `Map` and tears them down:

```
deno run --allow-net --allow-env examples/vmDelete.ts
```

## Runtimes

Same as the core library: Deno via the `deno.json` import map; Node via a TS-aware
loader or bundler that preserves `.ts` specifiers. Runtime code uses only
web-standard types plus `@atproto/*`. In this repo it imports the core library by
relative path (`../market/mod.ts`); published standalone it depends on
`@publicdomainrelay/market`.
