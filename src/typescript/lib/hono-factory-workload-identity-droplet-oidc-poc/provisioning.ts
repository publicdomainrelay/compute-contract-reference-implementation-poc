/**
 * provisioning.ts — VM provisioning with OIDC challenge/prove.
 *
 * Extracted from qemu/provisioning.ts. Decoupled from qemu's database: nonce
 * persistence is delegated to an injected NonceStore (configureProvisioning), so
 * this package never imports a concrete database.
 *
 * ProvisioningData.create: generate nonce, issue short-lived JWT, inject cloud-init runcmd
 * validate: verify JWT + look up droplet by nonce + verify ssh-keygen Ed25519 signature
 */

import * as jsYaml from "js-yaml";
import { OIDCToken } from "@publicdomainrelay/oidc-helper";

function log(level: string, msg: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...data }));
}

// ---------------------------------------------------------------------------
// Injected nonce persistence
// ---------------------------------------------------------------------------

/** Pluggable persistence mapping a provisioning nonce → droplet id (one-shot). */
export interface NonceStore {
  createProvisioningNonce(nonce: string, dropletId: string): void;
  getProvisioningNonceDropletId(nonce: string): string;
}

// Default in-memory store — keeps the package usable standalone. Real
// deployments inject a persistent store via configureProvisioning.
function createMemoryNonceStore(): NonceStore {
  const m = new Map<string, string>();
  return {
    createProvisioningNonce: (nonce, dropletId) => { m.set(nonce, dropletId); },
    getProvisioningNonceDropletId: (nonce) => {
      const id = m.get(nonce);
      if (id === undefined) throw new Error(`Nonce ${nonce} not found`);
      m.delete(nonce);
      return id;
    },
  };
}

let _nonceStore: NonceStore = createMemoryNonceStore();

/** Configure nonce persistence. Call once at startup. */
export function configureProvisioning(cfg: { nonceStore?: NonceStore }): void {
  if (cfg.nonceStore) _nonceStore = cfg.nonceStore;
}

const DEFAULT_NONCE_LEN = 64;
const DEFAULT_TTL_SECONDS = 60 * 15;

// ---------------------------------------------------------------------------
// ProvisioningData
// ---------------------------------------------------------------------------

export interface ProvisioningDataInit {
  nonce: string;
  token: OIDCToken;
  userData: string;
}

export class ProvisioningData {
  nonce: string;
  token: OIDCToken;
  userData: string;

  private constructor(init: ProvisioningDataInit) {
    this.nonce = init.nonce;
    this.token = init.token;
    this.userData = init.userData;
  }

  static async create(
    teamUuid: string,
    userData: string | null,
    issuerUrl: string,
    opts: { ttl?: number; nonceLen?: number } = {},
  ): Promise<ProvisioningData> {
    if (userData === null) userData = "";
    const nonceLen = opts.nonceLen ?? DEFAULT_NONCE_LEN;
    const ttl = opts.ttl ?? DEFAULT_TTL_SECONDS;

    // Cryptographically random hex nonce
    const nonceBytes = crypto.getRandomValues(new Uint8Array(nonceLen / 2));
    const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

    const token = await OIDCToken.create(teamUuid, {
      nonce,
      sub: `actx:${teamUuid}:role:provisioning:nonce:${nonce}`,
      ttl,
    });

    // Parse existing cloud-config YAML (best-effort) and inject runcmd
    let userDataObj: Record<string, unknown> = {};
    try {
      const parsed = jsYaml.load(userData);
      if (parsed && typeof parsed === "object") userDataObj = parsed as Record<string, unknown>;
    } catch {
      // not valid YAML — start fresh
    }

    const runcmd = (userDataObj["runcmd"] as unknown[]) ?? [];
    const writeFiles = (userDataObj["write_files"] as unknown[]) ?? [];

    const provisionScriptContent = `#!/usr/bin/env bash
set -euo pipefail
set -x
TEAM_UUID="${teamUuid}"
THIS_ENDPOINT="${issuerUrl}"
PROVISIONING_TOKEN="${token.asString}"
PORT=22
SIG_JSON="$(echo -n "\${PROVISIONING_TOKEN}" \\
    | ssh-keygen -Y sign -n prove-sshd -f /etc/ssh/ssh_host_ed25519_key \\
    | jq -c --arg port "\${PORT}" --raw-input --slurp '{port: (\$port | fromjson), sig: .}')"
TOKEN="$(curl -sfL \\
    -H "Authorization: Bearer \${PROVISIONING_TOKEN}" \\
    -d "\${SIG_JSON}" \\
    "\${THIS_ENDPOINT}/v1/oidc/prove" \\
    | jq -r .token)"
if [ -n "\${TOKEN}" ] && [ "\${TOKEN}" != "null" ]; then
    mkdir -p /root/secrets/digitalocean.com/serviceaccount/
    echo "\${TOKEN}" > /root/secrets/digitalocean.com/serviceaccount/token
    echo "\${TEAM_UUID}" > /root/secrets/digitalocean.com/serviceaccount/team_uuid
    echo "\${THIS_ENDPOINT}" > /root/secrets/digitalocean.com/serviceaccount/base_url
    # Trigger setup-websocat directly (container mode has no inotify for
    # .path units; real systemd is idempotent on already-running service).
    systemctl start --no-block setup-websocat.service 2>/dev/null || true
fi
`;

    const provisionUnitContent = `[Unit]
Description=Provisioning Token Exchange
After=ssh.service network-online.target
Wants=network-online.target
ConditionPathExists=!/root/secrets/digitalocean.com/serviceaccount/base_url

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/provisioning-token.sh

[Install]
WantedBy=multi-user.target
`;

    writeFiles.push({
      path: "/usr/local/bin/provisioning-token.sh",
      permissions: "0700",
      content: provisionScriptContent,
    });
    writeFiles.push({
      path: "/etc/systemd/system/provisioning-token.service",
      permissions: "0644",
      content: provisionUnitContent,
    });

    runcmd.unshift("systemctl start --no-block provisioning-token.service");
    runcmd.unshift("systemctl enable provisioning-token.service");
    runcmd.unshift("systemctl daemon-reload");

    userDataObj["write_files"] = writeFiles;
    userDataObj["runcmd"] = runcmd;

    const finalUserData = "#cloud-config\n" + jsYaml.dump(userDataObj, { lineWidth: -1 });

    return new ProvisioningData({ nonce, token, userData: finalUserData });
  }

  associateWithDroplet(dropletId: string): void {
    if (!dropletId) return;
    _nonceStore.createProvisioningNonce(this.nonce, dropletId);
  }
}

// ---------------------------------------------------------------------------
// SSH public key retrieval via ssh-keyscan
// ---------------------------------------------------------------------------

async function getPublicKeyFromSshd(publicIpv4: string, port: number, containerName?: string): Promise<string> {
  const deadline = Date.now() + 300_000;
  log("debug", "getPublicKeyFromSshd start", { publicIpv4, port, containerName, deadlineMs: 300_000 });
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      log("debug", "ssh-keyscan attempt", { publicIpv4, port, containerName, attempt });
      const cmd = containerName
        ? new Deno.Command("docker", {
            args: ["exec", containerName, "ssh-keyscan", "-t", "ed25519", "-p", String(port), "127.0.0.1"],
            stdout: "piped",
            stderr: "piped",
          })
        : new Deno.Command("ssh-keyscan", {
            args: ["-t", "ed25519", "-p", String(port), publicIpv4],
            stdout: "piped",
            stderr: "piped",
          });
      const { code, stdout, stderr } = await cmd.output();

      const out = new TextDecoder().decode(stdout).trim();
      const errOut = new TextDecoder().decode(stderr).trim();
      log("debug", "ssh-keyscan output", { code, outLen: out.length, errOut: errOut.slice(0, 200) });

      if (code === 0) {
        // ssh-keyscan output: "<host> <keytype> <base64key>"
        const line = out.split("\n").find((l) => l.includes("ed25519"));
        if (line) {
          // strip the host prefix, return "<keytype> <base64key>"
          const parts = line.split(" ");
          const key = parts.slice(1).join(" ");
          log("debug", "ssh-keyscan got key", { publicIpv4, port, keyPrefix: key.slice(0, 40) });
          return key;
        }
        log("debug", "ssh-keyscan no ed25519 line found", { out: out.slice(0, 200) });
      }
    } catch (e) {
      log("debug", "ssh-keyscan exception", { error: String(e), attempt });
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`ssh-keyscan timed out for ${publicIpv4}:${port}`);
}

// ---------------------------------------------------------------------------
// SSH signature verification via ssh-keygen -Y check-novalidate
// ---------------------------------------------------------------------------

export async function validateSshSignature(
  publicKeyOpensshString: string,
  sshSignatureBlob: string,
  dataThatWasSigned: string,
): Promise<boolean> {
  log("debug", "validateSshSignature start", {
    keyPrefix: publicKeyOpensshString.slice(0, 40),
    sigLen: sshSignatureBlob.length,
    dataLen: dataThatWasSigned.length,
  });
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/allowed_signing_key.pub`, publicKeyOpensshString);
    await Deno.writeTextFile(`${tmpDir}/signature`, sshSignatureBlob);
    const dataPath = `${tmpDir}/data`;
    await Deno.writeTextFile(dataPath, dataThatWasSigned);

    const dataBytes = await Deno.readFile(dataPath);
    log("debug", "validateSshSignature running ssh-keygen check-novalidate", { tmpDir });
    const child = new Deno.Command("ssh-keygen", {
      args: [
        "-Y", "check-novalidate",
        "-n", "prove-sshd",
        "-f", "allowed_signing_key.pub",
        "-s", "signature",
      ],
      cwd: tmpDir,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(dataBytes);
    await writer.close();
    const { code, stdout, stderr } = await child.output();
    const outStr = new TextDecoder().decode(stdout).trim();
    const errStr = new TextDecoder().decode(stderr).trim();
    log("debug", "validateSshSignature ssh-keygen result", { code, stdout: outStr, stderr: errStr });

    return code === 0;
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// validate — verify provisioning token + SSH signature + return droplet
// ---------------------------------------------------------------------------

export async function validate(
  token: string,
  signature: string,
  port: number,
  dropletGetter: (id: string) => Record<string, unknown> | undefined,
): Promise<{ oidcToken: OIDCToken; droplet: Record<string, unknown> } | null> {
  log("debug", "validate start", { tokenLen: token.length, sigLen: signature.length, port });

  const oidcToken = await OIDCToken.validate(token);
  log("debug", "validate oidcToken validated", { actx: oidcToken.actx, sub: oidcToken.sub });

  const nonce = oidcToken.claims["nonce"] as string | undefined;
  if (!nonce) throw new Error("provisioning token missing nonce claim");
  log("debug", "validate nonce extracted", { nonceLen: nonce.length });

  const dropletId = _nonceStore.getProvisioningNonceDropletId(nonce);
  log("debug", "validate dropletId from nonce", { dropletId });

  const droplet = dropletGetter(dropletId);
  if (!droplet) throw new Error(`droplet ${dropletId} not found`);
  log("debug", "validate droplet found", { dropletId, dropletName: droplet["name"] });

  const networks = droplet["networks"] as { v4: { ip_address: string; type: string }[] } | undefined;
  const publicIpv4 = networks?.v4.find((n) => n.type === "public")?.ip_address;
  log("debug", "validate network lookup", { publicIpv4, v4Count: networks?.v4?.length });
  if (!publicIpv4) throw new Error(`no public IPv4 for droplet ${dropletId}`);

  const containerName = droplet["containerName"] as string | undefined;
  log("debug", "validate fetching public key via ssh-keyscan", { publicIpv4, port, containerName });
  const publicKey = await getPublicKeyFromSshd(publicIpv4, port, containerName);
  log("debug", "validate got public key", { keyPrefix: publicKey.slice(0, 40) });

  let valid: boolean;
  try {
    valid = await validateSshSignature(publicKey, signature, token);
  } catch (e) {
    throw new Error(`Failed to validate SSHD signature: ${e}`);
  }
  log("debug", "validate ssh signature result", { valid });

  if (!valid) return null;
  return { oidcToken, droplet };
}
