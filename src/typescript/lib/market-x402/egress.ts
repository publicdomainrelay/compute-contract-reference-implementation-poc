// The SSRF egress guard is generic (not x402-specific) and now lives in the
// core library; re-exported here so existing `@publicdomainrelay/market-x402`
// importers of `assertSafeEgressUrl` / `EgressOptions` keep working unchanged.
export { assertSafeEgressUrl, type EgressOptions } from "../market/mod.ts";
