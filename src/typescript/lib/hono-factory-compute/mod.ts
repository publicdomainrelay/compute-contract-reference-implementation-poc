// @publicdomainrelay/hono-factory-compute — Hono factory for the
// com.publicdomainrelay.temp.compute.* event handlers.
//
// createComputeFactory() returns a typed Hono factory whose initApp mounts a
// single `POST /xrpc/…market.submitEvent` route pre-wired with the
// compute event dispatch table (vm.delete by default, plus any extras you
// supply). Plug this into a market Hono app alongside hono-factory-market.
//
// Usage:
//   const factory = createComputeFactory({
//     deps: marketDeps,
//     vmDelete: { assertRunningCompute, deleteRunningCompute },
//   })
//   const app = factory.createApp()
//   // POST /xrpc/…market.submitEvent is mounted for compute event dispatch

import { createFactory } from "hono/factory";
import type { EventCallbacks, MarketServerDeps } from "@publicdomainrelay/market";
import {
  createSubmitEventHandler,
  DEFAULT_COMPUTE_EVENT_SERVICE_ID,
  SUBMIT_EVENT_NSID,
} from "@publicdomainrelay/market";
import type { ComputeEventDeleteHandlerOptions } from "@publicdomainrelay/compute";
import {
  COMPUTE_EVENTS_VM_DELETE_NSID,
  createComputeEventDeleteHandler,
} from "@publicdomainrelay/compute";

export type { ComputeEventDeleteHandlerOptions };

export type ComputeEnv = {
  Variables: {
    marketDeps: MarketServerDeps;
  };
};

export interface ComputeFactoryOptions {
  deps: MarketServerDeps;
  /** Service-id for the compute-event service entry. Defaults to `DEFAULT_COMPUTE_EVENT_SERVICE_ID`. */
  serviceId?: string;
  /** Handler for `com.publicdomainrelay.temp.compute.events.vm.delete` events. */
  vmDelete: ComputeEventDeleteHandlerOptions;
  /**
   * Additional event callbacks keyed by payload NSID, merged under the same
   * service-id bucket as `vmDelete`.
   */
  extraCallbacks?: Record<string, EventCallbacks[string][string]>;
  /** When true, dispatch matched callbacks in the background and respond `200 { ok: true }` immediately. */
  background?: boolean;
}

/**
 * Create a typed Hono factory for compute event handling.
 *
 * Builds the submitEvent callback table from `vmDelete` (and any
 * `extraCallbacks`) under the configured `serviceId`, then mounts
 * `POST /xrpc/…market.submitEvent` in `initApp`.
 */
export function createComputeFactory(opts: ComputeFactoryOptions) {
  const serviceId = opts.serviceId ?? DEFAULT_COMPUTE_EVENT_SERVICE_ID;

  const callbacks: EventCallbacks = {
    [serviceId]: {
      [COMPUTE_EVENTS_VM_DELETE_NSID]: createComputeEventDeleteHandler(opts.vmDelete),
      ...opts.extraCallbacks,
    },
  };

  return createFactory<ComputeEnv>({
    initApp: (app) => {
      app.use(async (c, next) => {
        c.set("marketDeps", opts.deps);
        await next();
      });

      const h = createSubmitEventHandler({
        deps: opts.deps,
        callbacks,
        background: opts.background,
      });
      app.post(`/xrpc/${SUBMIT_EVENT_NSID}`, (c) => h(c.req.raw));
    },
  });
}
