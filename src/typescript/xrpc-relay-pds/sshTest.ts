/**
 * sshTest.ts — Launch a VM, intercept the SSH binary with ssh-wrapper.ts so
 * the SSH session inside runComputeContract gets PTY allocation, and run a
 * programmatic command through the allocated PTY.
 *
 * The README.md invocation:
 *   CONTAINER_MODE=true START_BIDDER=true PORT=0 deno run -A ./cli.ts --bid-window-sec 2
 *
 * This test does the same but wraps the SSH binary with ssh-wrapper.ts.
 *
 * Run:
 *   CONTAINER_MODE=true START_BIDDER=true PORT=0 \
 *     deno run -A sshTest.ts --bid-window-sec 2 --cmd 'echo PASS:PTY_TEST && hostname && date'
 */

import { createRequesterPDS, runComputeContract } from "./server.ts";
import { createEphemeralBidder } from "@publicdomainrelay/hono-factory-ephemeral-compute-bidder";
import { IdResolver } from "@atproto/identity";
// ── Resolve ssh-wrapper.ts path relative to this script ──────────────────
const SSH_WRAPPER_PATH = new URL("./ssh-wrapper.ts", import.meta.url).pathname;
const REAL_SSH = "/usr/bin/ssh";

// ── Bidder env-var discovery (mirrors cli.ts) ──────────────────────────

async function discoverBidderDidsFromEnv(): Promise<string[]> {
  const dids: string[] = [];
  const resolver = new IdResolver();
  for (let i = 0; i <= 9999; i++) {
    const key = `BIDDER_HANDLE_${String(i).padStart(4, "0")}`;
    const raw = Deno.env.get(key);
    if (!raw) continue;
    const val = raw.trim();
    if (!val) continue;
    if (val.startsWith("did:")) {
      dids.push(val);
      console.log(JSON.stringify({ event: "bidder_env_direct", key, did: val }));
      continue;
    }
    try {
      const doc = await resolver.handle.resolve(val);
      if (doc) {
        dids.push(doc);
        console.log(JSON.stringify({ event: "bidder_env_resolved", key, handle: val, did: doc }));
      }
    } catch (err) {
      console.log(JSON.stringify({ event: "bidder_env_resolve_error", key, handle: val, error: String(err) }));
    }
  }
  return dids;
}

async function discoverDenyBidderDidsFromEnv(): Promise<string[]> {
  const dids: string[] = [];
  const resolver = new IdResolver();
  for (let i = 0; i <= 9999; i++) {
    const key = `DENY_BIDDER_HANDLE_${String(i).padStart(4, "0")}`;
    const raw = Deno.env.get(key);
    if (!raw) continue;
    const val = raw.trim();
    if (!val) continue;
    if (val.startsWith("did:")) {
      dids.push(val);
      continue;
    }
    try {
      const doc = await resolver.handle.resolve(val);
      if (doc) dids.push(doc);
    } catch { /* skip unresolvable */ }
  }
  return dids;
}

function findNextBidderHandleSlot(): number {
  for (let i = 0; i <= 9999; i++) {
    const key = `BIDDER_HANDLE_${String(i).padStart(4, "0")}`;
    if (!Deno.env.get(key)) return i;
  }
  throw new Error("No available BIDDER_HANDLE_NNNN slots");
}

async function startBidderIfNeeded(): Promise<void> {
  if (Deno.env.get("START_BIDDER") !== "true") return;
  if (!Deno.env.has("START_CONTAINER_HOST")) {
    Deno.env.set("START_CONTAINER_HOST", "true");
  }
  const bidder = await createEphemeralBidder({ port: 0, label: "ssh-test-bidder" });
  await bidder.ready;
  const slot = findNextBidderHandleSlot();
  const key = `BIDDER_HANDLE_${String(slot).padStart(4, "0")}`;
  Deno.env.set(key, bidder.did);
  console.log(JSON.stringify({ event: "bidder_in_process_registered", key, did: bidder.did }));
}

// ── Network bootstrap: ensure websocat is on PATH ──────────────────────

async function ensureWebsocat(): Promise<void> {
  const which = new Deno.Command("which", { args: ["websocat"], stdout: "null", stderr: "null" });
  if ((await which.output()).code === 0) {
    console.log(JSON.stringify({ event: "websocat_found", source: "system" }));
    return;
  }
  const plat = Deno.build.os;
  const arch = Deno.build.arch;
  const triple: Record<string, Record<string, string>> = {
    linux:  { x86_64: "x86_64-unknown-linux-musl", aarch64: "aarch64-unknown-linux-musl" },
    darwin: { x86_64: "x86_64-apple-darwin",       aarch64: "aarch64-apple-darwin" },
  };
  const target = triple[plat]?.[arch];
  if (!target) {
    console.log(JSON.stringify({ event: "websocat_unsupported", plat, arch }));
    return;
  }
  const version = "v1.14.0";
  const url = `https://github.com/vi/websocat/releases/download/${version}/websocat.${target}`;
  const dir = await Deno.makeTempDir({ prefix: "websocat-" });
  const binPath = `${dir}/websocat`;
  console.log(JSON.stringify({ event: "websocat_downloading", url }));
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    console.log(JSON.stringify({ event: "websocat_download_failed", status: resp.status }));
    return;
  }
  const file = await Deno.open(binPath, { write: true, create: true, mode: 0o755 });
  await resp.body.pipeTo(file.writable);
  console.log(JSON.stringify({ event: "websocat_downloaded", path: binPath }));
  Deno.env.set("PATH", `${dir}:${Deno.env.get("PATH") ?? ""}`);
}

// ── SSH wrapper injection ───────────────────────────────────────────────

/**
 * Create a tempdir containing an `ssh` shell script that delegates to
 * ssh-wrapper.ts, then prepend that dir to PATH so any call to `ssh`
 * (including from runComputeContract → runSshSession) goes through the
 * PTY-allocating wrapper.
 */
async function injectSshWrapper(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "ssh-wrapper-inject-" });
  const wrapperPath = `${dir}/ssh`;

  // Shell script: pass all args through to ssh-wrapper.ts
  const script = [
    "#!/bin/sh",
    `exec deno run -A '${SSH_WRAPPER_PATH}' "$@"`,
    "",
  ].join("\n");

  await Deno.writeTextFile(wrapperPath, script);
  await Deno.chmod(wrapperPath, 0o755);

  // Prepend to PATH so `ssh` resolves to our wrapper
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);

  // Tell ssh-wrapper.ts where the real ssh binary lives
  Deno.env.set("SSH_BIN_PATH", REAL_SSH);

  console.log(JSON.stringify({
    event: "ssh_wrapper_injected",
    wrapperPath,
    sshWrapperTs: SSH_WRAPPER_PATH,
    realSsh: REAL_SSH,
  }));

  return dir;
}

// ── CLI args ────────────────────────────────────────────────────────────

function randomHex8(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // CLI flags
  const vmName = (() => {
    const i = Deno.args.indexOf("--vm-name");
    return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : `sshtest-${randomHex8()}`;
  })();
  const bidWindowSec = (() => {
    const i = Deno.args.indexOf("--bid-window-sec");
    return i >= 0 ? parseInt(Deno.args[i + 1] ?? "5", 10) : 5;
  })();
  const noDelete = Deno.args.includes("--no-delete");
  const execProgram = (() => {
    const i = Deno.args.indexOf("--cmd");
    return i >= 0 ? Deno.args[i + 1] ?? "echo PASS:PTY_TEST && hostname && date"
      : "echo PASS:PTY_TEST && hostname && date && id";
  })();
  const vmReadyTimeoutSec = (() => {
    const i = Deno.args.indexOf("--vm-ready-timeout-sec");
    return i >= 0 ? parseInt(Deno.args[i + 1] ?? "300", 10) : 300;
  })();

  console.log(JSON.stringify({
    event: "ssh_test_start",
    vmName,
    bidWindowSec,
    noDelete,
    execProgram,
    sshWrapperPath: SSH_WRAPPER_PATH,
    containerMode: Deno.env.get("CONTAINER_MODE"),
    startBidder: Deno.env.get("START_BIDDER"),
  }));

  // 1. Ensure websocat is available (network bootstrap)
  await ensureWebsocat();

  // 2. Inject ssh-wrapper.ts as the `ssh` binary on PATH
  const wrapperDir = await injectSshWrapper();
  console.log(JSON.stringify({ event: "tempdir_created", path: wrapperDir }));

  // 3. Create the requester PDS
  const pds = await createRequesterPDS();

  // 4. Wait for relay registration so proxyRef is set
  const { proxyRef, subdomain } = await pds.relayReady;
  pds.proxyRef = proxyRef;
  pds.relaySubdomain = subdomain;

  // 5. Start bidder in-process if START_BIDDER=true
  await startBidderIfNeeded();

  // 6. Discover bidders from env
  const extraBidderDids = await discoverBidderDidsFromEnv();
  const denyBidderDids = await discoverDenyBidderDidsFromEnv();

  // 7. Run the full compute-contract flow.
  //    Because we injected ssh-wrapper.ts as the `ssh` binary, the SSH
  //    session inside runComputeContract will allocate a PTY via
  //    ssh-wrapper.ts before connecting.
  console.log(JSON.stringify({
    event: "running_compute_contract",
    note: "SSH calls go through ssh-wrapper.ts for PTY allocation",
  }));

  const result = await runComputeContract(pds, {
    vmName,
    bidWindowSec,
    skipSsh: false,
    noDelete,
    execProgram,
    vmReadyTimeoutSec,
    extraBidderDids,
    denyBidderDids,
  });

  console.log(JSON.stringify({
    event: "compute_contract_done",
    bids: result.bids,
    receiptOk: result.receiptOk,
  }));

  // 8. Cleanup
  pds.stop();

  // Best-effort cleanup of the wrapper tempdir (leave keys for inspection
  // if --no-delete was passed).
  if (!noDelete) {
    try { await Deno.remove(wrapperDir, { recursive: true }); } catch { /* ok */ }
  } else {
    console.log(JSON.stringify({ event: "wrapper_dir_kept", path: wrapperDir }));
  }

  console.log(JSON.stringify({ event: "ssh_test_done", did: pds.did }));
  Deno.exit(0);
}

main();
