/**
 * @publicdomainrelay/oidc-helper — OIDC token creation and validation.
 *
 * Extracted from qemu/oidc_helper.ts. Decoupled from qemu so it can be reused by
 * the local compute provider and others:
 *   - The issuer URL is read through an injected getter (configureOidc), not a
 *     module-level env const, so callers whose issuer is only known at runtime
 *     (e.g. after an XRPC-relay registers a did:web) can supply it lazily.
 *   - Signing-key persistence is delegated to an injected JwkStore so this lib
 *     never imports a concrete database.
 *
 * OIDCToken.create: sign RS256 JWT with audience "api://<api>?actx=<actx>"
 * OIDCToken.validate: peek aud → collect issuers → verify via JWKS discovery
 */

import * as jose from "jose";

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
// Injected configuration — issuer URL getter + signing-key persistence
// ---------------------------------------------------------------------------

/** Pluggable persistence for the issuer's signing key (PEM, keyed by issuer URL). */
export interface JwkStore {
  getJwkPem(issuer: string): string | null;
  saveJwkPem(issuer: string, pem: string): void;
}

// Default in-memory store — keeps the lib usable standalone (key lives for the
// process lifetime). Real deployments inject a persistent store via configureOidc.
function createMemoryStore(): JwkStore {
  const m = new Map<string, string>();
  return {
    getJwkPem: (issuer) => m.get(issuer) ?? null,
    saveJwkPem: (issuer, pem) => { m.set(issuer, pem); },
  };
}

let _getIssuerUrl: () => string = () =>
  Deno.env.get("ISSUER_URL") ?? Deno.env.get("THIS_ENDPOINT") ?? "http://localhost:8080";
let _store: JwkStore = createMemoryStore();
// SECURITY: bound the default token lifetime. Tokens minted without an explicit
// `ttl` previously defaulted to ~100 years (effectively non-expiring), so any
// leaked token stayed valid forever. Default to 24h; operators can tune via env.
let _defaultTtlSeconds = Number(Deno.env.get("OIDC_DEFAULT_TTL_SECONDS") ?? 60 * 60 * 24);

/**
 * Configure issuer URL resolution, signing-key persistence, and default TTL.
 * Call once at startup. Any field omitted keeps its current value.
 */
export function configureOidc(cfg: {
  getIssuerUrl?: () => string;
  store?: JwkStore;
  defaultTtlSeconds?: number;
}): void {
  if (cfg.getIssuerUrl) _getIssuerUrl = cfg.getIssuerUrl;
  if (cfg.store) _store = cfg.store;
  if (typeof cfg.defaultTtlSeconds === "number") _defaultTtlSeconds = cfg.defaultTtlSeconds;
}

// Returns true iff `sub` is scoped to `actx`. The subject format is
// `actx:<actx>[:role:...:...]`, so we require an exact match or an `actx:<actx>:`
// prefix rather than a loose substring test (which a crafted sub could satisfy).
export function subMatchesActx(sub: string | undefined, actx: string): boolean {
  if (!sub) return false;
  return sub === `actx:${actx}` || sub.startsWith(`actx:${actx}:`);
}

// ---------------------------------------------------------------------------
// Signing key — loaded from the store or auto-generated once
// ---------------------------------------------------------------------------

let _signingKey: CryptoKeyPair | null = null;
let _publicJwk: jose.JWK | null = null;

export async function getSigningKey(): Promise<CryptoKeyPair> {
  if (_signingKey) return _signingKey;

  const issuer = _getIssuerUrl();
  const storedPem = _store.getJwkPem(issuer);
  if (storedPem) {
    const pemBody = storedPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
    const priv = await crypto.subtle.importKey(
      "pkcs8", der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true, ["sign"],
    );
    const jwk = await jose.exportJWK(priv);
    const pubJwk = { ...jwk, d: undefined, dp: undefined, dq: undefined, p: undefined, q: undefined, qi: undefined };
    const pub = await crypto.subtle.importKey(
      "jwk", pubJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true, ["verify"],
    );
    _signingKey = { privateKey: priv, publicKey: pub };
  } else {
    _signingKey = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pem = await jose.exportPKCS8(_signingKey.privateKey);
    _store.saveJwkPem(issuer, pem);
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
  actx!: string;
  api!: string;
  aud!: string;
  sub!: string;
  claims!: Record<string, unknown>;
  asString!: string;

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
    const issuerUrl = _getIssuerUrl();
    let audience = `api://${api}?actx=${actx}`;

    const sub = claims["sub"] as string | undefined;
    if (!subMatchesActx(sub, actx)) {
      throw new Error(`'actx:${actx}' not found in sub '${sub}'`);
    }

    const payload = { ...claims };
    delete payload["ttl"];

    let expTime: string | number;
    if (typeof claims["ttl"] === "number") {
      expTime = Math.floor(Date.now() / 1000) + (claims["ttl"] as number);
    } else {
      expTime = Math.floor(Date.now() / 1000) + _defaultTtlSeconds;
    }

    if (typeof claims["aud"] === "string") {
      audience = claims["aud"];
    }

    const token = await new jose.SignJWT(payload as jose.JWTPayload)
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(issuerUrl)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expTime)
      .sign(keys.privateKey);

    return new OIDCToken({
      actx,
      api,
      aud: audience,
      sub: sub!,
      claims: { ...payload, iss: issuerUrl, aud: audience },
      asString: token,
    });
  }

  static async validate(
    token: string,
    getIssuers?: (api: string, actx: string) => Promise<string[]> | string[],
  ): Promise<OIDCToken> {
    if (!token || token === "0") throw new UnauthorizedException("Unable to authenticate you, no token");
    if (token.split(".").length !== 3) throw new UnauthorizedException("Invalid token");

    const issuerUrl = _getIssuerUrl();

    // Peek at unverified payload to extract actx + api from aud
    const unverified = jose.decodeJwt(token);
    const rawAud = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud as string;
    const { actx, api } = parseAudience(rawAud ?? "");
    const expectedAud = `api://${api}?actx=${actx}`;

    const ownIssuers = [issuerUrl];
    const extraIssuers = getIssuers ? await getIssuers(api, actx) : [];
    const issuers = [...new Set([...ownIssuers, ...extraIssuers])];

    let lastErr: Error = new Error("no issuers");
    for (const issuer of issuers) {
      try {
        let jwks: jose.JWTVerifyGetKey;
        if (issuer === issuerUrl) {
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
