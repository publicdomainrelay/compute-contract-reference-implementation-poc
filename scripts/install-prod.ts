#!/usr/bin/env -S deno run --allow-all
// Install + enable all prod systemd units for the compute-contract reference
// implementation. Symlinks each unit from its source dir into
// /etc/systemd/system, reloads systemd, then enables --now.
//
// Also ensures a <service>.env.secrets exists next to each committed
// <service>.env that carries CHANGE_ME stubs (see ensureSecrets).
//
// Idempotent: re-running re-points symlinks, refills only missing secrets,
// and restarts units. Run as a user with sudo. Units run as User=johnandersen777.
//
//   deno run --allow-all scripts/install-prod.ts
//   # or: ./scripts/install-prod.ts

import { Secp256k1Keypair } from "npm:@atproto/crypto";

const HOME = Deno.env.get("HOME")!;
const PROD_ROOT = `${HOME}/prod-compute-contract-reference-implementation-poc`;
const REPO_URL =
  "https://github.com/publicdomainrelay/compute-contract-reference-implementation-poc";

// unit file -> source dir (relative to <TS>)
const UNITS: ReadonlyArray<readonly [unit: string, dir: string]> = [
  ["bidder-tunnel.service", "bidder"],
  ["bidder.service", "bidder"],
  ["market-registry-tunnel.service", "market-registry"],
  ["market-registry.service", "market-registry"],
  ["spindle.service", "spindle"],
  ["qemu.service", "qemu"],
];

const secretWarnings: string[] = [];

/** Run a command, inheriting stdio; throw on non-zero exit. */
async function run(cmd: string, ...args: string[]): Promise<void> {
  const { code } = await new Deno.Command(cmd, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${code}`);
  }
}

/** Run a command and capture stdout (trimmed); ignore exit code. */
async function capture(cmd: string, ...args: string[]): Promise<string> {
  const { stdout } = await new Deno.Command(cmd, { args, stderr: "null" })
    .output();
  return new TextDecoder().decode(stdout).trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a fresh secp256k1 (k256) private key as 64-char lowercase hex with no
 * prefix — the exact encoding the services round-trip via Secp256k1Keypair
 * .import(hex) / loadOrGenerateKeypair(hex)->hexToBytes and produce on export
 * (Array.from(kp.export()).map(b=>b.toString(16).padStart(2,"0")).join("")).
 * Using the curve's own generator guarantees an in-range, valid key — unlike
 * raw `openssl rand -hex 32`, which can (negligibly) land >= curve order or 0.
 */
async function generateKeyHex(): Promise<string> {
  const kp = await Secp256k1Keypair.create({ exportable: true });
  return Array.from(await kp.export())
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse `KEY=value` lines into an ordered map (ignores comments/blanks). */
function parseEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * For each committed <service>.env carrying `VAR=CHANGE_ME` stubs, ensure a
 * sibling <service>.env.secrets defines a real value for every stub var:
 *   - if the var is exported in this process's env, use that;
 *   - else if the var name ends in _KEY_HEX, generate a valid k256 key (hex);
 *   - else leave CHANGE_ME and warn (operator must fill it in).
 * Never clobbers a var already set to a non-CHANGE_ME value in an existing
 * .env.secrets; preserves any extra lines already present. Files are 0600.
 */
async function ensureSecrets(ts: string): Promise<void> {
  console.log("==> Ensuring .env.secrets files");
  const dirs = [...new Set(UNITS.map(([, dir]) => dir))];
  for (const dir of dirs) {
    const envFile = `${ts}/${dir}/${dir}.env`;
    if (!(await exists(envFile))) continue;

    const stubVars = [
      ...parseEnv(await Deno.readTextFile(envFile)),
    ]
      .filter(([, v]) => v === "CHANGE_ME")
      .map(([k]) => k);
    if (stubVars.length === 0) continue;

    const secretsFile = `${envFile}.secrets`;
    const secrets = (await exists(secretsFile))
      ? parseEnv(await Deno.readTextFile(secretsFile))
      : new Map<string, string>();

    for (const v of stubVars) {
      const existing = secrets.get(v);
      if (existing !== undefined && existing !== "CHANGE_ME") continue; // keep real value

      const fromEnv = Deno.env.get(v);
      if (fromEnv) {
        secrets.set(v, fromEnv);
        console.log(`  ${dir}/${dir}.env.secrets: ${v} <- shell env`);
      } else if (v.endsWith("_KEY_HEX")) {
        secrets.set(v, await generateKeyHex());
        console.log(`  ${dir}/${dir}.env.secrets: ${v} <- generated k256 key`);
      } else {
        secrets.set(v, "CHANGE_ME");
        secretWarnings.push(`${secretsFile} needs a real value for ${v}`);
      }
    }

    const body = [...secrets].map(([k, val]) => `${k}=${val}`).join("\n") + "\n";
    await Deno.writeTextFile(secretsFile, body, { mode: 0o600 });
    await Deno.chmod(secretsFile, 0o600); // enforce even if file pre-existed
  }
}

async function main(): Promise<void> {
  if (!(await exists(PROD_ROOT))) {
    await run("git", "clone", REPO_URL, PROD_ROOT);
  }

  const ts = `${PROD_ROOT}/src/typescript`;
  const systemdDir = "/etc/systemd/system";

  await ensureSecrets(ts);

  console.log(`==> Installing unit symlinks into ${systemdDir}`);
  for (const [unit, dir] of UNITS) {
    const src = `${ts}/${dir}/${unit}`;
    if (!(await exists(src))) {
      console.error(`error: missing unit ${src}`);
      Deno.exit(1);
    }
    console.log(`  ln -sf ${src} ${systemdDir}/${unit}`);
    await run("sudo", "ln", "-sf", src, `${systemdDir}/${unit}`);
  }

  console.log("==> systemctl daemon-reload");
  await run("sudo", "systemctl", "daemon-reload");

  console.log("==> enable --now");
  for (const [unit] of UNITS) {
    console.log(`  ${unit}`);
    await run("sudo", "systemctl", "enable", "--now", unit);
    await run("sudo", "systemctl", "restart", unit);
  }

  console.log("==> status");
  for (const [unit] of UNITS) {
    console.log(await capture("systemctl", "--no-pager", "--lines=0", "status", unit));
  }

  if (secretWarnings.length > 0) {
    console.log(
      "==> WARNING: unset secrets left as CHANGE_ME (export in shell + re-run, or edit the file):",
    );
    for (const w of secretWarnings) console.log(`  ${w}`);
  }

  console.log(
    "Done. Tail logs: journalctl -u spindle -u bidder -u qemu -u bidder-tunnel -u market-registry -u market-registry-tunnel -f",
  );
}

if (import.meta.main) {
  await main();
}
