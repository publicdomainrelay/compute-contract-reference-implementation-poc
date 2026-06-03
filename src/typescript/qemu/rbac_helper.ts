/**
 * rbac_helper.ts — ATProto-backed RBAC (mirrors rbac_helper.py + main.go)
 *
 * Flow (same as main.go validateOIDCToken + checkRBACPolicy):
 *   1. Peek unverified aud → extract actx (DID or UUID) + api
 *   2. If actx is a DID: resolve PDS → fetch com.fedproxy.rbac records
 *   3. Collect trusted issuers from role.definition.iss
 *   4. Verify JWT against those issuers via OIDC discovery + JWKS
 *   5. Match verified sub against roles → collect policies
 *   6. Find best path schema → check capability enum
 */

import { OIDCToken, UnauthorizedException, parseAudience } from "./oidc_helper.ts";

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
}

interface RBACRecord {
  protects: Record<string, RBACProtects>;
  policies: Record<string, RBACPolicy>;
  roles: Record<string, RBACRole>;
}

// ---------------------------------------------------------------------------
// DID resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// com.fedproxy.rbac record fetch (paginated)
// ---------------------------------------------------------------------------

async function getRBACRecord(pdsURL: string, did: string, service: string, scope: string): Promise<RBACRecord> {
  const joined: RBACRecord = { policies: {}, roles: {} };
  let cursor = "";
  let total = 0;

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

  if (total === 0) throw new Error(`no com.fedproxy.rbac record found for did=${did}`);
  return joined;
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
    if (i === parts.length - 1) return rest === prefix;
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
// Full RBAC-validated token check (mirrors raiseIfUnauthorized in rbac_helper.py)
// ---------------------------------------------------------------------------

export async function raiseIfUnauthorized(
  // Service is FQDN of THIS_ENDPOINT, as that scopes to bob's builder vs. etc.
  service: string,
  // For xrpc methods the scope is the NSID
  scope: string,
  token: string,
  path: string,
  method: string,
  reqJson?: unknown,
): Promise<OIDCToken> {
  // Peek at aud to extract actx before we verify signature
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

  // If actx looks like a DID, resolve ATProto RBAC
  try {
    const { actx, api } = parseAudience(rawAud);
    if (actx.startsWith("did:")) {
      const pdsURL = await resolvePDS(actx);
      rbac = await getRBACRecord(pdsURL, actx, service, scope);
      const issuers = collectIssuers(rbac);
      getIssuers = async (_api: string, _actx: string) => issuers;
      void api; // used indirectly via getIssuers closure
    }
  } catch {
    // actx is not a DID or RBAC not found — fall through to own-issuer-only validation
  }

  const oidcToken = await OIDCToken.validate(token, getIssuers);

  if (rbac) {
    checkRBACPolicy(rbac, oidcToken.sub, path, method, reqJson);
  }

  return oidcToken;
}
