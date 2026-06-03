/**
 * provisioning.ts — VM provisioning with OIDC challenge/prove (mirrors provisioning.py)
 *
 * ProvisioningData.create: generate nonce, issue short-lived JWT, inject cloud-init runcmd
 * validate: verify JWT + look up droplet by nonce + verify ssh-keygen Ed25519 signature
 */

import * as jsYaml from "npm:js-yaml@^4.2.0";
import { OIDCToken } from "./oidc_helper.ts";
import { createProvisioningNonce, getProvisioningNonceDropletId } from "./database.ts";
import { doDropletGet } from "./do_api.ts";

const THIS_ENDPOINT = Deno.env.get("THIS_ENDPOINT") ?? Deno.env.get("ISSUER_URL") ?? "http://localhost:8080";

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

    const provisionScript = [
      // Variable setup (interpolated)
      [
        `TEAM_UUID="${teamUuid}"`,
        `THIS_ENDPOINT="${THIS_ENDPOINT}"`,
        `PROVISIONING_TOKEN="${token.asString}"`,
      ].join("\n"),
      // Challenge/prove script (literal — no interpolation)
      String.raw`set -eu
set -x
while ! grep -q "0016" /proc/net/tcp; do sleep 1; done && echo "Port 22 is active"
PORT=22
SIG_JSON="$(echo -n "${PROVISIONING_TOKEN}" \
    | ssh-keygen -Y sign -n prove-sshd -f /etc/ssh/ssh_host_ed25519_key \
    | jq -c --arg port "${PORT}" --raw-input --slurp '{port: ($port | fromjson), sig: .}')"
TOKEN="$(curl -sfL \
    -H "Authorization: Bearer ${PROVISIONING_TOKEN}" \
    -d "${SIG_JSON}" \
    "${THIS_ENDPOINT}/v1/oidc/prove" \
    | jq -r .token)"
if [ -n "${TOKEN}" ] && [ "${TOKEN}" != "null" ]; then
    mkdir -p /root/secrets/digitalocean.com/serviceaccount/
    echo "${TOKEN}" > /root/secrets/digitalocean.com/serviceaccount/token
fi`,
    ].join("\n");

    runcmd.push(provisionScript);
    userDataObj["runcmd"] = runcmd;

    const finalUserData = ["#cloud-config", jsYaml.dump(userDataObj)].join("\n");

    return new ProvisioningData({ nonce, token, userData: finalUserData });
  }

  associateWithDroplet(dropletId: number): void {
    if (dropletId < 1) return;
    createProvisioningNonce(this.nonce, dropletId);
  }
}

// ---------------------------------------------------------------------------
// SSH public key retrieval via ssh-keyscan
// ---------------------------------------------------------------------------

async function getPublicKeyFromSshd(publicIpv4: string, port: number): Promise<string> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      const { code, stdout } = await new Deno.Command("ssh-keyscan", {
        args: ["-t", "ed25519", "-p", String(port), publicIpv4],
        stdout: "piped",
        stderr: "null",
      }).output();

      if (code === 0) {
        const out = new TextDecoder().decode(stdout).trim();
        // ssh-keyscan output: "<host> <keytype> <base64key>"
        const line = out.split("\n").find((l) => l.includes("ed25519"));
        if (line) {
          // strip the host prefix, return "<keytype> <base64key>"
          const parts = line.split(" ");
          return parts.slice(1).join(" ");
        }
      }
    } catch {
      // not up yet
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
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/allowed_signing_key.pub`, publicKeyOpensshString);
    await Deno.writeTextFile(`${tmpDir}/signature`, sshSignatureBlob);
    const dataPath = `${tmpDir}/data`;
    await Deno.writeTextFile(dataPath, dataThatWasSigned);

    const dataBytes = await Deno.readFile(dataPath);
    const { code } = await new Deno.Command("ssh-keygen", {
      args: [
        "-Y", "check-novalidate",
        "-n", "prove-sshd",
        "-f", "allowed_signing_key.pub",
        "-s", "signature",
      ],
      cwd: tmpDir,
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn().then(async (proc) => {
      // Not available in all Deno versions — use the buffered approach
      void proc;
      throw new Error("use buffered");
    }).catch(async () => {
      // Buffered approach: pipe stdin via subprocess input
      const cmd = new Deno.Command("ssh-keygen", {
        args: [
          "-Y", "check-novalidate",
          "-n", "prove-sshd",
          "-f", "allowed_signing_key.pub",
          "-s", "signature",
        ],
        cwd: tmpDir,
        stdin: "piped",
        stdout: "null",
        stderr: "null",
      });
      const child = cmd.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(dataBytes);
      await writer.close();
      return child.status;
    });

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
): Promise<{ oidcToken: OIDCToken; droplet: Record<string, unknown> } | null> {
  const oidcToken = await OIDCToken.validate(token);

  const nonce = oidcToken.claims["nonce"] as string | undefined;
  if (!nonce) throw new Error("provisioning token missing nonce claim");

  const dropletId = getProvisioningNonceDropletId(nonce);

  // Use a placeholder token for the DO API call — the droplet is already created
  const droplet = await doDropletGet("feedface", dropletId);

  const networks = droplet["networks"] as { v4: { ip_address: string; type: string }[] } | undefined;
  const publicIpv4 = networks?.v4.find((n) => n.type === "public")?.ip_address;
  if (!publicIpv4) throw new Error(`no public IPv4 for droplet ${dropletId}`);

  const publicKey = await getPublicKeyFromSshd(publicIpv4, port);

  let valid: boolean;
  try {
    valid = await validateSshSignature(publicKey, signature, token);
  } catch (e) {
    throw new Error(`Failed to validate SSHD signature: ${e}`);
  }

  if (!valid) return null;
  return { oidcToken, droplet };
}
