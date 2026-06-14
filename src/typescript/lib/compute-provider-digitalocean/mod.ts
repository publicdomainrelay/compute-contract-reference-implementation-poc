import { Agent } from "@atproto/api";
import { stringify as yamlStringify, parse as yamlParse } from "npm:yaml@^2.7.0";
import { ON_BEHALF_OF_HEADER } from "@publicdomainrelay/utils-log";
import type {
  ComputeProvider,
  ComputeProviderCtx,
  DropletSpec,
  ProvisionResult,
  StrongRef,
  VM,
} from "@publicdomainrelay/compute-provider";

export type { VM };

export interface ComputeProviderDigitalOceanCtx extends ComputeProviderCtx {
  getAgent: () => Agent;
  getAgentDid: () => string;
  acceptPathVm: string;
  digitaloceanBaseUrl: string;
  doToken: string;
  rbacRepoRoot: string;
}

// RBAC NSID is specific to the DigitalOcean/homelab RBAC integration.
const RBAC_NSID = "com.fedproxy.rbac";

const COMPUTE_CONFIG_WIF_SIMPLE_NSID =
  "com.publicdomainrelay.temp.compute.config.wif.simple";
const DEFAULT_DIGITALOCEAN_BASE_URL = "https://droplet-oidc.its1337.com";
const DEFAULT_ACCEPT_PATH_VM =
  "/root/secrets/publicdomainrelay.com/market/accept.json";

// JSON.stringify with sorted keys — used to compare RBAC records for
// idempotency regardless of the key order the PDS returns them in.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type DOContext = { rbacRepo: string; teamUuid: string };

export function createComputeProviderDigitalOcean(ctx: ComputeProviderDigitalOceanCtx) {
  const {
    getAgent,
    getAgentDid,
    log,
    acceptPathVm = DEFAULT_ACCEPT_PATH_VM,
    digitaloceanBaseUrl = DEFAULT_DIGITALOCEAN_BASE_URL,
    doToken,
    rbacRepoRoot,
    parseAtUri,
  } = ctx;

  async function atprotoCreateRecord(collection: string, record: Record<string, unknown>): Promise<StrongRef> {
    const agent = getAgent();
    const res = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection,
      record,
    });
    return { $type: "com.atproto.repo.strongRef", uri: res.data.uri, cid: res.data.cid };
  }

  async function makeDoctx(): Promise<DOContext> {
    const res = await fetch(`${digitaloceanBaseUrl}/v2/account`, {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${doToken}` },
    });
    const json = await res.json();
    log("debug", "DO /v2/account response", { account: json });
    if (res.status >= 400) throw new Error(`DO /v2/account ${res.status}: ${JSON.stringify(json)}`);

    let uuid = json.account.team.uuid;
    const result = { rbacRepo: `${rbacRepoRoot}/${uuid}`, teamUuid: uuid };
    log("debug", "DO /v2/account resolved context", { ...result });
    return result;
  }

  async function runProc(cmd: string[], cwd: string): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> {
    const proc = new Deno.Command(cmd[0], { args: cmd.slice(1), cwd, stdin: "null", stdout: "piped", stderr: "piped" });
    const out = await proc.output();
    if (out.code !== 0) {
      log("error", "subprocess failed", {
        cmd,
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      });
    }
    return { code: out.code, stdout: out.stdout, stderr: out.stderr };
  }

  async function isDir(p: string): Promise<boolean> {
    try { return (await Deno.stat(p)).isDirectory; } catch { return false; }
  }

  async function configureDropletRbac(doctx: DOContext, vm: VM, requesterDid: string): Promise<StrongRef> {
    const requesterPlc = requesterDid.split(":").slice(-1)[0];
    const slug = `${doctx.teamUuid}-${requesterPlc}-${vm.role}`;
    const roleName = `ex-${slug}`;

    const rbac = doctx.rbacRepo;
    if (!(await isDir(`${rbac}/.git`))) {
      await Deno.mkdir(rbac, { recursive: true });
      const home = Deno.env.get("HOME") ?? "/root";
      const credHelperDir = `${home}/.local/scripts`;
      const credHelperPath = `${credHelperDir}/git-credential-rbac-digitalocean.sh`;
      const credHelper = `#!/usr/bin/env bash

TOKEN="${doToken}"

while IFS='=' read -r key value; do
  if [[ -n "$key" && -n "$value" ]]; then
    if [[ "$key" == "protocol" || "$key" == "host" ]]; then
      echo "$key=$value"
    fi
  fi
done

echo "username=token"
echo "password=\${TOKEN}"
`;
      await Deno.mkdir(credHelperDir, { recursive: true });
      await Deno.writeTextFile(credHelperPath, credHelper);
      await Deno.chmod(credHelperPath, 0o700);

      const helperAbs = await Deno.realPath(credHelperPath);
      const cmds: string[][] = [
        ["git", "config", "--global", `credential.${digitaloceanBaseUrl}/_rbac/DigitalOcean/.helper`, `!${helperAbs}`],
        ["git", "init"],
        ["git", "remote", "add", "origin", `${digitaloceanBaseUrl}/_rbac/DigitalOcean/${doctx.teamUuid}`],
        ["git", "pull", "origin", "main"],
        ["git", "branch", "--set-upstream-to=origin/main"],
      ];
      for (const cmd of cmds) {
        log("info", "rbac git command", { cmd });
        const r = await runProc(cmd, rbac);
        if (r.code !== 0) {
          if (cmd[1] === "pull" && new TextDecoder().decode(r.stderr).includes("couldn't find remote ref main")) continue;
          if (cmd[1] === "branch" && new TextDecoder().decode(r.stderr).includes("no commit on branch")) continue;
          log("error", "rbac git command failed", { cmd, code: r.code });
        }
      }
    }

    const policyPath = `${rbac}/policies/ex-${slug}.hcl`;
    const policyEx = `path "/v1/oidc/issue" {
  capabilities = ["create"]
  allowed_parameters = {
    "aud" = "*"
    "sub" = "actx:${doctx.teamUuid}:plc:${requesterPlc}:role:${vm.role}"
    "ttl" = 3600
  }
}
`;
    const rolePath = `${rbac}/droplet-roles/ex-${slug}.hcl`;
    const roleEx = `role "ex-${slug}" {
  aud      = "api://DigitalOcean?actx=${doctx.teamUuid}"
  sub      = "actx:${doctx.teamUuid}:plc:${requesterPlc}:role:${vm.role}"
  policies = ["ex-${slug}"]
}
`;
    await Deno.mkdir(`${rbac}/policies`, { recursive: true });
    await Deno.mkdir(`${rbac}/droplet-roles`, { recursive: true });
    await Deno.writeTextFile(policyPath, policyEx);
    await Deno.writeTextFile(rolePath, roleEx);

    const commitCmds: string[][] = [
      ["git", "add", "-A"],
      ["git", "commit", "-m", "feat: rbac for compute-contract"],
      ["git", "push", "-u", "origin", "main"],
    ];
    for (const cmd of commitCmds) {
      log("info", "rbac git command", { cmd });
      const r = await runProc(cmd, rbac);
      if (r.code !== 0) {
        if (cmd[1] === "commit" && new TextDecoder().decode(r.stdout).includes("nothing to commit")) continue;
        log("error", "rbac git command failed", { cmd, code: r.code });
      }
      log("info", "rbac git command exited", { cmd, code: r.code });
    }

    const schemaCmds: string[][] = [
      ["git", "fetch", "--all"],
      ["bash", "-xec", "git show origin/schema:rbac.json | yq -P"],
    ];
    for (const cmd of schemaCmds) {
      const r = await runProc(cmd, rbac);
      if (r.code !== 0) {
        log("error", "rbac git command failed", { cmd, code: r.code });
      }
    }

    return rbacRef;
  }

  // Deletes a com.fedproxy.rbac record previously minted for a droplet, e.g.
  // when the droplet is torn down via a vm.delete event.
  async function deleteRbacRecord(rbacRef: StrongRef, reason: string): Promise<void> {
    const agent = getAgent();
    const { repo, collection, rkey } = parseAtUri(rbacRef.uri);
    log("info", "deleting rbac record", { uri: rbacRef.uri, cid: rbacRef.cid, repo, collection, rkey, agentDid: agent.assertDid, reason });
    try {
      const res = await agent.com.atproto.repo.deleteRecord({ repo, collection, rkey });
      log("info", "rbac record deleted", { uri: rbacRef.uri, reason, status: res.success, headers: res.headers });
    } catch (err) {
      log("error", "failed to delete rbac record", {
        uri: rbacRef.uri,
        repo,
        collection,
        rkey,
        reason,
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  function injectAcceptBundle(userData: string, bundle: Record<string, unknown>): string {
    // deno-lint-ignore no-explicit-any
    let obj: Record<string, any> = {};
    try {
      const parsed = userData ? yamlParse(userData.replace(/^#cloud-config\s*/i, "")) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch { /* fall through with empty obj */ }
    const writeFiles = (obj.write_files ??= []) as unknown[];
    writeFiles.push({
      path: acceptPathVm,
      owner: "root:root",
      permissions: "0600",
      content: JSON.stringify(bundle, null, 2),
    });
    const runcmd = (obj.runcmd ??= []) as unknown[];
    const parent = acceptPathVm.split("/").slice(0, -1).join("/");
    runcmd.unshift(["sh", "-c", `install -d -m 0700 -o root -g root ${parent}`]);
    return "#cloud-config\n" + yamlStringify(obj, { lineWidth: 0 });
  }

  // Creates the com.publicdomainrelay.temp.compute.config.wif.simple record
  // that the bid advertises. Encodes the DO OIDC exchange parameters so the
  // VM can mint its own short-lived credentials without a long-lived secret.
  async function createBidConfig(nowIso: string): Promise<StrongRef> {
    const doctx = await makeDoctx();
    return atprotoCreateRecord(COMPUTE_CONFIG_WIF_SIMPLE_NSID, {
      $type: COMPUTE_CONFIG_WIF_SIMPLE_NSID,
      accept_path: acceptPathVm,
      issuer_uri: digitaloceanBaseUrl,
      to_issue: "exchange-custom-droplet-oidc-poc",
      actx: doctx.teamUuid,
      actx_path: "/root/secrets/digitalocean.com/serviceaccount/team_uuid",
      token_path: "/root/secrets/digitalocean.com/serviceaccount/token",
      url_path: "/root/secrets/digitalocean.com/serviceaccount/base_url",
      url_route: "/v1/oidc/issue",
      subject: "actx:{actx}:plc:{did-plc-key}:role:{role}",
      createdAt: nowIso,
    });
  }

  async function createDroplet(vm: VM, requesterDid: string): Promise<{ json: unknown; rbacRef: StrongRef }> {
    const requesterPlc = requesterDid.split(":").slice(-1)[0];
    const rfpRkey = (vm._uri ?? "").split("/")[4] ?? "unknown";
    const name = `${requesterPlc}-${rfpRkey}-${vm._cid ?? ""}`;
    const body = {
      name,
      region: "sfo3", // TODO pick based on vm.location
      size: "s-1vcpu-512mb-10gb",
      // Must match distro
      image: "ubuntu",
      user_data: vm.user_data,
      with_droplet_agent: true,
      tags: [`oidc-sub:plc:${requesterPlc}`, `oidc-sub:role:${vm.role}`],
    };
    log("info", "droplet request", { name, requesterDid, droplet: body });
    const doctx = await makeDoctx();
    const rbacRef = await configureDropletRbac(doctx, vm, requesterDid);
    const res = await fetch(`${digitaloceanBaseUrl}/v2/droplets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${doToken}`,
        // Forward the originating principal (the market.accept author) so the
        // compute host (qemu) can log whose request this provision serves.
        [ON_BEHALF_OF_HEADER]: requesterDid,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    log("info", "droplet created", { name, requesterDid, status: res.status });
    if (res.status >= 400) throw new Error(`DO /v2/droplets ${res.status}: ${JSON.stringify(json)}`);
    return { json, rbacRef };
  }

  async function deleteDroplet(dropletId: number | string, reason: string): Promise<void> {
    log("info", "deleting droplet", { dropletId, reason });
    const res = await fetch(`${digitaloceanBaseUrl}/v2/droplets/${dropletId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${doToken}` },
    });
    if (res.status >= 400 && res.status !== 404) {
      const body = await res.text();
      log("error", "DO delete droplet failed", { dropletId, status: res.status, body });
      return;
    }
    log("info", "droplet deleted", { dropletId, reason });
  }

  return {
    createBidConfig,
    createDroplet,
    deleteDroplet,
    deleteRbacRecord,
    injectAcceptBundle,
  };
}

// ---------------------------------------------------------------------------
// ComputeProvider adapter — wraps the RBAC-aware DO implementation in the
// provider-agnostic ComputeProvider interface.
// ---------------------------------------------------------------------------

export function createDigitalOceanComputeProvider(
  ctx: ComputeProviderDigitalOceanCtx,
): ComputeProvider {
  const {
    createBidConfig,
    createDroplet,
    deleteDroplet,
    deleteRbacRecord,
    injectAcceptBundle,
  } = createComputeProviderDigitalOcean(ctx);

  const rbacByProvider = new Map<string | number, StrongRef>();

  return {
    name: "digitalocean",

    async provision(
      vm: VM,
      requesterDid: string,
      _spec?: DropletSpec,
    ): Promise<ProvisionResult> {
      const { json, rbacRef } = await createDroplet(vm, requesterDid);
      const droplet = (json as Record<string, unknown>)?.droplet as
        | Record<string, unknown>
        | undefined;
      const providerId: string | number = (droplet?.id as string | number) ?? 0;
      rbacByProvider.set(providerId, rbacRef);
      return { providerId, metadata: json as Record<string, unknown> };
    },

    async destroy(id: string | number): Promise<void> {
      const rbacRef = rbacByProvider.get(id);
      if (rbacRef) {
        await deleteRbacRecord(rbacRef, "vm.delete event");
        rbacByProvider.delete(id);
      }
      await deleteDroplet(id, "vm.delete event");
    },

    createBidConfig,
    injectAcceptBundle,
    setup: undefined,
    teardown: undefined,
  };
}

