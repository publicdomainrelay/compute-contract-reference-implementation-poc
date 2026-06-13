export const AGENT_CLASS_NSID = "com.publicdomainrelay.temp.agent.class";
export const AGENT_SKILL_NSID = "com.publicdomainrelay.temp.agent.skill";
export const COMPUTE_VM_NSID = "com.publicdomainrelay.temp.compute.vm";
export const COMPUTE_CONFIG_WIF_SIMPLE_NSID = "com.publicdomainrelay.temp.compute.config.wif.simple";
export const COMPUTE_EVENTS_VM_DELETE_NSID = "com.publicdomainrelay.temp.compute.events.vm.delete";
export const BIDS_FREE_NSID = "com.publicdomainrelay.temp.market.bids.free";
export const ACCEPTS_FREE_NSID = "com.publicdomainrelay.temp.market.accepts.free";
export const RECEIPTS_FREE_NSID = "com.publicdomainrelay.temp.market.receipts.free";
export const BIDS_X402_NSID = "com.publicdomainrelay.temp.market.bids.x402";
export const ACCEPTS_X402_NSID = "com.publicdomainrelay.temp.market.accepts.x402";
export const RECEIPTS_X402_NSID = "com.publicdomainrelay.temp.market.receipts.x402";
export const RFP_NSID = "com.publicdomainrelay.temp.market.rfp";
export const BID_NSID = "com.publicdomainrelay.temp.market.bid";
export const ACCEPT_NSID = "com.publicdomainrelay.temp.market.accept";
export const RECEIPT_NSID = "com.publicdomainrelay.temp.market.receipt";
export const EVENT_NSID = "com.publicdomainrelay.temp.market.event";
export const OFFERING_NSID = "com.publicdomainrelay.temp.market.offering";
// network.attested.* — shared attestation vocabulary (replaces the former
// com.publicdomainrelay.temp.market.attestation record + #inline/#signatures defs).
export const NETWORK_ATTESTED_SIGNATURE_NSID = "network.attested.signature";
export const NETWORK_ATTESTED_PROOF_NSID = "network.attested.proof";
export const NETWORK_ATTESTED_VERIFY_NSID = "network.attested.verify";
// The $type stamped on an inline attestation entry is the bare signature nsid
// (its `main` def), so verifiers keyed on the network.attested union accept it.
export const ATTESTATION_INLINE_TYPE = NETWORK_ATTESTED_SIGNATURE_NSID;
export const SUBMIT_RFP_NSID = "com.publicdomainrelay.temp.market.submitRfp";
export const SUBMIT_BID_NSID = "com.publicdomainrelay.temp.market.submitBid";
export const SUBMIT_ACCEPT_NSID = "com.publicdomainrelay.temp.market.submitAccept";
export const SUBMIT_EVENT_NSID = "com.publicdomainrelay.temp.market.submitEvent";
export const SUBMIT_RFP_LXM = SUBMIT_RFP_NSID;
export const SUBMIT_BID_LXM = SUBMIT_BID_NSID;
export const SUBMIT_ACCEPT_LXM = SUBMIT_ACCEPT_NSID;
export const SUBMIT_EVENT_LXM = SUBMIT_EVENT_NSID;
export const DEFAULT_MARKET_SERVICE_ID = "pdr_temp_market";
export const DEFAULT_COMPUTE_EVENT_SERVICE_ID = "pdr_temp_compute_event";
export const BIDDER_REGISTRATION_NSID = "com.publicdomainrelay.temp.market.bidderRegistration";
export const REGISTER_BIDDER_NSID = "com.publicdomainrelay.temp.market.registerBidder";
export const REGISTER_BIDDER_LXM = REGISTER_BIDDER_NSID;
export const LIST_BIDDERS_NSID = "com.publicdomainrelay.temp.market.listBidders";
export const LIST_BIDDERS_LXM = LIST_BIDDERS_NSID;
export const BIDDER_DISCOVERY_NSID = "com.publicdomainrelay.temp.market.bidderDiscovery";
export const PACKAGE_REGISTRY_RESOLVE_NSID = "com.publicdomainrelay.temp.packageRegistry.resolve";
export const PACKAGE_REGISTRY_PACKAGE_NSID = "com.publicdomainrelay.temp.packageRegistry.package";
export const PACKAGE_REGISTRY_RELEASE_NSID = "com.publicdomainrelay.temp.packageRegistry.release";
