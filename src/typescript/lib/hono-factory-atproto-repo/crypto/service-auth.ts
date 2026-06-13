// @publicdomainrelay/hono-factory-atproto-repo — service-auth JWT minting
//
// Mints atproto inter-service auth JWTs (the kind com.atproto.server.getServiceAuth
// returns) signed by the repo's own signing key. secp256k1 did:key → ES256K.
//
// Verifiers (e.g. lib/market/auth.browser.ts verifyJwt) check:
//   header.alg present, typ not at+/refresh+/dpop+jwt
//   payload.iss is a did, payload.aud string, payload.exp number, optional lxm
//   signature over `${b64url(header)}.${b64url(payload)}` verifies against iss key

import type { Bytes, Did, Signer } from "../contracts.ts";
import { base64Encode, utf8Encode } from "../util/bytes.ts";

function b64url(bytes: Bytes): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(utf8Encode(JSON.stringify(value)));
}

export interface ServiceAuthOptions {
  /** Audience DID the token is minted for (the service it will be sent to). */
  aud: Did;
  /** Lexicon method (NSID) the token authorizes, e.g. "com.example.doThing". */
  lxm?: string;
  /** Seconds until expiry (default 60). */
  expiresInSec?: number;
}

/**
 * Mint a service-auth JWT (ES256K) signed by `signer`. `iss` is the signer's
 * did:key. Mirrors the token shape produced by a real PDS getServiceAuth.
 */
export async function signServiceAuth(signer: Signer, opts: ServiceAuthOptions): Promise<string> {
  const iss = signer.did();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expiresInSec ?? 60);

  const header = { typ: "JWT", alg: "ES256K" };
  const payload: Record<string, unknown> = {
    iss,
    aud: opts.aud,
    iat: now,
    exp,
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
  if (opts.lxm) payload.lxm = opts.lxm;

  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await signer.sign(utf8Encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
