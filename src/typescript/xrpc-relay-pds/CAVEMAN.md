# ssh-wrapper + ssh-xrpc-factory + sshTest

## Files

| File | What |
|------|------|
| `ssh-wrapper.ts` | Wrap `ssh` with PTY alloc. `SSH_BIN_PATH` env → real ssh path. No TTY → `script -fqec` (Linux), `python3 pty.spawn()` (fallback), `ssh -tt` (last resort). TTY present → passthrough. |
| `ssh-session-manager.ts` | Spawn SSH under `script`, expose stdout/stderr as `ReadableStream`, stdin as `WritableStream`. Sessions keyed by UUID. Serialised stdin writes. Cleanup on exit. |
| `ssh-xrpc-factory.ts` | Hono factory. Two atproto XRPC endpoints: subscribe (WebSocket, streams SSH output) + write (POST JSON, feeds stdin). Serves `/.well-known/did.json`. Service-auth via `raiseIfUnauthorizedServiceAuth`. |
| `lexicons/com/publicdomainrelay/ssh/subscribe.json` | Subscription lexicon. Client sends connect params as first WS message, receives binary frames (byte 0=stdout, 1=stderr) + JSON control frames (ready/connected/exit/error). |
| `lexicons/com/publicdomainrelay/ssh/write.json` | Procedure lexicon. POST `{sessionId, data(base64)}` → `{written: N}`. |
| `sshTest.ts` | Integration test. Inject `ssh-wrapper.ts` as PATH `ssh` → launch VM via `runComputeContract` → internal `runSshSession` calls wrapper → PTY-allocated SSH session runs programmatic command. |

## Architecture

```
sshTest.ts
  │
  ├─ create tempdir + write PATH-intercepting `ssh` wrapper script
  │    └─ exec deno run -A ssh-wrapper.ts "$@"
  │
  ├─ createRequesterPDS()  →  PLC identity + relay registration
  ├─ startBidderIfNeeded()  →  in-process ephemeral bidder
  │
  └─ runComputeContract({vmName, execProgram, ...})
       │
       ├─ generateSshKeypair(tempdir) → cloud-init → VM created
       ├─ RFP → bid collection → accept
       ├─ pollSshReady → wait for SSH
       │
       └─ runSshSession(privateKeyPath, fqdn, execProgram)
            │
            └─ Deno.Command("ssh", tunnelArgs)
                 │
                 PATH resolves to TEMPDIR/ssh (wrapper script)
                   │
                   └─ deno run -A ssh-wrapper.ts <args>
                        │
                        ├─ [TTY?]  → direct passthrough
                        └─ [!TTY?] → script -fqec "ssh ..." /dev/null
                             │
                             └─ /usr/bin/ssh (real binary)
                                  │
                                  websocat ProxyCommand
                                  → wss://vm.fedproxy.com
                                  → sshd inside VM
```

## Run

### Quick test (from terminal, interactive shell)

```bash
CONTAINER_MODE=true START_BIDDER=true PORT=0 \
  deno run -A sshTest.ts --bid-window-sec 2 --vm-name test-01
```

Drops into interactive shell via PTY wrapper. `exit` to finish.

### Programmatic command (non-interactive)

```bash
# Pipe to /dev/null → no TTY → wrapper allocates PTY → command runs headless
CONTAINER_MODE=true START_BIDDER=true PORT=0 \
  deno run -A sshTest.ts --bid-window-sec 2 --cmd 'hostname && date && echo PASS' \
  </dev/null
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--vm-name <name>` | `sshtest-<random8>` | VM name |
| `--bid-window-sec <n>` | `5` | Seconds to wait for bids |
| `--cmd <command>` | `hostname && date && id` | Command to run via SSH (non-interactive mode only) |
| `--no-delete` | off | Keep VM + tempdir after test |
| `--vm-ready-timeout-sec <n>` | `300` | Max wait for SSH to come up |

### Env

| Var | Effect |
|-----|--------|
| `CONTAINER_MODE=true` | Use container runner instead of QEMU |
| `START_BIDDER=true` | Start ephemeral bidder in-process |
| `PORT=0` | Random port for PDS |
| `BIDDER_HANDLE_NNNN` | Additional bidder DIDs/handles |
| `DENY_BIDDER_HANDLE_NNNN` | Blocklist bidder DIDs/handles |

## Verify wrapper injection

Test logs `ssh_wrapper_injected` event with `wrapperPath` and `realSsh`. Confirm wrapper active:

```bash
# After test starts, check that the wrapper is on PATH:
cat $TEMPDIR/ssh
# Shows: #!/bin/sh \n exec deno run -A /path/to/ssh-wrapper.ts "$@"
```

## Cleanup

VM auto-deleted after SSH exit (unless `--no-delete`). Tempdir removed.

```bash
ls -la /tmp/ssh-wrapper-inject-*  # should be gone
```
