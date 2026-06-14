/**
 * @publicdomainrelay/rbac-helper — ATProto-backed RBAC.
 *
 * Extracted from qemu/rbac_helper.ts. The only change from the original is the
 * oidc import path (now @publicdomainrelay/oidc-helper). Issuer URL is not held
 * here: callers pass the service/issuer explicitly to raiseIfUnauthorized*, and
 * OIDCToken.validate resolves the local issuer through oidc-helper's own getter.
 *
 * Flow (same as main.go validateOIDCToken + checkRBACPolicy):
 *   1. Peek unverified aud → extract actx (DID or UUID) + api
 *   2. If actx is a DID: resolve PDS → fetch com.fedproxy.rbac records
 *   3. Collect trusted issuers from role.definition.iss
 *   4. Verify JWT against those issuers via OIDC discovery + JWKS
 *   5. Match verified sub against roles → collect policies
 *   6. Find best path schema → check capability enum
 *
 * ATProto service auth path (non-OIDC):
 *   If token iss is a DID (com.atproto.server.getServiceAuth tokens):
 *   1. Resolve issuer DID document
 *   2. Verify JWT signature against verificationMethod keys
 *   3. Fetch com.fedproxy.rbac from issuer's PDS
 *   4. Check policy
 */

import { OIDCToken, UnauthorizedException, parseAudience } from "@publicdomainrelay/oidc-helper";
import { IdResolver } from '@atproto/identity';
import { verifyJwt } from '@atproto/xrpc-server'
import * as jose from "jose";

function log(
  level: "info" | "error" | "warn",
  msg: string,
  extra?: Record<string, unknown>,
) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  Deno.stderr.writeSync(new TextEncoder().encode(JSON.stringify(entry) + "\n"));
}

// ---------------------------------------------------------------------------
// Shared auth token shape returned by both OIDC and ATProto paths
// ---------------------------------------------------------------------------

export interface AuthToken {
  sub: string;
  actx: string;
  asString: string;
  claims: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ATProto types
// ---------------------------------------------------------------------------

interface RBACPolicy {
  meta: Record<string, string>;
  schemas: Record<string, RBACSchema>;
}

interface RBACSchema {
  properties: {
    capability: { enum: string[] };
    body?: unknown;
  };
}

interface RBACRoleDefinition {
  iss: string;
  aud?: string;
  sub: string;
  policies: string[];
}

interface RBACRole {
  role_name: string;
  definition: RBACRoleDefinition;
}

interface RBACProtects {
  service: string;
  scope?: string;
}

export interface RBACRecord {
  protects: Record<string, RBACProtects>;
  policies: Record<string, RBACPolicy>;
  roles: Record<string, RBACRole>;
}

interface ServiceAllowlistRecord {
  protects: Record<string, RBACProtects>;
  allowed: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// DID resolution
// ---------------------------------------------------------------------------

interface DIDDocument {
  service?: { id: string; type: string; serviceEndpoint: string }[];
  verificationMethod?: { id: string; type: string; publicKeyJwk?: jose.JWK; publicKeyMultibase?: string }[];
}

async function resolveDIDDoc(did: string): Promise<DIDDocument> {
  let res: Response;
  if (did.startsWith("did:plc:")) {
    res = await fetch(`https://plc.directory/${did}`);
  } else if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).replace(/:/g, "/");
    res = await fetch(`https://${host}/.well-known/did.json`);
  } else {
    throw new Error(`unsupported DID method: ${did}`);
  }
  if (!res.ok) throw new Error(`DID resolution failed for ${did}: ${res.status}`);
  return await res.json() as DIDDocument;
}

async function resolvePDS(did: string): Promise<string> {
  let didDoc: { service?: { id: string; type: string; serviceEndpoint: string }[] };

  if (did.startsWith("did:plc:")) {
    const res = await fetch(`https://plc.directory/${did}`);
    if (!res.ok) throw new Error(`plc.directory lookup failed for ${did}: ${res.status}`);
    didDoc = await res.json();
  } else if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).replace(/:/g, "/");
    const res = await fetch(`https://${host}/.well-known/did.json`);
    if (!res.ok) throw new Error(`did:web lookup failed for ${did}: ${res.status}`);
    didDoc = await res.json();
  } else {
    throw new Error(`unsupported DID method: ${did}`);
  }

  const pds = didDoc.service?.find(
    (s) => s.type === "AtprotoPersonalDataServer" || s.id === "#atproto_pds",
  )?.serviceEndpoint;
  if (!pds) throw new Error(`no PDS in DID document for ${did}`);
  return pds;
}

// Initialize the official ATProto Identity Resolver.
// This handles caching, did:plc resolution (via plc.directory), and did:web resolution.
const idResolver = new IdResolver();

// Derive did:web: from the service base URL for use as getServiceAuth aud.
function urlToDid(url: string): string {
  const host = new URL(url).host;
  return `did:web:${host}`;
}

// ---------------------------------------------------------------------------
// ATProto service auth JWT validation (non-OIDC)
// Validates com.atproto.server.getServiceAuth tokens against DID doc keys.
// ---------------------------------------------------------------------------
export async function validateATProtoServiceAuth(
  token: string,
  service: string,
): Promise<{ iss: string; sub: string; payload: jose.JWTPayload }> {
  // 1. Parse token quickly to read the issuer (iss)
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new UnauthorizedException("Invalid JWT format");
  }

  const payloadJson = JSON.parse(
    new TextDecoder().decode(jose.base64url.decode(parts[1]))
  );
  const iss = payloadJson.iss as string | undefined;
  if (!iss || !iss.startsWith("did:")) {
    throw new UnauthorizedException("ATProto service auth token must have DID iss");
  }

  const aud = urlToDid(service);
  log("info", "aud", { aud: aud, service: service, payloadJson: payloadJson });

  try {
    // 2. Resolve the DID Document & verify the signature using @atproto/identity.
    // verifyJwt handles:
    //   - Resolving the DID Document (using plc.directory or did:web lookup)
    //   - Safely parsing publicKeyMultibase (secp256k1/k256, ed25519) and publicKeyJwk formats
    //   - Cryptographically verifying the token signature
    const payload = await verifyJwt(token, aud, null,  async (did) => {
      const didDoc = await idResolver.did.resolveAtprotoKey(did);
      return didDoc; // Returns the verification key string directly
    });

    // 3. Extract subject (sub) and return
    const sub = ((payload as Record<string, unknown>).sub as string | undefined) ?? iss;
    return { iss, sub, payload };
  } catch (error: any) {
    throw new UnauthorizedException(
      `ATProto JWT validation failed: ${error.message || error}`
    );
  }
}

// ---------------------------------------------------------------------------
// com.fedproxy.rbac record fetch (paginated)
// ---------------------------------------------------------------------------

export async function getRBACRecord(pdsURL: string, did: string, service: string, scope: string): Promise<RBACRecord> {
  const joined: RBACRecord = { protects: {}, policies: {}, roles: {} };
  let cursor = "";
  let total = 0;

  let anyProtects = false;
  for (;;) {
    const url = new URL(`${pdsURL}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", "com.fedproxy.rbac");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`listRecords failed pds=${pdsURL} did=${did}: ${res.status}`);

    const out = await res.json() as { records: { uri: string; value: RBACRecord }[]; cursor?: string };

    for (const rec of out.records ?? []) {
      const rbac = rec.value;
      let protectsThis = false;
      for (const [name, protects] of Object.entries(rbac.protects ?? {})) {
        if (protects.service === service || protects.service === "*") {
          if (protects.scope === scope || protects.scope === "*") {
            protectsThis = true;
          }
          break;
        }
      }
      if (protectsThis !== true) {
        continue;
      } else {
        anyProtects = true;
      }
      for (const [name, policy] of Object.entries(rbac.policies ?? {})) {
        joined.policies[name] = policy;
      }
      for (const [name, role] of Object.entries(rbac.roles ?? {})) {
        joined.roles[name] = role;
      }
      total++;
    }

    if (!out.cursor) break;
    cursor = out.cursor;
  }

  if (anyProtects === false) throw new Error(`no com.fedproxy.rbac records found which protect for did=${did} service=${service} scope=${scope}`);

  if (total === 0) throw new Error(`no com.fedproxy.rbac record found for did=${did}`);
  return joined;
}

// ---------------------------------------------------------------------------
// com.publicdomainrelay.temp.auth.allowlist.rbacDid record fetch (paginated)
// Lets a service operator restrict which issuer DIDs may call a given
// service+scope, independent of the issuer's own RBAC grant.
// ---------------------------------------------------------------------------

async function getServiceAllowlist(pdsURL: string, did: string, service: string, scope: string): Promise<ServiceAllowlistRecord> {
  const joined: ServiceAllowlistRecord = { protects: {}, allowed: {} };
  let cursor = "";
  let total = 0;

  let anyProtects = false;
  for (;;) {
    const url = new URL(`${pdsURL}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", "com.publicdomainrelay.temp.auth.allowlist.rbacDid");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`listRecords failed pds=${pdsURL} did=${did}: ${res.status}`);

    const out = await res.json() as { records: { uri: string; value: ServiceAllowlistRecord }[]; cursor?: string };

    for (const rec of out.records ?? []) {
      const allowlist = rec.value;
      let protectsThis = false;
      for (const [name, protects] of Object.entries(allowlist.protects ?? {})) {
        if (protects.service === service || protects.service === "*") {
          if (protects.scope === scope || protects.scope === "*") {
            protectsThis = true;
          }
          break;
        }
      }
      if (protectsThis !== true) {
        continue;
      } else {
        anyProtects = true;
      }
      for (const [name, dids] of Object.entries(allowlist.allowed ?? {})) {
        joined.allowed[name] = dids;
      }
      total++;
    }

    if (!out.cursor) break;
    cursor = out.cursor;
  }

  if (anyProtects === false) throw new Error(`no com.publicdomainrelay.temp.auth.allowlist.rbacDid records found which protect for did=${did} service=${service} scope=${scope}`);

  if (total === 0) throw new Error(`no com.publicdomainrelay.temp.auth.allowlist.rbacDid record found for did=${did}`);
  return joined;
}

function checkAllowedToUseService(
  allowlist: ServiceAllowlistRecord,
  iss: string,
): void {
  for (const dids of Object.values(allowlist.allowed)) {
    if (dids.includes(iss)) return;
  }
  throw new UnauthorizedException(`unable to authorize: issuer ${iss} is not on the operator's service allowlist`);
}

// ---------------------------------------------------------------------------
// Issuer collection (mirrors collectIssuers in main.go)
// ---------------------------------------------------------------------------

function collectIssuers(rbac: RBACRecord): string[] {
  const seen = new Set<string>();
  for (const role of Object.values(rbac.roles)) {
    const iss = role.definition.iss;
    if (iss) seen.add(iss);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Path glob matching (mirrors globMatch in main.go / find_matching_schema_for_path)
// ---------------------------------------------------------------------------

function globMatch(pattern: string, s: string): boolean {
  if (pattern === "*") return true;
  const parts = pattern.split("*");
  let rest = s;
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts[i];
    if (i === parts.length - 1) return prefix === "" ? true : rest.endsWith(prefix);
    if (prefix.length > 0) {
      const idx = rest.indexOf(prefix);
      if (idx < 0) return false;
      rest = rest.slice(idx + prefix.length);
    }
  }
  return true;
}

function findMatchingSchema(schemas: Record<string, RBACSchema>, path: string): RBACSchema | null {
  if (schemas[path]) return schemas[path];
  let best = "";
  let bestSchema: RBACSchema | null = null;
  for (const [pattern, schema] of Object.entries(schemas)) {
    if (globMatch(pattern, path) && pattern.length > best.length) {
      best = pattern;
      bestSchema = schema;
    }
  }
  return bestSchema;
}

// ---------------------------------------------------------------------------
// Policy check (mirrors checkRBACPolicy in main.go + check_permissions in hcl_policy.py)
// ---------------------------------------------------------------------------

const HTTP_METHOD_CAPABILITY: Record<string, string> = {
  GET: "read", HEAD: "read", OPTIONS: "read",
  POST: "create", PUT: "update", PATCH: "update", DELETE: "delete",
};

export function checkRBACPolicy(
  rbac: RBACRecord,
  sub: string,
  path: string,
  method: string,
  reqJson?: unknown,
): void {
  const capability = HTTP_METHOD_CAPABILITY[method.toUpperCase()];
  if (!capability) throw new UnauthorizedException(`unsupported HTTP method ${method}`);

  const matchingPolicies: string[] = [];
  for (const role of Object.values(rbac.roles)) {
    if (role.definition.sub === sub) {
      matchingPolicies.push(...role.definition.policies);
    }
  }

  if (matchingPolicies.length === 0) {
    throw new UnauthorizedException(`no matching role found for sub: ${sub}`);
  }

  const denials: string[] = [];
  for (const policyName of matchingPolicies) {
    const policy = rbac.policies[policyName];
    if (!policy) continue;

    const schema = findMatchingSchema(policy.schemas, path);
    if (!schema) continue;

    const allowed = schema.properties.capability.enum;
    if (allowed.includes(capability)) return; // permitted

    denials.push(`policy '${policyName}': capability '${capability}' not in [${allowed.join(", ")}] for path '${path}'`);
  }

  if (denials.length > 0) throw new UnauthorizedException(denials.join("; "));
  throw new UnauthorizedException(`no policy covers path='${path}' for sub='${sub}'`);
}

// ---------------------------------------------------------------------------
// OIDC flow: raiseIfUnauthorized (scope: droplets.wid, /v1/oidc/issue)
// ---------------------------------------------------------------------------

export async function raiseIfUnauthorized(
  service: string,
  scope: string,
  token: string,
  path: string,
  method: string,
  reqJson?: unknown,
): Promise<AuthToken> {
  const unverifiedPayload = (() => {
    try {
      const [, payloadB64] = token.split(".");
      return JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return {};
    }
  })();

  const rawAud = Array.isArray(unverifiedPayload.aud)
    ? unverifiedPayload.aud[0]
    : unverifiedPayload.aud as string ?? "";

  let rbac: RBACRecord | null = null;
  let getIssuers: ((api: string, actx: string) => Promise<string[]>) | undefined;

  let { actx, api } = parseAudience(rawAud);
  if (actx.startsWith("did:plc:") || actx.startsWith("did:web:")) {
    // Already a fully-qualified DID — nothing to prepend.
  } else if (actx.includes(".")) {
    // did:web:
    actx = "did:web:" + actx
  } else {
    // did:plc:
    actx = "did:plc:" + actx
  }

  try {
    const pdsURL = await resolvePDS(actx);
    rbac = await getRBACRecord(pdsURL, actx, service, scope);
    const issuers = collectIssuers(rbac);
    getIssuers = async (_api: string, _actx: string) => issuers;
    void api;
  } catch (err) {
    // SECURITY: fail closed. This previously returned an empty AuthToken (`{}`),
    // which made the calling middleware treat the request as authorized while
    // skipping BOTH OIDC token validation AND the RBAC policy check below — an
    // authentication/authorization bypass on the privileged /v1/oidc/issue
    // endpoint (which mints OIDC tokens that grant droplet creation). If we
    // cannot resolve the actx DID or load its com.fedproxy.rbac record, we have
    // no basis on which to authorize the caller, so deny the request.
    log("error", "failed to lookup rbac record", { actx: actx, err: String(err) });
    throw new UnauthorizedException(`unable to authorize: rbac lookup failed for actx=${actx}: ${String(err)}`);
  }

  const oidcToken = await OIDCToken.validate(token, getIssuers);

  if (rbac) {
    checkRBACPolicy(rbac, oidcToken.sub, path, method, reqJson);
  }

  return oidcToken as AuthToken;
}

// ---------------------------------------------------------------------------
// ATProto service auth flow: raiseIfUnauthorizedServiceAuth
// (scope: account.auth, /v2/account + /v2/droplets*)
// Tokens are com.atproto.server.getServiceAuth JWTs: iss=DID, validated via
// DID document verificationMethod keys — no OIDC discovery used.
// ---------------------------------------------------------------------------

export async function raiseIfUnauthorizedServiceAuth(
  service: string,
  scope: string,
  // Source from OPERATOR_HANDLE env var somewhere up call stack
  operatorHandle: string,
  token: string,
  path: string,
  method: string,
): Promise<AuthToken> {
  // Get the incoming token data
  const { iss, sub, payload } = await validateATProtoServiceAuth(token, service);

  // Check if the OPERATOR_HANDLE trusts the token via our allowlist
  let operatorDid = operatorHandle;
  if (!operatorDid.startsWith("did:")) {
    const resolved = await idResolver.handle.resolve(operatorHandle);
    if (!resolved) throw new UnauthorizedException(`unable to resolve operator handle: ${operatorHandle}`);
    operatorDid = resolved;
  }
  const operatorPdsURL = await resolvePDS(operatorDid);
  // checkAllowedToUseService calls listRecords for
  // com.publicdomainrelay.temp.auth.allowlist.rbacDid
  // where each record has properties protects{service, scope} and allowed:
  // [dids], join together similar to RBACRecord and validate that the iss is a
  // did which the operator of this service wants to be able to call routes here
  const allowlist = await getServiceAllowlist(operatorPdsURL, operatorDid, service, scope);
  checkAllowedToUseService(allowlist, iss);

  // Check if the token issuer wants to enable their token to access these
  // routes
  const pdsURL = await resolvePDS(iss);
  const rbac = await getRBACRecord(pdsURL, iss, service, scope);
  checkRBACPolicy(rbac, sub, path, method);
  let actx = iss;
  if (actx.includes(":")) {
    const actxSplit = actx.split(":")
    actx = actxSplit[actxSplit.length - 1];
  }
  const result = { sub, actx: actx, asString: token, claims: payload as Record<string, unknown> };
  log("info", "raiseIfUnauthorizedServiceAuth.result", result);
  return result;
}
