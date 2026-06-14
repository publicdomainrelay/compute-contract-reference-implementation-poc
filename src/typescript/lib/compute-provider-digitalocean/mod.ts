// ---------------------------------------------------------------------------
// DigitalOcean + RBAC — provisioning backend for the bidder.
//
// Exposes createComputeProviderDigitalOcean(ctx), which wires the DO/RBAC
// helpers against the bidder's atproto agent and env. Kept as a factory
// (rather than module-level state) because `agent`/`agentDid` are only
// available after loginAgent() resolves.
// ---------------------------------------------------------------------------

import { Agent } from "@atproto/api";
import { stringify as yamlStringify, parse as yamlParse } from "npm:yaml@^2.7.0";
import { COMPUTE_CONFIG_WIF_SIMPLE_NSID } from "@publicdomainrelay/lexicons";
import { ON_BEHALF_OF_HEADER } from "@publicdomainrelay/utils-log";
import type { ComputeProvider, ProvisionResult, DropletSpec, VM } from "@publicdomainrelay/compute-provider";

export type StrongRef = { $type: "com.atproto.repo.strongRef"; uri: string; cid: string };

// Re-export VM type for consumers that still import it from here.
export type { VM };

type LogLevel = "info" | "warn" | "error" | "debug";
type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface ComputeProviderDigitalOceanCtx {
  getAgent: () => Agent;
  getAgentDid: () => string;
  log: Logger;
  acceptPathRecord: string;
  acceptPathVm: string;
  digitaloceanBaseUrl: string;
  doToken: string;
  rbacRepoRoot: string;
  parseAtUri: (uri: string) => { repo: string; collection: string; rkey: string };
}

// RBAC NSID is specific to the DigitalOcean/homelab RBAC integration.
const RBAC_NSID = "com.fedproxy.rbac";

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

type DOContext = { rbacRepoRoot: string; teamUuid: string };

export function createComputeProviderDigitalOcean(ctx: ComputeProviderDigitalOceanCtx) {
  const {
    getAgent,
    getAgentDid,
    log,
    acceptPathRecord: ACCEPT_PATH_RECORD,
    acceptPathVm: ACCEPT_PATH_VM,
    digitaloceanBaseUrl: DIGITALOCEAN_BASE_URL,
    doToken: DO_TOKEN,
    rbacRepoRoot: RBAC_REPO_ROOT,
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

  // Derive did:web: from the service base URL for use as getServiceAuth aud.
  function urlToDid(url: string): string {
    const host = new URL(url).host;
    return `did:web:${host}`;
  }

  // Get a short-lived ATProto service auth token targeting the DO/QEMU endpoint.
  // These are non-OIDC JWTs: signed by the PDS, iss=agentDid, validated via DID doc.
  async function getServiceAuthToken(): Promise<string> {
    const aud = urlToDid(DIGITALOCEAN_BASE_URL);
    // cannot request a method-less token with an expiration more than a minute in the future
    const exp = Math.floor(Date.now() / 1000) + 60; // 1 min
    log("info", "calling getServiceAuth", { aud, exp });
    const res = await getAgent().com.atproto.server.getServiceAuth({ aud, exp });
    return res.data.token;
  }

  async function makeDoctx(): Promise<DOContext> {
    const token = await getServiceAuthToken();
    const res = await fetch(`${DIGITALOCEAN_BASE_URL}/v2/account`, {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    });
    const json = await res.json();
    log("debug", "DO /v2/account response", { account: json });
    if (res.status >= 400) throw new Error(`DO /v2/account ${res.status}: ${JSON.stringify(json)}`);

    let uuid = json.account.team.uuid;
    // Handle custom/homelab did:plc as actx / team uuid
    if (uuid.startsWith("did:plc:")) {
      uuid = uuid.substring(8);
    }
    const result = { rbacRepoRoot: RBAC_REPO_ROOT, teamUuid: uuid };
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

    const rbacRecord = {
      $type: RBAC_NSID,
      protects: {
        [roleName]: {
          service: `${DIGITALOCEAN_BASE_URL}`,
          scope: 'droplets.wid',
        }
      },
      roles: {
        [roleName]: {
          role_name: roleName,
          definition: {
            aud: `api://DigitalOcean?actx=${doctx.teamUuid}`,
            sub: `actx:${doctx.teamUuid}:plc:${requesterPlc}:role:${vm.role}`,
            policies: [roleName],
          },
        },
      },
      policies: {
        [roleName]: {
          meta: {
            policy: roleName,
          },
          schemas: {
            "/v1/oidc/issue": {
              type: "object",
              $schema: "http://json-schema.org/draft-07/schema#",
              required: ["capability", "allowed_parameters"],
              properties: {
                capability: {
                  enum: ["create"],
                },
                allowed_parameters: {
                  type: "object",
                  properties: {
                    aud: { type: "string" },
                    sub: {
                      type: "string",
                      const: `actx:${doctx.teamUuid}:plc:${requesterPlc}:role:${vm.role}`,
                    },
                    ttl: {
                      type: "number",
                      const: 3600,
                    },
                  },
                },
              },
            },
          },
        },
      },
      custom_claims_roles_index: {
        job_workflow_ref: {},
      },
      createdAt: new Date().toISOString(),
    };
    log("info", "creating rbac record", { nsid: RBAC_NSID });
    const rbacRef = await atprotoCreateRecord(RBAC_NSID, rbacRecord);
    log("info", "rbac record created", { nsid: RBAC_NSID, uri: rbacRef.uri });

    const rbac = doctx.rbacRepoRoot;
    if (!(await isDir(`${rbac}/.git`))) {
      await Deno.mkdir(rbac, { recursive: true });
      const home = Deno.env.get("HOME") ?? "/root";
      const credHelperDir = `${home}/.local/scripts`;
      const credHelperPath = `${credHelperDir}/git-credential-rbac-digitalocean.sh`;
      const credHelper = `#!/usr/bin/env bash

TOKEN="${DO_TOKEN}"

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
        ["git", "config", "--global", `credential.${DIGITALOCEAN_BASE_URL}/_rbac/DigitalOcean/.helper`, `!${helperAbs}`],
        ["git", "init"],
        ["git", "remote", "add", "origin", `${DIGITALOCEAN_BASE_URL}/_rbac/DigitalOcean/${doctx.teamUuid}`],
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

  // Creates a separate com.fedproxy.rbac record for scope=account.auth.
  // Protects /v2/account and /v2/droplets* using ATProto service auth tokens
  // (com.atproto.server.getServiceAuth — iss=agentDid, validated via DID doc keys).
  async function configureAccountAuthRbac(): Promise<void> {
    const agentDid = getAgentDid();
    const roleName = `account-auth-${agentDid.split(":").slice(-1)[0]}`;

    const rbacRecord = {
      $type: RBAC_NSID,
      protects: {
        [roleName]: {
          service: `${DIGITALOCEAN_BASE_URL}`,
          scope: "account.auth",
        },
      },
      roles: {
        // ATProto service auth: iss and sub are both the bidder's DID.
        // getServiceAuth tokens have iss=agentDid, validated via DID document keys.
        [roleName]: {
          role_name: roleName,
          definition: {
            iss: agentDid,
            sub: agentDid,
            policies: [roleName],
          },
        },
      },
      policies: {
        [roleName]: {
          meta: { policy: roleName },
          schemas: {
            "/v2/account": {
              type: "object",
              properties: { capability: { enum: ["read"] } },
            },
            "/v2/droplets": {
              type: "object",
              properties: { capability: { enum: ["read", "create"] } },
            },
            "/v2/droplets/*": {
              type: "object",
              properties: { capability: { enum: ["read", "update", "delete"] } },
            },
          },
        },
      },
      createdAt: new Date().toISOString(),
    };

    const agent = getAgent();
    const listRes = await agent.com.atproto.repo.listRecords({
      repo: agentDid,
      collection: RBAC_NSID,
      limit: 100,
    });
    const { createdAt: _createdAt, ...rbacRecordData } = rbacRecord;
    const wanted = canonicalJson(rbacRecordData);
    const existing = listRes.data.records.find((r) => {
      const { createdAt: _existingCreatedAt, ...value } = r.value as Record<string, unknown>;
      return canonicalJson(value) === wanted;
    });
    if (existing) {
      log("info", "account.auth record already exists", { uri: existing.uri });
      return;
    }

    log("info", "creating account.auth record", { nsid: RBAC_NSID });
    await atprotoCreateRecord(RBAC_NSID, rbacRecord);
    log("info", "account.auth record created", { nsid: RBAC_NSID });
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
      path: ACCEPT_PATH_VM,
      owner: "root:root",
      permissions: "0600",
      content: JSON.stringify(bundle, null, 2),
    });
    const runcmd = (obj.runcmd ??= []) as unknown[];
    const parent = ACCEPT_PATH_VM.split("/").slice(0, -1).join("/");
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
      accept_path: ACCEPT_PATH_RECORD,
      issuer_uri: DIGITALOCEAN_BASE_URL,
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
    const token = await getServiceAuthToken();
    const res = await fetch(`${DIGITALOCEAN_BASE_URL}/v2/droplets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
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
    const token = await getServiceAuthToken();
    const res = await fetch(`${DIGITALOCEAN_BASE_URL}/v2/droplets/${dropletId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` },
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
    configureAccountAuthRbac,
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
    configureAccountAuthRbac,
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
    setupAuth: configureAccountAuthRbac,
  };
}

