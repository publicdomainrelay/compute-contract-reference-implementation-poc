/**
 * database.ts — SQLite-backed persistence (mirrors database.py)
 *
 * Tables: jwks, provisioning_nonces, oauth_tokens
 *
 * Env: DATABASE_URI — sqlite:///path/to/app.db or postgresql://...
 *      Falls back to app.db next to this file.
 */

import { Database } from "jsr:@db/sqlite@^0.12";
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1";

const dbUri = Deno.env.get("DATABASE_URI") ?? "";
let dbPath: string;
if (dbUri.startsWith("sqlite:///")) {
  dbPath = dbUri.slice("sqlite:///".length);
} else if (dbUri.startsWith("sqlite://")) {
  dbPath = dbUri.slice("sqlite://".length);
} else {
  const here = dirname(fromFileUrl(import.meta.url));
  dbPath = join(here, "app.db");
}

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS jwks (
    issuer TEXT PRIMARY KEY,
    pem    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provisioning_nonces (
    nonce      TEXT PRIMARY KEY,
    droplet_id INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    actx  TEXT PRIMARY KEY,
    token TEXT NOT NULL
  );
`);

// ---------------------------------------------------------------------------
// JWK PEM
// ---------------------------------------------------------------------------

export function saveJwkPem(issuer: string, pem: string): void {
  db.prepare("INSERT OR REPLACE INTO jwks (issuer, pem) VALUES (?, ?)").run(issuer, pem);
}

export function getJwkPem(issuer: string): string | null {
  const row = db.prepare("SELECT pem FROM jwks WHERE issuer = ?").get<{ pem: string }>(issuer);
  return row?.pem ?? null;
}

// ---------------------------------------------------------------------------
// Provisioning nonces
// ---------------------------------------------------------------------------

export function createProvisioningNonce(nonce: string, dropletId: number): void {
  db.prepare("INSERT OR REPLACE INTO provisioning_nonces (nonce, droplet_id) VALUES (?, ?)").run(nonce, dropletId);
}

export function getProvisioningNonceDropletId(nonce: string): number {
  const row = db.prepare("SELECT droplet_id FROM provisioning_nonces WHERE nonce = ?").get<{ droplet_id: number }>(nonce);
  if (!row) throw new Error(`Nonce ${nonce} not found`);
  const id = row.droplet_id;
  db.prepare("DELETE FROM provisioning_nonces WHERE nonce = ?").run(nonce);
  return id;
}

// ---------------------------------------------------------------------------
// OAuth tokens
// ---------------------------------------------------------------------------

export function saveOauthToken(actx: string, token: string): void {
  db.prepare("INSERT OR REPLACE INTO oauth_tokens (actx, token) VALUES (?, ?)").run(actx, token);
}

export function getOauthToken(actx: string): string {
  const row = db.prepare("SELECT token FROM oauth_tokens WHERE actx = ?").get<{ token: string }>(actx);
  if (!row) throw new Error(`OAuth token for ${actx} not found`);
  return row.token;
}
