// Embedded lexicon docs for the four market.* submit procedures. Used by
// XrpcClient to validate/encode outbound calls without needing the repo's
// /lexicons tree at runtime.

import {
  SUBMIT_ACCEPT_NSID,
  SUBMIT_BID_NSID,
  SUBMIT_EVENT_NSID,
  SUBMIT_RFP_NSID,
} from "./nsids.ts";

// deno-lint-ignore no-explicit-any
export const marketLexicons: any[] = [
  {
    lexicon: 1,
    id: SUBMIT_RFP_NSID,
    defs: {
      main: {
        type: "procedure",
        input: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["rfpUri", "rfpCid"],
            properties: {
              rfpUri: { type: "string" },
              rfpCid: { type: "string" },
            },
          },
        },
        output: { encoding: "application/json" },
      },
    },
  },
  {
    lexicon: 1,
    id: SUBMIT_BID_NSID,
    defs: {
      main: {
        type: "procedure",
        input: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["uri", "cid", "record"],
            properties: {
              uri: { type: "string" },
              cid: { type: "string" },
              record: { type: "unknown" },
            },
          },
        },
        output: { encoding: "application/json" },
      },
    },
  },
  {
    lexicon: 1,
    id: SUBMIT_ACCEPT_NSID,
    defs: {
      main: {
        type: "procedure",
        input: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["acceptUri", "acceptCid"],
            properties: {
              acceptUri: { type: "string" },
              acceptCid: { type: "string" },
            },
          },
        },
        output: { encoding: "application/json" },
      },
    },
  },
  {
    lexicon: 1,
    id: SUBMIT_EVENT_NSID,
    defs: {
      main: {
        type: "procedure",
        input: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["uri", "cid", "record"],
            properties: {
              uri: { type: "string" },
              cid: { type: "string" },
              record: { type: "unknown" },
            },
          },
        },
        output: { encoding: "application/json" },
      },
    },
  },
];
