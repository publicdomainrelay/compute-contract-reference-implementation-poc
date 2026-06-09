// @publicdomainrelay/compute — handler factories for the
// com.publicdomainrelay.temp.compute.* event payloads carried inside
// com.publicdomainrelay.temp.market.event records.
//
// A thin companion to @publicdomainrelay/market: the core library knows
// nothing about compute (a market.event just carries an opaque `payload`
// strongRef); this library defines what that payload means for compute
// contracts and the EventCallback factories that wrap it for
// createSubmitEventHandler's serviceId -> payload NSID routing table.
//
// Runs on Deno (see deno.json import map) and Node (see package.json).

export * from "./eventDelete.ts";
