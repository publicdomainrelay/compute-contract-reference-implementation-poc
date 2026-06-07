# Compute Contract Reference Implementation PoC

> This is just a Proof of Concept to prove out the idea. Will be re-written once
> it all is organized in a way that makes sense and lexicon makes sense

Draft RFC: https://requested.fyi/d/did:plc:5svqtrhheairglgiiyvutzik/3mn3lewitmq2u

[![asciicast](https://asciinema.org/a/1199578.svg)](https://asciinema.org/a/1199578)

A decentralized compute marketplace on AT Protocol. A repo's CI pipeline is
auctioned to compute providers; the winning **bidder** provisions a VM that runs
the workflow. Identity, the auction, and the audit trail are all ATProto records;
authorization roots in DID resolution + JWT verification. Security analysis lives
in [THREATS.md](./THREATS.md); the record schemas live in
[`lexicons/`](./lexicons/README.md).

The two diagrams below are generated from the code under `src/typescript/`
(`spindle/`, `bidder/`, `qemu/`, `spindle-viewer-spa/`).

## Components

| Component | Code | Port | Role |
|-----------|------|------|------|
| **spindle** (alice) | `spindle/main.ts`, `marketRFP.ts` | `:8090` | CI backend. Watches knots/jetstream for `sh.tangled.pipeline` triggers, fetches `.github/workflows/*` at the commit SHA, and runs them on a **local policy engine** (default) **or** auctions them via the market (`COMPUTE_PROVIDER=market.rfp`). Fronted by Caddy (no auth). |
| **bidder** (bob) | `bidder/main.ts` | `:4021` | Market seller. Reacts to RFPs (`/hook/rfp`, `submitRfp`), creates bids, and on x402 settlement (`/receipt/*`) provisions a droplet through the RBAC-gated compute proxy. |
| **qemu / miniCloud** | `qemu/main.ts` + helpers | `:8080`/`:9000` | DigitalOcean-compatible API + OIDC issuer. RBAC-gates `/v1/oidc/issue`, `/v2/account`, `/v2/droplets*`; spawns QEMU VMs in Docker. |
| **fedproxy** | external ([atproto-reverse-proxy](https://github.com/publicdomainrelay/atproto-reverse-proxy)) | — | ATProto workload-identity reverse proxy. RBAC-gates `createRecord` (lets a booted VM register its SSH key) and routes `<svc>--<handle>.fedproxy.com` to the VM's policy engine. |
| **viewer** | `spindle-viewer-spa/` | static | Read-only SPA. Resolves a repo's `knot`/`spindle` via `listRecords`, then streams `wss://<spindle>/events` and `/logs`. |

Record types (all `com.publicdomainrelay.temp.*` pre-stable): `compute.vm`,
`compute.config.wif.simple`, `market.rfp`, `market.offering`, `market.bid`,
`market.bids.x402`, `market.accept`, `market.receipt` (+ XRPC `market.submitRfp`,
`market.submitBid`). Cross-org: `com.fedproxy.rbac`, `com.fedproxy.sshPublicKey`,
`sh.tangled.pipeline`, `sh.tangled.graph.vouch`.

## Architecture & data flow

```mermaid
flowchart TD
    push["git push commit"]

    subgraph alice["alice — repo owner / requester"]
        repo["tangled repo @ knot"]
        viewer["viewer SPA — read-only"]
        subgraph spindle["spindle — CI backend · :8090 · Caddy (no auth)"]
            trig["knot + jetstream watcher<br/>POST /trigger"]
            wf["fetch .github/workflows @ commit SHA"]
            mode{"COMPUTE_PROVIDER"}
            pe_local["local policy engine<br/>POLICY_ENGINE_URL :8080"]
            mkt["marketRFPSubmitWorkflow"]
            sbid["XRPC market.submitBid<br/>drains into pendingBids"]
        end
    end

    subgraph atproto["ATProto — PDS records + Jetstream firehose"]
        vm["compute.vm"]
        rfp["market.rfp"]
        offering["market.offering"]
        bid["market.bid"]
        cfg["compute.config.wif.simple"]
        x402["market.bids.x402"]
        accept["market.accept"]
        receipt["market.receipt"]
        rbac["com.fedproxy.rbac"]
        sshkey["com.fedproxy.sshPublicKey"]
    end

    subgraph bob["bob — compute provider / bidder · :4021"]
        hook["POST /hook/rfp<br/>POST xrpc submitRfp"]
        mkbid["createAndSubmitBid"]
        rcpt["GET /receipt/*<br/>x402-gated unless X402_MAKE_FREE"]
        mkdrop["createDroplet<br/>+ configureDropletRbac"]
    end

    subgraph fedproxy["fedproxy — atproto workload-identity reverse proxy"]
        fp_rbac["RBAC gate on createRecord"]
        fp_route["route svc--handle.fedproxy.com to VM"]
    end

    subgraph provider["compute provider — qemu / miniCloud · :8080/:9000"]
        oidc["OIDC issuer<br/>POST /v1/oidc/issue — RBAC droplets.wid<br/>POST /v1/oidc/prove — ssh host-key"]
        doapi["DO-compatible API<br/>/v2/account · /v2/droplets* — RBAC account.auth"]
        subgraph vmbox["VM / droplet — QEMU in Docker"]
            fpc["fedproxy-client.service"]
            peng["policy-engine.service"]
        end
    end

    %% triggering
    push --> repo
    repo -->|trigger| trig --> wf --> mode
    mode -->|default| pe_local
    mode -->|market.rfp| mkt

    %% records created by spindle (alice)
    mkt -->|create| vm
    mkt -->|create| rfp
    mkt -->|create| accept
    mkt -->|grant ssh-key-register| rbac

    %% bidder discovery + bidding
    mkt -->|discover vouches| offering
    mkt -->|submitRfp| hook
    rfp -.->|firehose webhook| hook
    hook --> mkbid
    mkbid -->|create| cfg
    mkbid -->|create| x402
    mkbid -->|create| bid
    mkbid -->|sendBid| sbid
    bid -.->|firehose| mkt
    sbid --> mkt

    %% settle + provision
    mkt -->|GET receipt| rcpt
    rcpt --> mkdrop
    mkdrop -->|grant droplets.wid + account.auth| rbac
    mkdrop -->|service-auth JWT| doapi
    doapi -->|spawnVM| vmbox
    rcpt -->|create| receipt

    %% workload identity + run
    fpc -->|prove ssh host-key| oidc
    fpc -->|register| fp_rbac --> sshkey
    sshkey -.->|firehose| mkt
    mkt -->|watch key then submit workflow| fp_route --> peng
    peng -->|results| repo

    %% viewer
    viewer -.->|listRecords| repo
    viewer -.->|wss events and logs| spindle
```

## End-to-end auction (`COMPUTE_PROVIDER=market.rfp`)

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Knot as tangled repo @ knot
    participant Spindle as spindle (alice)
    participant PDS as ATProto PDS + Jetstream
    participant Bidder as bidder (bob)
    participant Proxy as compute proxy (qemu OIDC + DO API)
    participant VM as VM / droplet

    Dev->>Knot: git push commit
    Knot->>Spindle: sh.tangled.pipeline trigger
    Spindle->>Knot: fetch .github/workflows at SHA
    Note over Spindle: default mode would POST to local POLICY_ENGINE_URL instead
    Spindle->>PDS: create compute.vm + market.rfp (sendBid back to spindle)
    Spindle->>PDS: discover vouched DIDs via sh.tangled.graph.vouch + offering
    Spindle->>Bidder: submitRfp to offering.endpointUrl
    Bidder->>PDS: create wif.simple config, x402 payload, market.bid
    Bidder->>Spindle: sendBid (xrpc submitBid), also seen on firehose
    Note over Spindle: bid window closes, score lowest cost, pick winner
    Spindle->>PDS: create market.accept + com.fedproxy.rbac (ssh-key-register)
    Spindle->>Bidder: GET /receipt/accept-uri/cid (x402 settlement)
    Bidder->>Bidder: resolve accept, bid, rfp, vm and check accept.rfp matches bid.rfp
    Bidder->>PDS: create com.fedproxy.rbac (droplets.wid + account.auth)
    Bidder->>Proxy: getServiceAuth then POST /v2/droplets (service-auth JWT)
    Proxy->>VM: spawnVM (QEMU in Docker), inject accept bundle into user_data
    Bidder->>PDS: create market.receipt
    VM->>Proxy: POST /v1/oidc/prove (ssh host-key signature over nonce)
    Proxy-->>VM: scoped OIDC token
    VM->>PDS: register com.fedproxy.sshPublicKey via fedproxy (RBAC-gated)
    PDS-->>Spindle: sshPublicKey for serviceName on jetstream
    Spindle->>VM: POST /request/create via svc--handle.fedproxy.com
    VM->>VM: run workflow
    VM-->>Knot: results
```
