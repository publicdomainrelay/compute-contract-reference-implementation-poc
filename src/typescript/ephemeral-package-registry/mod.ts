/**
 * ephemeral-package-registry — thin re-export wrapper for
 * @publicdomainrelay/hono-factory-package-registry with relay support.
 *
 * Usage:
 *   import { createEphemeralPackageRegistry } from "@publicdomainrelay/ephemeral-package-registry";
 *   const registry = await createEphemeralPackageRegistry({
 *     storeMode: "git",
 *     gitUrl: "https://github.com/owner/repo.git",
 *   });
 *   const { proxyRef } = await registry.ready;
 */

export { createEphemeralPackageRegistry } from "./main.ts";
export type {
  EphemeralPackageRegistryOptions,
  EphemeralPackageRegistry,
  StoreMode,
} from "./main.ts";
