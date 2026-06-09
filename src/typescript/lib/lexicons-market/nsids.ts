// NSID constants for com.publicdomainrelay.temp.market.*

export const RFP_NSID = "com.publicdomainrelay.temp.market.rfp";
export const BID_NSID = "com.publicdomainrelay.temp.market.bid";
export const ACCEPT_NSID = "com.publicdomainrelay.temp.market.accept";
export const RECEIPT_NSID = "com.publicdomainrelay.temp.market.receipt";
export const EVENT_NSID = "com.publicdomainrelay.temp.market.event";
export const OFFERING_NSID = "com.publicdomainrelay.temp.market.offering";

export const SUBMIT_RFP_NSID = "com.publicdomainrelay.temp.market.submitRfp";
export const SUBMIT_BID_NSID = "com.publicdomainrelay.temp.market.submitBid";
export const SUBMIT_ACCEPT_NSID = "com.publicdomainrelay.temp.market.submitAccept";
export const SUBMIT_EVENT_NSID = "com.publicdomainrelay.temp.market.submitEvent";

// lxm aliases — identical to the procedure NSIDs, named for clarity at JWT-verifier call sites.
export const SUBMIT_RFP_LXM = SUBMIT_RFP_NSID;
export const SUBMIT_BID_LXM = SUBMIT_BID_NSID;
export const SUBMIT_ACCEPT_LXM = SUBMIT_ACCEPT_NSID;
export const SUBMIT_EVENT_LXM = SUBMIT_EVENT_NSID;

// Conventional service-id fragments for the bidder's did:web document.
export const DEFAULT_MARKET_SERVICE_ID = "pdr_temp_market";
export const DEFAULT_COMPUTE_EVENT_SERVICE_ID = "pdr_temp_compute_event";
