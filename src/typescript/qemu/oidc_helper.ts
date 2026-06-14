/**
 * oidc_helper.ts — shim over @publicdomainrelay/oidc-helper.
 *
 * The OIDC implementation now lives in the standalone lib so it can be reused by
 * the local compute provider. This shim configures it with qemu's runtime issuer
 * URL (env) and sqlite-backed signing-key persistence, then re-exports the API so
 * existing `@publicdomainrelay/qemu/oidc_helper` importers keep working unchanged.
 */

import { configureOidc } from "@publicdomainrelay/oidc-helper";
import { getJwkPem, saveJwkPem } from "./database.ts";

configureOidc({
  getIssuerUrl: () =>
    Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? "http://localhost:8080",
  store: { getJwkPem, saveJwkPem },
});

export * from "@publicdomainrelay/oidc-helper";
