# XRPC Relay

# Motivation

Enable in-broswer clients to expose XRPC procedures that can be called by others
via [service proxying](https://atproto.com/specs/xrpc#service-proxying).

# Dragons Beware

Everytime you change service IDs you need a new did:key: because PDS service
proxying caches the DID Doc and we have no way of busting the cache.

This is the a cached call, you will not defeat the cache, just make a new key:

https://github.com/bluesky-social/atproto/blob/6847fc0d92499c87334b9768fc42efc012b7ac4a/packages/pds/src/pipethrough.ts#L294

## Load test

3 subscribers, 500 concurrent callers, 30s duration. 12,849 events, 428 evt/s. 0 failures.

| Subscribers | Callers | Duration | Events | Evt/s | Success |
|-------------|---------|----------|--------|-------|---------|
| 3           | 15      | 15s      | 225    | 15    | 100%    |
| 5           | 100     | 30s      | 2,907  | 97    | 100%    |
| 10          | 500     | 30s      | 12,849 | 428   | 100%    |

Run: `DISPATCHER_HOST=xrpc-test.fedproxy.com deno run -A load-test.ts --subscribers N --callers-per M --duration S`
