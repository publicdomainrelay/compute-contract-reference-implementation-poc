/**
 * oidc_helper.ts — OIDC token creation and validation (mirrors oidc_helper.py)
 *
 * OIDCToken.create: sign RS256 JWT with audience "api://<api>?actx=<actx>"
 * OIDCToken.validate: peek aud → collect issuers → verify via JWKS discovery
 */

import * as jose from "npm:jose@5";
import { getJwkPem, saveJwkPem } from "./database.ts";

export class UnauthorizedException extends Error {
  constructor(msg: string) { super(msg); this.name = "UnauthorizedException"; }
}

export interface OIDCTokenData {
  actx: string;
  api: string;
  aud: string;
  sub: string;
  claims: Record<string, unknown>;
  asString: string;
}

// ---------------------------------------------------------------------------
// Signing key — loaded from DB or auto-generated once
// ---------------------------------------------------------------------------

const ISSUER_URL = Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? "http://localhost:8080";

let _signingKey: CryptoKeyPair | null = null;
let _publicJwk: jose.JWK | null = null;

export async function getSigningKey(): Promise<CryptoKeyPair> {
  if (_signingKey) return _signingKey;

  const storedPem = getJwkPem(ISSUER_URL);
  if (storedPem) {
    const pemBody = storedPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
    const priv = await crypto.subtle.importKey(
      "pkcs8", der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true, ["sign"],
    );
    const jwk = await jose.exportJWK(priv);
    const pub = await jose.importJWK({ ...jwk, d: undefined }, "RS256") as CryptoKey;
    _signingKey = { privateKey: priv, publicKey: pub };
  } else {
    _signingKey = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pem = await jose.exportPKCS8(_signingKey.privateKey);
    saveJwkPem(ISSUER_URL, pem);
  }
  return _signingKey;
}

export async function getPublicJwk(): Promise<jose.JWK> {
  if (_publicJwk) return _publicJwk;
  const keys = await getSigningKey();
  const jwk = await jose.exportJWK(keys.publicKey);
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.kid = await jose.calculateJwkThumbprint(jwk);
  _publicJwk = jwk;
  return _publicJwk;
}

// ---------------------------------------------------------------------------
// JWKS cache for remote issuers
// ---------------------------------------------------------------------------

const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getRemoteJwks(jwksUri: string) {
  if (!jwksCache.has(jwksUri)) {
    jwksCache.set(jwksUri, jose.createRemoteJWKSet(new URL(jwksUri)));
  }
  return jwksCache.get(jwksUri)!;
}

// ---------------------------------------------------------------------------
// Audience parsing: "api://<api>?actx=<actx>"
// ---------------------------------------------------------------------------

export function parseAudience(aud: string): { actx: string; api: string } {
  const rest = aud.startsWith("api://") ? aud.slice(6) : null;
  if (!rest) throw new UnauthorizedException(`aud does not start with api://: ${aud}`);
  const qIdx = rest.indexOf("?");
  if (qIdx < 0) throw new UnauthorizedException(`aud missing ?actx=: ${aud}`);
  const api = rest.slice(0, qIdx);
  const params = new URLSearchParams(rest.slice(qIdx + 1));
  const actx = params.get("actx");
  if (!actx) throw new UnauthorizedException(`aud missing actx param: ${aud}`);
  return { actx, api };
}

// ---------------------------------------------------------------------------
// OIDCToken
// ---------------------------------------------------------------------------

export class OIDCToken implements OIDCTokenData {
  actx: string;
  api: string;
  aud: string;
  sub: string;
  claims: Record<string, unknown>;
  asString: string;

  private constructor(data: OIDCTokenData) {
    Object.assign(this, data);
  }

  static async create(
    actx: string,
    claims: Record<string, unknown>,
    api = "DigitalOcean",
  ): Promise<OIDCToken> {
    const keys = await getSigningKey();
    const jwk = await getPublicJwk();
    const audience = `api://${api}?actx=${actx}`;

    const sub = claims["sub"] as string | undefined;
    if (!sub || !sub.includes(`actx:${actx}`)) {
      throw new Error(`'actx:${actx}' not found in sub '${sub}'`);
    }

    const payload = { ...claims };
    delete payload["ttl"];

    let expTime: string | number;
    if (typeof claims["ttl"] === "number") {
      expTime = Math.floor(Date.now() / 1000) + (claims["ttl"] as number);
    } else {
      expTime = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 100;
    }

    const token = await new jose.SignJWT(payload as jose.JWTPayload)
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(ISSUER_URL)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expTime)
      .sign(keys.privateKey);

    return new OIDCToken({
      actx,
      api,
      aud: audience,
      sub: sub!,
      claims: { ...payload, iss: ISSUER_URL, aud: audience },
      asString: token,
    });
  }

  static async validate(
    token: string,
    getIssuers?: (api: string, actx: string) => Promise<string[]> | string[],
  ): Promise<OIDCToken> {
    if (!token || token === "0") throw new UnauthorizedException("Unable to authenticate you, no token");
    if (token.split(".").length !== 3) throw new UnauthorizedException("Invalid token");

    // Peek at unverified payload to extract actx + api from aud
    const unverified = jose.decodeJwt(token);
    const rawAud = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud as string;
    const { actx, api } = parseAudience(rawAud ?? "");
    const expectedAud = `api://${api}?actx=${actx}`;

    const ownIssuers = [ISSUER_URL];
    const extraIssuers = getIssuers ? await getIssuers(api, actx) : [];
    const issuers = [...new Set([...ownIssuers, ...extraIssuers])];

    let lastErr: Error = new Error("no issuers");
    for (const issuer of issuers) {
      try {
        let jwks: jose.JWTVerifyGetKey;
        if (issuer === ISSUER_URL) {
          const keys = await getSigningKey();
          jwks = keys.publicKey as unknown as jose.JWTVerifyGetKey;
        } else {
          const openidConfig = await fetch(`${issuer}/.well-known/openid-configuration`).then((r) => r.json()) as { jwks_uri: string };
          jwks = getRemoteJwks(openidConfig.jwks_uri);
        }

        const { payload } = await jose.jwtVerify(token, jwks, {
          issuer,
          audience: expectedAud,
        });

        return new OIDCToken({
          actx,
          api,
          aud: expectedAud,
          sub: payload.sub!,
          claims: payload as Record<string, unknown>,
          asString: token,
        });
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw new UnauthorizedException(`OIDC token failed validation: ${lastErr.message}`);
  }
}
