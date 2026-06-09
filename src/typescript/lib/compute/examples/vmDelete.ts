// Example: handling compute.events.vm.delete teardown events.
//
// `createComputeEventDeleteHandler` builds the `EventCallback` you slot into
// `createSubmitEventHandler`'s routing table. It checks a resource is still
// tracked for the event's receipt, requires the token issuer to be the
// market.accept author (only the requester who settled may tear down), resolves
// the vm.delete payload, and hands off to your `deleteRunningCompute`.
//
// Run (from this directory):
//   deno run --allow-net --allow-env vmDelete.ts

import { IdResolver } from "@atproto/identity";
import { createRecordResolver, createSubmitEventHandler, DEFAULT_COMPUTE_EVENT_SERVICE_ID, SUBMIT_EVENT_NSID } from "@publicdomainrelay/market";
import { COMPUTE_EVENTS_VM_DELETE_NSID, createComputeEventDeleteHandler } from "../mod.ts";

const BASE_URL = Deno.env.get("BASE_URL") ?? "https://bidder.example";
const idResolver = new IdResolver();

// What the bidder tracked when it provisioned: receiptKey -> live resource.
type Contract = { dropletId: string };
const activeContracts = new Map<string, Contract>();

const vmDelete = createComputeEventDeleteHandler({
  // Short-circuit (return a HandlerResult) to refuse; return nothing to proceed.
  assertRunningCompute: ({ event, log }) => {
    const key = `${event.receipt.uri}#${event.receipt.cid}`;
    if (!activeContracts.has(key)) {
      log("warn", "no active contract for receipt", { key });
      return { status: 400, body: { error: "InvalidRequest", message: "unknown receipt" } };
    }
  },
  // Auth + payload resolution already done; just do the teardown.
  deleteRunningCompute: async ({ event, deleteEvent, log }) => {
    const key = `${event.receipt.uri}#${event.receipt.cid}`;
    const contract = activeContracts.get(key)!;
    log("info", "tearing down droplet", { dropletId: contract.dropletId, reason: deleteEvent.reason });
    // ...call your provider's delete here...
    activeContracts.delete(key);
    return { body: { ok: true } };
  },
});

const submitEvent = createSubmitEventHandler({
  deps: {
    hostname: new URL(BASE_URL).host,
    idResolver,
    resolve: createRecordResolver(idResolver),
    log: (level, msg, fields) => console.error(level, msg, fields ?? {}),
  },
  callbacks: {
    [DEFAULT_COMPUTE_EVENT_SERVICE_ID]: {
      [COMPUTE_EVENTS_VM_DELETE_NSID]: vmDelete,
    },
  },
});

Deno.serve((req) =>
  req.method === "POST" && new URL(req.url).pathname === `/xrpc/${SUBMIT_EVENT_NSID}`
    ? submitEvent(req)
    : new Response("not found", { status: 404 })
);
