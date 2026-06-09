// Handler factory for com.publicdomainrelay.temp.compute.events.vm.delete
// market.event payloads, plugged into createSubmitEventHandler's callback
// routing table (callbacks[serviceId][payloadNsid]).

import { parseAtUri } from "@publicdomainrelay/market";
import type { EventCallback, EventDispatchContext, HandlerResult } from "@publicdomainrelay/market";
import type { Receipt, Resolved } from "@publicdomainrelay/market";
import type { VMDeleteEvent } from "@publicdomainrelay/lexicons";

export type { VMDeleteEvent };

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
