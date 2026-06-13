/**
 * End-to-end test: start a local HTTP registry, serve a package,
 * and verify `deno x` can run it.
 *
 * Run:
 *   deno run -A src/typescript/ephemeral-package-registry/denox_e2e_test.ts
 */
import { createLocalFsStore } from "@publicdomainrelay/datastore-local-fs";
import { createPackageRegistryFactory } from "@publicdomainrelay/hono-factory-package-registry";

// Create a standalone package with no external deps
const tmp = Deno.makeTempDirSync({ prefix: "denox-e2e-" });
const pkgDir = `${tmp}/hello-cli/1.0.0`;
await Deno.mkdir(pkgDir, { recursive: true });

await Deno.writeTextFile(`${pkgDir}/cli.ts`, `
const args = Deno.args;
const name = args[0] || "world";
console.log(\`Hello \${name} from self-hosted package registry!\`);
console.log("deno x works ✅");
`);

const store = createLocalFsStore({ baseDir: tmp });
const app = createPackageRegistryFactory({ store, label: "denox-e2e" });

const PORT = 18766;
const ac = new AbortController();
console.log(`Starting registry on http://localhost:${PORT}`);
Deno.serve({ port: PORT, signal: ac.signal }, app.fetch);

// Wait for server to be ready
await new Promise(r => setTimeout(r, 400));

// ── Test 1: HTTP fetch ───────────────────────────────────────────
const res = await fetch(`http://localhost:${PORT}/hello-cli@1.0.0/cli.ts`);
console.log(`HTTP GET: ${res.status} ${res.headers.get("content-type")}`);
const body = await res.text();
console.log(`Content: ${body.trim().split('\n')[0]}`);

// ── Test 2: XRPC resolve ─────────────────────────────────────────
const xrpcRes = await fetch(`http://localhost:${PORT}/xrpc/com.publicdomainrelay.temp.packageRegistry.resolve?name=hello-cli&version=1.0.0`);
const xrpcBody = await xrpcRes.json();
console.log(`XRPC resolve: ${xrpcRes.status} files=${xrpcBody.files}`);

// ── Test 3: deno x ───────────────────────────────────────────────
console.log("\n--- deno x test ---");
const cmd = new Deno.Command("deno", {
  args: ["x", `http://localhost:${PORT}/hello-cli@1.0.0/cli.ts`, "RegistryUser"],
  stdout: "piped",
  stderr: "piped",
});
const { code, stdout, stderr } = await cmd.output();
const outStr = new TextDecoder().decode(stdout).trim();
const errStr = new TextDecoder().decode(stderr).trim();
if (outStr) console.log("stdout:", outStr);
if (errStr) {
  // Only show stderr if it's not just Deno download progress
  const filtered = errStr.split('\n').filter(l => !l.includes('Download') && !l.includes('http')).join('\n');
  if (filtered.trim()) console.log("stderr:", filtered);
}
console.log(`Exit: ${code}`);

// Cleanup
ac.abort();
try { await Deno.remove(tmp, { recursive: true }); } catch { /* ok */ }

if (code === 0) {
  console.log("\n✅ deno x works with self-hosted package registry!");
} else {
  console.log("\n❌ deno x failed");
  Deno.exit(1);
}
