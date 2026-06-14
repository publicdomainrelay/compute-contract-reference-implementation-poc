# Test Market Flow — Caveman Doc

Run full market flow. Get container. See hostname = work.

## Run

```bash
cd src/typescript/xrpc-relay-pds

DENY_BIDDER_HANDLE_0000=did:plc:5svqtrhheairglgiiyvutzik \
START_BIDDER=true \
PORT=0 \
CONTAINER_MODE=true \
timeout 200 \
deno run -A ./cli.ts --bid-window-sec 2 --exec hostname
```

Need: `docker`, network to `xrpc.fedproxy.com`, real TTY if want shell.

### Env / flags mean

| Thing | Mean |
|---|---|
| `START_BIDDER=true` | bidder run IN same process as cli (requester). one process both roles |
| `PORT=0` | random port. relay real transport anyway |
| `CONTAINER_MODE=true` | cloud-init + sshd container. no QEMU/KVM |
| `DENY_BIDDER_HANDLE_0000=<did>` | deny that bidder DID. test allowlist filter |
| `timeout 200` | kill after 200s. flow reach hostname ~50-60s. too short = die mid-provision |
| `--bid-window-sec 2` | wait 2s collect bids |
| `--exec hostname` | run `hostname` over SSH. no `--exec` = interactive shell (need real TTY) |

## What Happen When Run

1. **boot identities** — requester + bidder make did:plc, register XRPC relay → did:web proxyRef. bidder issuer up (`workload-identity issuer listening`, `serveHttp:false xrpcRelay:true`).
2. **offer + discover** — bidder make offering, register registry. requester discover bidders.
3. **RFP** — requester make compute.vm + market.rfp. submit to bidders.
4. **bid** — bidder make bid + bid config (`wif.simple`, carry `issuer_uri` = bidder relay URL). submit back.
5. **accept** — requester pick lowest cost winner. make market.accept.
6. **provision** (provider = bidder, `compute-provider-local`):
   - mint `com.fedproxy.rbac` in **provider repo**. sub `actx:<provider>:plc:<requester>:role:<role>`. scope `droplets.wid`. mirror DigitalOcean.
   - inject OIDC provision exchange in cloud-init. actx = provider.
   - `docker run` container (`pdr-<requester>-<rfp>-<rand>`). wait sshd.
7. **prove** — container boot, run `provisioning-token.sh`:
   - sign provisioning JWT with sshd host key. POST `/v1/oidc/prove`.
   - issuer verify SSH sig + nonce → droplet. issue scoped token. write `base_url`/`token`/`team_uuid` files.
8. **tunnel** — fedproxy-client get token `/v1/oidc/issue` (authorize against provider RBAC repo) → register service → `tunnel active`. SSH reachable at `compute-<name>--did-plc-<requester>.fedproxy.com`.
9. **receipt** — bidder make signed market.receipt. requester verify sig + bind. `receipt_verified ok:true`.
10. **ssh** — requester poll SSH thru relay. `vm_ssh_ready`. run `--exec` program. **print hostname** (= container id). `vm_ssh_session_exit code:0`.
11. **teardown** — requester submit `vm.delete` event. bidder `destroy` → `deleteRbacRecord` + `docker rm`.

## Know It Work

```
{"event":"rbac record created","uri":"at://did:plc:<provider>/com.fedproxy.rbac/..."}
{"event":"vm_ssh_ready","attempt":6}
<container-hostname>        <-- THIS. work.
{"event":"vm_ssh_session_exit","code":0}
```

See hostname (12 hex char) = full flow work.

## When Break

| Symptom | Mean |
|---|---|
| `vm_ssh_poll ... 404` loop forever | tunnel never up. check container `getting token` 401 |
| `401 no com.fedproxy.rbac records ... service=<issuer> scope=droplets.wid` | RBAC grant missing/wrong repo. actx mismatch |
| `401 sub must be scoped to actx:<x>` | token sub actx ≠ bearer actx. config `actx`/`actx_path` wrong |
| `timeout` kill before hostname | `timeout` too short. raise to 200s+. websocat download + cloud-init slow |
| no shell without `--exec` | stdin not TTY (`isTerminal()` false). run direct in terminal, not piped/bg |
| `vm_delete_result 502` + no destroy log | `START_BIDDER` in-process. cli exit kill async teardown. harness artifact, not bug |

## Watch Container

```bash
docker ps --format '{{.Names}}|{{.Status}}' | grep pdr-
C=$(docker ps -q --filter name=pdr- | head -1)
docker logs "$C" 2>&1 | grep -iE 'getting token|tunnel active|unauthorized|prove'
```

## Clean Up

```bash
docker ps -aq --filter name=pdr- | xargs -r docker rm -f
```

Do NOT `pkill -f "cli.ts"` — match own command line → self-kill (exit 144).

## Type Check (no run)

```bash
cd src/typescript
deno check lib/compute-provider-local/mod.ts \
  lib/hono-factory-workload-identity-droplet-oidc-poc/mod.ts \
  lib/hono-factory-compute-provider-local/mod.ts \
  lib/hono-factory-ephemeral-compute-bidder/mod.ts \
  xrpc-relay-pds/server.ts qemu/main.ts
```

Pre-existing error `Unknown export './com/atproto/repo/strongRef.defs.ts' for '@publicdomainrelay/lexicons'` (lib/market) = not your change. ignore.
