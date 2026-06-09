// Handler factory for com.publicdomainrelay.temp.compute.events.vm.delete
// market.event payloads, plugged into createSubmitEventHandler's callback
// routing table (callbacks[serviceId][payloadNsid]).
//
// Domain logic — whether a droplet is still tracked for the receipt and how to
// tear it down — stays the caller's concern via `assertRunningCompute` /
// `deleteRunningCompute`; this factory owns the shared authorization rule: only
// the DID that issued the market.accept settling the contract may submit a
// vm.delete for it (the library already verified the token issuer authored the
// event record itself, so a third party can't forge someone else's teardown).

import { parseAtUri } from "../market/resolve.ts";
import type { EventCallback, EventDispatchContext, HandlerResult } from "../market/server.ts";
import type { Receipt, Resolved } from "../market/types.ts";

/** com.publicdomainrelay.temp.compute.events.vm.delete payload. */
export type VMDeleteEvent = {
  reason: string;
};

/**
 * Checked before authorization/teardown. Return a `HandlerResult` to short-
 * circuit with that response (e.g. "unknown receipt"); return/resolve to
 * `undefined` to continue.
 */
export type AssertRunningCompute = (ctx: EventDispatchContext) => Promise<HandlerResult> | HandlerResult;

/** Tears down the droplet (and any associated bookkeeping) for the receipt. */
export type DeleteRunningCompute = (
  ctx: EventDispatchContext & { deleteEvent: Resolved<VMDeleteEvent> },
) => Promise<HandlerResult> | HandlerResult;

export interface ComputeEventDeleteHandlerOptions {
  assertRunningCompute: AssertRunningCompute;
  deleteRunningCompute: DeleteRunningCompute;
}

/**
 * Builds the `EventCallback` for vm.delete events: validates a droplet is
 * still tracked for the receipt, requires the token issuer to be the
 * market.accept author, then resolves the vm.delete payload and hands off to
 * `deleteRunningCompute`.
 */
export function createComputeEventDeleteHandler(opts: ComputeEventDeleteHandlerOptions): EventCallback {
  const { assertRunningCompute, deleteRunningCompute } = opts;

  return async (ctx) => {
    const { event, issuerDid, resolve, log } = ctx;
    const receiptKey = `${event.receipt.uri}#${event.receipt.cid}`;

    const notRunningResponse = await assertRunningCompute(ctx);
    if (notRunningResponse) {
      return notRunningResponse;
    }

    const receipt = await resolve.resolve<Receipt>(event.receipt);
    const acceptAuthor = parseAtUri(receipt.accept.uri).repo;
    if (issuerDid !== acceptAuthor) {
      log("warn", "submitEvent rejected: token issuer is not the market.accept author", { iss: issuerDid, acceptAuthor, receiptKey });
      return { status: 403, body: { error: "Forbidden", message: "only the market.accept issuer may delete" } };
    }

    const deleteEvent = await resolve.resolve<VMDeleteEvent>(event.payload);
    return await deleteRunningCompute({ ...ctx, deleteEvent });
  };
}
