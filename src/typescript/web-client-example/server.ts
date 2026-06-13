/**
 * web-client-example — atproto repo PDS server
 *
 * Stands up a Hono server with the @publicdomainrelay/hono-factory-atproto-repo
 * factory mounted, exposing the minimal atproto PDS repo surface:
 *
 *   GET  /xrpc/_health
 *   GET  /xrpc/com.atproto.server.describeServer
 *   GET  /.well-known/atproto-did
 *   *    /xrpc/com.atproto.repo.*           record CRUD over a signed MST
 *   GET  /xrpc/com.atproto.sync.subscribeRepos   firehose (WebSocket)
 *
 * Run:
 *   PORT=8080 deno run -A --watch server.ts
 *
 * Supply a stable signing key via REPO_PRIVATE_KEY_HEX; otherwise a fresh
 * secp256k1 keypair is generated each boot (the DID changes on restart).
 */

import { Secp256k1Keypair } from "@atproto/crypto";
import {
  createRepoFactory,
  MemoryStorage,
  signerFromKeypair,
  signerFromPrivateKeyHex,
} from "@publicdomainrelay/hono-factory-atproto-repo";

const PORT = parseInt(Deno.env.get("PORT") ?? "8080");
const PRIVATE_KEY_HEX = Deno.env.get("REPO_PRIVATE_KEY_HEX") ?? "";
const BASE_ORIGIN = Deno.env.get("BASE_ORIGIN") ?? `http://localhost:${PORT}`;

const signer = PRIVATE_KEY_HEX
  ? await signerFromPrivateKeyHex(PRIVATE_KEY_HEX)
  : signerFromKeypair(await Secp256k1Keypair.create({ exportable: true }));

const { app } = createRepoFactory({
  storage: new MemoryStorage(),
  signer,
  baseOrigin: BASE_ORIGIN,
});

Deno.serve({ port: PORT }, app.fetch);
console.log(JSON.stringify({
  event: "listening",
  port: PORT,
  did: signer.did(),
  baseOrigin: BASE_ORIGIN,
}));
