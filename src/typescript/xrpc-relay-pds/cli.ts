/**
 * cli.ts — CLI entry point for the xrpc-relay-pds requester.
 *
 * Starts a PDS, registers with plc.directory, connects to the relay, and runs
 * the compute-contract flow.  Drops into an SSH session when the VM comes up.
 *
 * Run:
 *   deno run -A cli.ts [--vm-name my-vm] [--bid-window-sec 30] [--no-delete] [--exec bash]
 */

import { createRequesterPDS, runComputeContract } from "./server.ts";

// ── websocat bootstrap ─────────────────────────────────────────────────

/**
 * Ensure `websocat` is on PATH.  If a system install is found (via `which`),
 * nothing is downloaded.  Otherwise the binary is fetched from GitHub releases
 * into a temp directory, made executable, and the directory is prepended to
 * `PATH` so child processes (ssh ProxyCommand) discover it.
 */
async function ensureWebsocat(): Promise<void> {
  // 1. Already on PATH?
  const which = new Deno.Command("which", { args: ["websocat"], stdout: "null", stderr: "null" });
  if ((await which.output()).code === 0) {
    console.log(JSON.stringify({ event: "websocat_found", source: "system" }));
    return;
  }

  // 2. Detect platform triple for the prebuilt binary.
  const plat = Deno.build.os;   // "linux" | "darwin" | "windows"
  const arch = Deno.build.arch; // "x86_64" | "aarch64"
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

  // 3. Download to a temp directory.
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

  // 4. Prepend temp dir to PATH so ssh child processes find it.
  Deno.env.set("PATH", `${dir}:${Deno.env.get("PATH") ?? ""}`);
  console.log(JSON.stringify({ event: "websocat_path_updated", dir }));
}

// ═══════════════════════════════════════════════════════════════════════

/** 8 random lowercase hex chars (4 bytes), for a unique default VM name suffix. */
function randomHex8(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Default VM name is `compute-<8 hex>` when --vm-name is not passed, so repeated
// runs get distinct names; an explicit --vm-name is used verbatim.
// Ensure websocat is available — download to tmpdir if no system binary exists.
await ensureWebsocat();

// ── console pause/resume for interactive SSH ───────────────────────────
// JSON log lines interleave with the SSH terminal — silence them during the
// session so the TTY is clean, then flush everything that was buffered.
// Must capture both console.* and raw Deno.stderr/stdout writes, since some
// libraries and Deno internals write directly to the stream.

const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origStderrWrite = Deno.stderr.write.bind(Deno.stderr);
const _origStdoutWrite = Deno.stdout.write.bind(Deno.stdout);
const _buf: Array<Uint8Array> = [];

function pauseConsole() {
  console.log = (...args: unknown[]) => {
    _buf.push(new TextEncoder().encode(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\n"));
  };
  console.error = (...args: unknown[]) => {
    _buf.push(new TextEncoder().encode(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\n"));
  };
  Deno.stderr.write = (data: Uint8Array) => { _buf.push(data); return data.length; };
  Deno.stdout.write = (data: Uint8Array) => { _buf.push(data); return data.length; };
}

async function resumeConsole() {
  console.log = _origLog;
  console.error = _origErr;
  Deno.stderr.write = _origStderrWrite;
  Deno.stdout.write = _origStdoutWrite;
  for (const chunk of _buf) {
    await _origStderrWrite(chunk);
  }
  _buf.length = 0;
}

// ═══════════════════════════════════════════════════════════════════════

const vmName = (() => { const i = Deno.args.indexOf("--vm-name"); return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : `compute-${randomHex8()}`; })();
const bidWindowSec = (() => { const i = Deno.args.indexOf("--bid-window-sec"); return i >= 0 ? parseInt(Deno.args[i + 1] ?? "30", 10) : 30; })();
const noDelete = Deno.args.includes("--no-delete");
const execProgram = (() => { const i = Deno.args.indexOf("--exec"); return i >= 0 ? Deno.args[i + 1] ?? "bash" : "bash"; })();
const vmReadyTimeoutSec = (() => { const i = Deno.args.indexOf("--vm-ready-timeout-sec"); return i >= 0 ? parseInt(Deno.args[i + 1] ?? "300", 10) : 300; })();

const pds = await createRequesterPDS();

// Wait for relay registration so proxyRef is set before the flow runs.
const { proxyRef, subdomain } = await pds.relayReady;
pds.proxyRef = proxyRef;
pds.relaySubdomain = subdomain;

await runComputeContract(pds, {
  vmName,
  bidWindowSec,
  skipSsh: false,
  noDelete,
  execProgram,
  vmReadyTimeoutSec,
  onSshStart: pauseConsole,
  onSshEnd: resumeConsole,
});

pds.stop();
console.log(JSON.stringify({ event: "cli_done", did: pds.did }));
Deno.exit(0);
