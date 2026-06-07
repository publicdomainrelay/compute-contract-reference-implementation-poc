# Compute Contract Reference Implementation PoC

> This is just a Proof of Concept to prove out the idea. Will be re-written once
> it all is organized in a way that makes sense and lexicon makes sense

Draft RFC: https://requested.fyi/d/did:plc:5svqtrhheairglgiiyvutzik/3mn3lewitmq2u

[![asciicast](https://asciinema.org/a/1199578.svg)](https://asciinema.org/a/1199578)


```mermaid
flowchart TD
    push_commit[push commit]

    subgraph fedproxy[fedproxy]
        rbac[RBAC]
        sshPublicKey[ssh public keys]
        atproto_workload_identity_reverse_proxy

        rbac -- determines createRecord ability --> atproto_workload_identity_reverse_proxy
        sshPublicKey -- posted via --> atproto_workload_identity_reverse_proxy
    end

    subgraph compute_provider[compute-provider]
        subgraph homelab
            droplet_oidc_poc_fork[droplet-oidc-poc fork]
            qemu

            droplet_oidc_poc_fork -- provides workload identity to --> qemu
        end
        subgraph digitalocean
            droplet_oidc_poc[droplet-oidc-poc]
            droplets

            droplet_oidc_poc -- provides workload identity to --> droplets
        end
    end

    subgraph bob
        subgraph bob_contract[compute-contract]
            bid
            receipt
        end

        subgraph builder
            firehose_consumer
            bidder
            receipt_issuance_endpoint
        end
    end

    subgraph alice
        subgraph tangled
            repo
        end
        subgraph spindle

            subgraph alice_contract[compute-contract]
                rfp
                accept
            end

            kick_off_workflow -- needs --> vm

            vm -- for policy engine, so create a--> rfp
            rfp -- await bids --> choose_winning_bid
            choose_winning_bid -- configure --> rbac
            atproto_workload_identity_reverse_proxy -- issue --> accept
            accept -- submitted to --> receipt_issuance_endpoint
            await_policy_engine -- submit workflow --> run_workflow
        end

        repo -- push triggers --> kick_off_workflow
    end

    push_commit --> repo

    rfp -- watched by --> firehose_consumer
    firehose_consumer --> bidder
    bidder -- submit --> bid
    bid --> choose_winning_bid
    bid -- wid config --> droplet_oidc_poc
    bid -- wid config --> droplet_oidc_poc_fork
    receipt_issuance_endpoint -- issue and return --> receipt

    droplets --> sshPublicKey
    qemu --> sshPublicKey

    receipt -- post ssh public key for fedproxy and start tunnel --> await_policy_engine
    run_workflow -- provide results --> repo
```
