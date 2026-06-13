// @publicdomainrelay/ssh — runnable entry point for the compute-contract SSH flow.
//
// Usage:
//   deno run -A jsr:@publicdomainrelay/ssh [--vm-name foo] [--bid-window-sec 30] [--no-delete] [--exec bash]
//
// This is a thin wrapper that imports and runs the CLI from xrpc-relay-pds.
// All CLI arguments (Deno.args) pass through to the underlying runner.

import "@publicdomainrelay/xrpc-relay-pds/cli";
