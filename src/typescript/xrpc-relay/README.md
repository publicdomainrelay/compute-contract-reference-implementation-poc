# XRPC Relay

# Motivation

Enable in-broswer clients to expose XRPC procedures that can be called by others
via [service proxying](https://atproto.com/specs/xrpc#service-proxying).

# Dragons Beware

Everytime you change service IDs you need a new did:key: because PDS service
proxying caches the DID Doc and we have no way of busting the cache.

This is the a cached call, you will not defeat the cache, just make a new key:

https://github.com/bluesky-social/atproto/blob/6847fc0d92499c87334b9768fc42efc012b7ac4a/packages/pds/src/pipethrough.ts#L294
