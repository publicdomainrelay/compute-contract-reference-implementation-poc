// @publicdomainrelay/attestation — badge.blue (https://badge.blue) attestation
// helpers: compute attestation CIDs, create/verify inline signatures embedded in
// a record's `signatures` array, create/verify remote attestation proof records,
// and bind did:keys to DIDs for verification.
//
// The market.* records in this repo carry badge.blue attestations: producers
// inline-sign at creation (see @publicdomainrelay/market's createSignedRecord)
// and receipts are remote attestation proofs over their subject record.

export * from "./types.ts";
export * from "./bytes.ts";
export * from "./cid.ts";
export * from "./inline.ts";
export * from "./remote.ts";
export * from "./keys.ts";
