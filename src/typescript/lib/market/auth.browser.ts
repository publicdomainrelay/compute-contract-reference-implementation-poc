// Browser-safe re-implementation of auth.ts — same public API, no Node deps.
// Replaces the @atproto/xrpc-server verifyJwt import with an inline version
// that uses TextEncoder / atob instead of Buffer.

import * as crypto from "@atproto/crypto";
import type { IdResolver } from "@atproto/identity";

function isDidString(s: string): boolean {
  return /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/.test(s);
}

// ---- base64url helpers (no Buffer) ----------------------------------------

function b64urlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const s = padded + "=".repeat(pad);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function b64urlToJson(b64: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64)));
}

function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---- minimal error type ----------------------------------------------------

class AuthError extends Error {
  constructor(msg: string, public code: string) {
    super(msg);
  }
}

// ---- JWT payload type ------------------------------------------------------

type JwtPayload = {
  iss: string;
  aud: string;
  exp: number;
  lxm?: string;
  [k: string]: unknown;
};

// ---- verifyJwt (browser-safe) ----------------------------------------------

async function verifyJwt(
  jwtStr: string,
  ownDid: string | null,
  lxm: string | null,
  getSigningKey: (iss: string, forceRefresh: boolean) => Promise<string>,
): Promise<JwtPayload> {
  const parts = jwtStr.split(".");
  if (parts.length !== 3) throw new AuthError("poorly formatted jwt", "BadJwt");

  const header = b64urlToJson(parts[0]) as Record<string, unknown>;
  if (!header || typeof header.alg !== "string")
    throw new AuthError("poorly formatted jwt", "BadJwt");
  if (header["typ"] === "at+jwt" || header["typ"] === "refresh+jwt" || header["typ"] === "dpop+jwt")
    throw new AuthError(`Invalid jwt type "${header["typ"]}"`, "BadJwtType");

  const payload = b64urlToJson(parts[1]) as JwtPayload;
  if (
    !payload ||
    typeof payload.iss !== "string" ||
    typeof payload.aud !== "string" ||
    typeof payload.exp !== "number"
  )
    throw new AuthError("poorly formatted jwt", "BadJwt");

  if (Date.now() / 1000 > payload.exp) throw new AuthError("jwt expired", "JwtExpired");
  if (ownDid !== null && payload.aud !== ownDid)
    throw new AuthError("jwt audience does not match service did", "BadJwtAudience");
  if (lxm !== null && payload.lxm !== lxm)
    throw new AuthError(
      payload.lxm !== undefined
        ? `bad jwt lexicon method ("lxm"). must match: ${lxm}`
        : `missing jwt lexicon method ("lxm"). must match: ${lxm}`,
      "BadJwtLexiconMethod",
    );

  if (!payload.iss || !isDidStringOrService(payload.iss))
    throw new AuthError("jwt iss is not a valid did", "BadJwtIss");

  const msgBytes = strToBytes(parts.slice(0, 2).join("."));
  const sigBytes = b64urlToBytes(parts[2]);
  const alg = header.alg as string;

  const verify = async (key: string) =>
    crypto.verifySignature(key, msgBytes, sigBytes, { jwtAlg: alg, allowMalleableSig: true });

  const signingKey = await getSigningKey(payload.iss, false);
  let valid = await verify(signingKey).catch(() => false);
  if (!valid) {
    const freshKey = await getSigningKey(payload.iss, true);
    valid = freshKey !== signingKey ? await verify(freshKey).catch(() => false) : false;
  }
  if (!valid) throw new AuthError("jwt signature does not match jwt issuer", "BadJwtSignature");

  return payload;
}

function isDidStringOrService(value: string): boolean {
  const hashIdx = value.indexOf("#");
  if (hashIdx === -1) return isDidString(value);
  const fragmentLen = value.length - hashIdx - 1;
  if (fragmentLen < 1 || value.includes("#", hashIdx + 1)) return false;
  return isDidString(value.slice(0, hashIdx));
}

// ---- public API (mirrors auth.ts) ------------------------------------------

export function extractBearer(header: string | undefined | null): string {
  const m = /^Bearer (.+)$/.exec((header ?? "").trim());
  if (!m) throw new Error("missing or malformed Authorization Bearer header");
  return m[1];
}

export function serviceDidForHost(hostname: string): string {
  return `did:web:${hostname}`;
}

export type ServiceAuthResult = {
  issuerDid: string;
  audience: string;
  serviceId?: string;
};

export type VerifyMarketServiceAuthOptions = {
  authHeader: string | undefined | null;
  hostname: string;
  lxm: string;
  serviceIds: string[];
  idResolver: IdResolver;
};

export async function verifyMarketServiceAuth(
  opts: VerifyMarketServiceAuthOptions,
): Promise<ServiceAuthResult> {
  const { authHeader, hostname, lxm, serviceIds, idResolver } = opts;
  const token = extractBearer(authHeader);
  const serviceDid = serviceDidForHost(hostname);

  const payload = await verifyJwt(token, null, lxm, (did: string) =>
    idResolver.did.resolveAtprotoKey(did),
  );

  const acceptable = new Map<string, string | undefined>();
  acceptable.set(serviceDid, undefined);
  for (const id of serviceIds) acceptable.set(`${serviceDid}#${id}`, id);

  const aud = (payload as Record<string, unknown>).aud as string | undefined;
  if (aud === undefined || !acceptable.has(aud)) {
    throw new Error(
      `unexpected audience ${aud ?? "(none)"}; expected ${[...acceptable.keys()].join(" or ")}`,
    );
  }

  const iss = (payload as Record<string, unknown>).iss as string | undefined;
  if (!iss || !iss.startsWith("did:")) throw new Error("service auth token missing DID issuer");

  return { issuerDid: iss.split("#")[0], audience: aud, serviceId: acceptable.get(aud) };
}

export type VerifyServiceAuthOptions = VerifyMarketServiceAuthOptions;
export const verifyServiceAuth = verifyMarketServiceAuth;
