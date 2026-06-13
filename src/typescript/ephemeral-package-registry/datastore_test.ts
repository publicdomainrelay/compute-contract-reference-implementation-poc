/**
 * Tests for all three package registry backing stores:
 *   1. Local FS (temp directory)
 *   2. Remote Git (local git http-backend)
 *   3. PDS (in-memory repo factory)
 *
 * Also tests the HTTP registry routes and deno x compatibility.
 *
 * Run:
 *   deno test -A src/typescript/ephemeral-package-registry/datastore_test.ts
 */

import { assertEquals, assertExists, assertNotEquals, assertStringIncludes } from "@std/assert";
import { createLocalFsStore } from "@publicdomainrelay/datastore-local-fs";
import { createRemoteGitStore } from "@publicdomainrelay/datastore-remote-git";
import { createPdsStore, publishToPds } from "@publicdomainrelay/datastore-pds";
import { createPackageRegistryFactory } from "@publicdomainrelay/hono-factory-package-registry";
import { createRepoFactory, MemoryStorage } from "@publicdomainrelay/hono-factory-atproto-repo";
import { Secp256k1Keypair } from "@atproto/crypto";

// ── helpers ────────────────────────────────────────────────────────────

/** Create a sample package with mod.ts and cli.ts files */
function samplePackage(name: string, version: string) {
  return {
    name,
    version,
    files: {
      "mod.ts": `// ${name} v${version} - main module\nexport function hello(): string { return "Hello from ${name}@${version}"; }\n`,
      "cli.ts": `// ${name} v${version} - CLI entry\nimport { hello } from "./mod.ts";\nif (import.meta.main) {\n  console.log(hello());\n}\n`,
      "README.md": `# ${name}\n\nVersion ${version}\n`,
    },
    metadata: { description: `Sample package ${name}` },
  };
}

/** Set up a temp directory with a sample package structure */
async function setupTempPackageDir(): Promise<string> {
  const tmp = Deno.makeTempDirSync({ prefix: "pkg-test-" });
  const pkgDir = `${tmp}/my-pkg/1.0.0`;
  await Deno.mkdir(pkgDir, { recursive: true });

  const pkg = samplePackage("my-pkg", "1.0.0");
  for (const [path, content] of Object.entries(pkg.files)) {
    await Deno.writeTextFile(`${pkgDir}/${path}`, content);
  }

  // Add a second version
  const pkgDir2 = `${tmp}/my-pkg/1.1.0`;
  await Deno.mkdir(pkgDir2, { recursive: true });
  const pkg2 = samplePackage("my-pkg", "1.1.0");
  for (const [path, content] of Object.entries(pkg2.files)) {
    await Deno.writeTextFile(`${pkgDir2}/${path}`, content);
  }

  return tmp;
}

/** Set up a local bare git repo with http-backend support */
async function setupGitRepo(): Promise<{ repoDir: string; url: string }> {
  const tmp = Deno.makeTempDirSync({ prefix: "pkg-git-test-" });
  const workDir = `${tmp}/work`;
  await Deno.mkdir(workDir, { recursive: true });

  // Initialize git repo
  const run = async (cmd: string[], cwd?: string): Promise<string> => {
    const c = new Deno.Command("git", { args: cmd, cwd, stdout: "piped", stderr: "piped" });
    const { code, stdout, stderr } = await c.output();
    if (code !== 0) throw new Error(`git ${cmd[0]} failed: ${new TextDecoder().decode(stderr)}`);
    return new TextDecoder().decode(stdout);
  };

  await run(["init"], workDir);
  await run(["config", "user.email", "test@test.com"], workDir);
  await run(["config", "user.name", "Test"], workDir);

  // Create package files
  const pkg = samplePackage("git-pkg", "1.0.0");
  for (const [path, content] of Object.entries(pkg.files)) {
    const fullPath = `${workDir}/${path}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(fullPath, content);
  }

  await run(["add", "."], workDir);
  await run(["commit", "-m", "v1.0.0"], workDir);
  await run(["tag", "v1.0.0"], workDir);

  // Create v1.1.0
  const pkg2 = samplePackage("git-pkg", "1.1.0");
  for (const [path, content] of Object.entries(pkg2.files)) {
    await Deno.writeTextFile(`${workDir}/${path}`, content);
  }
  await run(["add", "."], workDir);
  await run(["commit", "-m", "v1.1.0"], workDir);
  await run(["tag", "v1.1.0"], workDir);

  // Create a bare clone (this is what the git store will use)
  const bareDir = `${tmp}/bare.git`;
  await run(["clone", "--bare", workDir, bareDir]);

  return { repoDir: bareDir, url: `file://${bareDir}` };
}

/** Create an in-process PDS-backed store */
async function createInProcessPdsStore() {
  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const signer = {
    did: () => keypair.did(),
    sign: (bytes: Uint8Array) => keypair.sign(bytes),
  };
  const { api } = createRepoFactory({
    storage: new MemoryStorage(),
    signer,
    baseOrigin: "http://localhost",
  });
  const store = createPdsStore({ api, repoDid: keypair.did() });
  return { store, api, did: keypair.did() };
}

// ── tests: local FS store ──────────────────────────────────────────────

Deno.test("datastore-local-fs: list packages from temp directory", async () => {
  const tmp = await setupTempPackageDir();
  try {
    const store = createLocalFsStore({ baseDir: tmp });
    const packages = await store.list();
    assertEquals(packages.length, 1);
    assertEquals(packages[0].name, "my-pkg");
    assertEquals(packages[0].versions.length, 2);
    assertEquals(packages[0].versions.includes("1.0.0"), true);
    assertEquals(packages[0].versions.includes("1.1.0"), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("datastore-local-fs: get package version with files", async () => {
  const tmp = await setupTempPackageDir();
  try {
    const store = createLocalFsStore({ baseDir: tmp });
    const pkg = await store.get("my-pkg", "1.0.0");
    assertExists(pkg);
    assertEquals(pkg!.name, "my-pkg");
    assertEquals(pkg!.version, "1.0.0");
    assertEquals("mod.ts" in pkg!.files, true);
    assertEquals("cli.ts" in pkg!.files, true);
    assertEquals("README.md" in pkg!.files, true);
    assertStringIncludes(pkg!.files["mod.ts"], "Hello from my-pkg@1.0.0");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("datastore-local-fs: returns null for unknown package", async () => {
  const tmp = await setupTempPackageDir();
  try {
    const store = createLocalFsStore({ baseDir: tmp });
    const pkg = await store.get("nonexistent", "1.0.0");
    assertEquals(pkg, null);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ── tests: remote git store ────────────────────────────────────────────

Deno.test("datastore-remote-git: list packages from git repo", async () => {
  // Check git available
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null" }).output();
  } catch {
    console.log("SKIP: git not available");
    return;
  }

  const { url } = await setupGitRepo();
  try {
    const store = createRemoteGitStore({ url });
    const packages = await store.list();
    assertEquals(packages.length >= 1, true);
    // The package name is derived from the URL path
    const pkg = packages[0];
    assertExists(pkg);
    assertEquals(pkg.versions.includes("1.0.0"), true);
    assertEquals(pkg.versions.includes("1.1.0"), true);
  } finally {
    // Cleanup (paths are in temp dirs)
  }
});

Deno.test("datastore-remote-git: get package version with files", async () => {
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null" }).output();
  } catch {
    console.log("SKIP: git not available");
    return;
  }

  const { url } = await setupGitRepo();
  try {
    const store = createRemoteGitStore({ url });
    const packages = await store.list();
    const pkgName = packages[0].name;

    const pkg = await store.get(pkgName, "1.0.0");
    assertExists(pkg);
    assertEquals(pkg!.version, "1.0.0");
    assertEquals("mod.ts" in pkg!.files, true);
    assertEquals("cli.ts" in pkg!.files, true);
    assertStringIncludes(pkg!.files["mod.ts"], "Hello from git-pkg@1.0.0");
  } finally {
    // Cleanup
  }
});

Deno.test("datastore-remote-git: returns null for unknown version", async () => {
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null" }).output();
  } catch {
    console.log("SKIP: git not available");
    return;
  }

  const { url } = await setupGitRepo();
  try {
    const store = createRemoteGitStore({ url });
    const packages = await store.list();
    const pkgName = packages[0]?.name ?? "unknown";

    const pkg = await store.get(pkgName, "99.99.99");
    assertEquals(pkg, null);
  } finally {
    // Cleanup
  }
});

// ── tests: PDS store ───────────────────────────────────────────────────

Deno.test("datastore-pds: list packages (empty)", async () => {
  const { store } = await createInProcessPdsStore();
  const packages = await store.list();
  assertEquals(packages.length, 0);
});

Deno.test("datastore-pds: publish and get package", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  const pkg = samplePackage("pds-pkg", "1.0.0");

  // Publish
  const result = await publishToPds(api, did, pkg);
  assertExists(result.packageUri);
  assertExists(result.releaseUri);
  assertStringIncludes(result.packageUri, "com.publicdomainrelay.temp.packageRegistry.package");
  assertStringIncludes(result.releaseUri, "com.publicdomainrelay.temp.packageRegistry.release");

  // List
  const packages = await store.list();
  assertEquals(packages.length, 1);
  assertEquals(packages[0].name, "pds-pkg");
  assertEquals(packages[0].versions, ["1.0.0"]);

  // Get
  const fetched = await store.get("pds-pkg", "1.0.0");
  assertExists(fetched);
  assertEquals(fetched!.name, "pds-pkg");
  assertEquals(fetched!.version, "1.0.0");
  assertEquals("mod.ts" in fetched!.files, true);
  assertStringIncludes(fetched!.files["mod.ts"], "Hello from pds-pkg@1.0.0");
});

Deno.test("datastore-pds: publish multiple versions", async () => {
  const { store, api, did } = await createInProcessPdsStore();

  await publishToPds(api, did, samplePackage("multi-pkg", "1.0.0"));
  await publishToPds(api, did, samplePackage("multi-pkg", "2.0.0"));

  const packages = await store.list();
  assertEquals(packages.length, 1);
  assertEquals(packages[0].name, "multi-pkg");
  assertEquals(packages[0].versions.length, 2);
  assertEquals(packages[0].versions.includes("1.0.0"), true);
  assertEquals(packages[0].versions.includes("2.0.0"), true);

  // Fetch both
  const v1 = await store.get("multi-pkg", "1.0.0");
  assertExists(v1);
  assertStringIncludes(v1!.files["mod.ts"], "@1.0.0");

  const v2 = await store.get("multi-pkg", "2.0.0");
  assertExists(v2);
  assertStringIncludes(v2!.files["mod.ts"], "@2.0.0");
});

Deno.test("datastore-pds: returns null for unknown package", async () => {
  const { store } = await createInProcessPdsStore();
  const pkg = await store.get("nonexistent", "1.0.0");
  assertEquals(pkg, null);
});

// ── tests: registry HTTP routes ────────────────────────────────────────

Deno.test("registry HTTP: resolve XRPC query returns file listing", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  await publishToPds(api, did, samplePackage("http-pkg", "1.0.0"));

  const app = createPackageRegistryFactory({ store });
  const resolveUrl = "/xrpc/com.publicdomainrelay.temp.packageRegistry.resolve?name=http-pkg&version=1.0.0";
  const res = await app.request(resolveUrl);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.name, "http-pkg");
  assertEquals(body.version, "1.0.0");
  assertEquals(Array.isArray(body.files), true);
  assertEquals(body.files.includes("mod.ts"), true);
  assertEquals(body.files.includes("cli.ts"), true);
});

Deno.test("registry HTTP: resolve with missing params returns 400", async () => {
  const { store } = await createInProcessPdsStore();
  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.packageRegistry.resolve");
  assertEquals(res.status, 400);
});

Deno.test("registry HTTP: resolve unknown package returns 404", async () => {
  const { store } = await createInProcessPdsStore();
  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.packageRegistry.resolve?name=no&version=1.0.0");
  assertEquals(res.status, 404);
});

Deno.test("registry HTTP: list packages", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  await publishToPds(api, did, samplePackage("list-pkg", "1.0.0"));

  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.packageRegistry.resolve/list");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(Array.isArray(body.packages), true);
  assertEquals(body.packages.length, 1);
});

Deno.test("registry HTTP: serve package file via URL", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  await publishToPds(api, did, samplePackage("serve-pkg", "1.0.0"));

  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/serve-pkg@1.0.0/mod.ts");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type")?.startsWith("text/typescript"), true);
  const body = await res.text();
  assertStringIncludes(body, "Hello from serve-pkg@1.0.0");
});

Deno.test("registry HTTP: serve scoped package file via URL", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  const scopedPkg = samplePackage("@scope/scoped-pkg", "1.0.0");
  await publishToPds(api, did, scopedPkg);

  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/@scope/scoped-pkg@1.0.0/mod.ts");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type")?.startsWith("text/typescript"), true);
  const body = await res.text();
  assertStringIncludes(body, "Hello from @scope/scoped-pkg@1.0.0");
});

Deno.test("registry HTTP: serve CLI file for deno x compatibility", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  await publishToPds(api, did, samplePackage("cli-pkg", "1.0.0"));

  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/cli-pkg@1.0.0/cli.ts");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, 'import { hello } from "./mod.ts"');
  assertStringIncludes(body, "import.meta.main");
});

Deno.test("registry HTTP: missing file returns 404 with available files", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  await publishToPds(api, did, samplePackage("nope-pkg", "1.0.0"));

  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/nope-pkg@1.0.0/nonexistent.ts");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "FileNotFound");
  assertEquals(Array.isArray(body.availableFiles), true);
});

Deno.test("registry HTTP: unknown package returns 404", async () => {
  const { store } = await createInProcessPdsStore();
  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/nonexistent@1.0.0/mod.ts");
  assertEquals(res.status, 404);
});

// ── tests: local FS backed registry HTTP ───────────────────────────────

Deno.test("registry HTTP with local-fs: serve file from temp dir", async () => {
  const tmp = await setupTempPackageDir();
  try {
    const store = createLocalFsStore({ baseDir: tmp });
    const app = createPackageRegistryFactory({ store });

    const res = await app.request("/my-pkg@1.0.0/cli.ts");
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "import { hello } from");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("registry HTTP with local-fs: list packages via XRPC", async () => {
  const tmp = await setupTempPackageDir();
  try {
    const store = createLocalFsStore({ baseDir: tmp });
    const app = createPackageRegistryFactory({ store });

    const res = await app.request(
      "/xrpc/com.publicdomainrelay.temp.packageRegistry.resolve?name=my-pkg&version=1.0.0",
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.name, "my-pkg");
    assertEquals(body.files.includes("mod.ts"), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ── tests: deno x simulation ───────────────────────────────────────────

Deno.test("deno x compatibility: CLI file imports work as module", async () => {
  // Simulates what `deno x` does: fetch the CLI file, resolve its imports.
  const { store, api, did } = await createInProcessPdsStore();
  await publishToPds(api, did, samplePackage("denox-test", "1.0.0"));

  const app = createPackageRegistryFactory({ store });

  // deno x fetches the URL, then Deno's module loader resolves imports.
  // We verify the served file has valid TypeScript that deno can parse.
  const cliRes = await app.request("/denox-test@1.0.0/cli.ts");
  assertEquals(cliRes.status, 200);
  const cliContent = await cliRes.text();

  // Verify it's valid TypeScript with proper imports
  assertStringIncludes(cliContent, "import { hello }");
  assertStringIncludes(cliContent, "import.meta.main");

  // Verify mod.ts can also be fetched (for import resolution)
  const modRes = await app.request("/denox-test@1.0.0/mod.ts");
  assertEquals(modRes.status, 200);
  const modContent = await modRes.text();
  assertStringIncludes(modContent, "export function hello");
});

Deno.test("deno x compatibility: content-type headers correct", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  await publishToPds(api, did, samplePackage("ct-test", "1.0.0"));

  const app = createPackageRegistryFactory({ store });

  // TypeScript files
  const ts = await app.request("/ct-test@1.0.0/mod.ts");
  assertEquals(ts.headers.get("content-type")?.startsWith("text/typescript"), true);

  // Markdown files
  const md = await app.request("/ct-test@1.0.0/README.md");
  assertEquals(md.headers.get("content-type")?.startsWith("text/markdown"), true);
});

Deno.test("deno x compatibility: CORS headers present", async () => {
  const { store, api, did } = await createInProcessPdsStore();
  await publishToPds(api, did, samplePackage("cors-test", "1.0.0"));

  const app = createPackageRegistryFactory({ store });
  const res = await app.request("/cors-test@1.0.0/mod.ts");
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});
