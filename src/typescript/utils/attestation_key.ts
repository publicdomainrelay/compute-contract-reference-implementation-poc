// Load-or-create a stable secp256k1 (k256) attestation private key, persisted as
// a JWK file next to the service. Returns the private key as hex, ready for
// @publicdomainrelay/market's loadOrGenerateKeypair(hex). A stable key (vs a
// fresh ephemeral one each restart) is what makes key→DID-document binding work:
// the same did:key is published in the service's did:web doc and reused across
// restarts, so a counterparty running with bindKeys can bind the signature.
//
// Zero external imports (Deno + Web Crypto only) so it loads from any workspace
// member by relative path without an import map. The file holds a private EC JWK
// `{kty:"EC", crv:"secp256k1", d:<base64url>}`; keep it out of version control.

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Read the private EC JWK at `jwkPath` and return its private scalar `d` as hex.
 * If the file does not exist, generate a fresh 32-byte k256 private key, write it
 * as a private JWK (mode 0600), and return its hex. A file that exists but is not
 * a valid secp256k1 private JWK throws rather than being overwritten.
 */
export async function loadOrCreateAttestationKeyHex(jwkPath: string | URL): Promise<string> {
  let text: string | undefined;
  try {
    text = await Deno.readTextFile(jwkPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  if (text !== undefined) {
    const jwk = JSON.parse(text) as { kty?: string; crv?: string; d?: string };
    if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || typeof jwk.d !== "string") {
      throw new Error(`${jwkPath}: not a secp256k1 private JWK (refusing to overwrite)`);
    }
    return bytesToHex(base64UrlDecode(jwk.d));
  }

  const priv = crypto.getRandomValues(new Uint8Array(32));
  const jwk = { kty: "EC", crv: "secp256k1", use: "sig", alg: "ES256K", d: base64UrlEncode(priv) };
  await Deno.writeTextFile(jwkPath, JSON.stringify(jwk, null, 2) + "\n");
  try {
    await Deno.chmod(jwkPath, 0o600);
  } catch {
    // chmod unsupported (e.g. some filesystems) — non-fatal.
  }
  return bytesToHex(priv);
}
