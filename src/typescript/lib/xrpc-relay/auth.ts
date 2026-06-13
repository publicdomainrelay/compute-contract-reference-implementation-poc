import { verifySignature } from "npm:@atproto/crypto@^0.5.0";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@^1/base64";
import { IdResolver } from "npm:@atproto/identity@^0.5.0";
import { verifyJwt } from "npm:@atproto/xrpc-server@^0.11.1";

export interface RegistrationPayload {
  key?: string;
  nonce?: string;
  signatures?: Array<{ key?: string; signature?: string }>;
}

export interface NonceStore {
  issue(key: string): string;
  verify(reg: RegistrationPayload): Promise<{ ok: true; key: string } | { ok: false; reason: string }>;
}

export function createNonceStore(ttlMs: number): NonceStore {
  const issued = new Map<string, { key: string; expiresAt: number }>();
  return {
    issue(key: string): string {
      const bytes = new Uint8Array(64);
      crypto.getRandomValues(bytes);
      const nonce = encodeBase64(bytes);
      const now = Date.now();
      for (const [n, v] of issued) if (v.expiresAt < now) issued.delete(n);
      issued.set(nonce, { key, expiresAt: now + ttlMs });
      return nonce;
    },
    async verify(reg: RegistrationPayload) {
      if (!reg?.key || !reg?.nonce || !Array.isArray(reg?.signatures)) {
        return { ok: false, reason: "registration missing key/nonce/signatures" };
      }
      const entry = issued.get(reg.nonce);
      if (!entry) return { ok: false, reason: "unknown or expired nonce" };
      if (entry.expiresAt < Date.now()) {
        issued.delete(reg.nonce);
        return { ok: false, reason: "nonce expired" };
      }
      if (entry.key !== reg.key) return { ok: false, reason: "key does not match nonce issuance" };
      const nonceBytes = decodeBase64(reg.nonce);
      let verified = false;
      for (const sig of reg.signatures) {
        if (!sig?.key || !sig?.signature) continue;
        try {
          if (await verifySignature(sig.key, nonceBytes, decodeBase64(sig.signature))) {
            verified = true;
            break;
          }
        } catch { /* try next */ }
      }
      if (!verified) return { ok: false, reason: "no signature verifies over the nonce" };
      issued.delete(reg.nonce);
      return { ok: true, key: reg.key };
    },
  };
}

const sharedIdResolver = new IdResolver();

export async function verifyServiceAuth(
  authHeader: string | undefined,
  aud: string,
  lxm: string,
  tokenOverride?: string,
  idResolver = sharedIdResolver,
): Promise<{ iss: string }> {
  let token = tokenOverride;
  if (!token) {
    if (!authHeader) throw new Error("Missing Authorization header");
    const parts = authHeader.split(" ");
    token = parts[parts.length - 1];
  }
  if (!token) throw new Error("Missing bearer token");
  const payloadJson = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
    )
  );
  const iss = payloadJson.iss as string | undefined;
  if (!iss || !iss.startsWith("did:")) throw new Error("Token iss must be a DID");
  await verifyJwt(token, aud, lxm, async (did) => {
    if (did.startsWith("did:key:")) return did;
    return await idResolver.did.resolveAtprotoKey(did);
  });
  return { iss };
}
