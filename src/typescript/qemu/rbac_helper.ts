/**
 * rbac_helper.ts — shim over @publicdomainrelay/rbac-helper.
 *
 * The RBAC implementation now lives in the standalone lib. It holds no
 * issuer/config state of its own (callers pass service/issuer explicitly), so
 * this shim simply re-exports the API for existing
 * `@publicdomainrelay/qemu/rbac_helper` importers.
 */

export * from "@publicdomainrelay/rbac-helper";
