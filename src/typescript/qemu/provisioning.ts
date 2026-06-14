/**
 * provisioning.ts — shim over
 * @publicdomainrelay/hono-factory-workload-identity-droplet-oidc-poc/provisioning.
 *
 * The provisioning implementation moved into the workload-identity poc package
 * (so it no longer depends on qemu). This shim wires its nonce persistence to
 * qemu's sqlite database and re-exports the API for existing
 * `@publicdomainrelay/qemu/provisioning` importers.
 */

import { configureProvisioning } from "@publicdomainrelay/hono-factory-workload-identity-droplet-oidc-poc/provisioning";
import { createProvisioningNonce, getProvisioningNonceDropletId } from "./database.ts";

configureProvisioning({
  nonceStore: { createProvisioningNonce, getProvisioningNonceDropletId },
});

export * from "@publicdomainrelay/hono-factory-workload-identity-droplet-oidc-poc/provisioning";
