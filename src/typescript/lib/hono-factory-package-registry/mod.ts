/**
 * @publicdomainrelay/hono-factory-package-registry — Hono factory for a
 * package registry that serves TypeScript source files over HTTP and XRPC.
 *
 * createPackageRegistryFactory(store) returns a Hono app.
 * The app mounts:
 *   - GET /xrpc/com.publicdomainrelay.temp.packageRegistry.resolve
 *       Query: ?name=<package>&version=<semver>
 *       Returns: { name, version, files, metadata }
 *   - GET /xrpc/com.publicdomainrelay.temp.packageRegistry.resolve/list
 *       Returns: { packages: PackageEntry[] }
 *   - JSR-compatible endpoints:
 *       GET /@scope/name/meta.json      → package metadata with version list
 *       GET /@scope/name/<v>_meta.json  → version metadata (exports, manifest)
 *   - HTTP file serving (both URL styles):
 *       GET /@scope/name@version/path/file.ts   (at-style)
 *       GET /@scope/name/version/path/file.ts   (JSR-style, / separator)
 *       GET /name@version/path/file.ts
 *       GET /name/version/path/file.ts
 *   - jsr.io proxy: unknown packages are proxied transparently so
 *     DENO_REGISTRY_URL can point here for all JSR traffic.
 *
 * Usage:
 *   const app = createPackageRegistryFactory({ store })
 *   Deno.serve(app.fetch)
 */

import { Hono } from "hono";
import type { PackageStore } from "@publicdomainrelay/datastore-package";
import { PACKAGE_REGISTRY_RESOLVE_NSID } from "@publicdomainrelay/lexicons";

// ── types ──────────────────────────────────────────────────────────────

export interface PackageRegistryOptions {
  store: PackageStore;
  /** Optional human-readable label for logging */
  label?: string;
}

// ── URL parsing helpers ────────────────────────────────────────────────

interface ParsedPackageUrl {
  scope?: string;
  name: string;
  version: string;
  filePath: string;
}

/**
 * Parse "at-style" URL: /@scope/name@version/path/file.ts
 * Our original URL format using '@' between name and version.
 */
function parsePackageUrl(pathname: string): ParsedPackageUrl | null {
  const path = pathname.replace(/^\/+/, "");
  const m = path.match(/^(?:@([^/]+)\/)?([^/@]+)@([^/]+)(?:\/(.*))?$/);
  if (!m) return null;

  const [, scope, pkgName, version, filePath] = m;
  const fullName = scope ? `@${scope}/${pkgName}` : pkgName;

  return { scope, name: fullName, version, filePath: filePath ?? "" };
}

/**
 * Parse JSR-style URL: /@scope/name/version/path/file.ts
 * Uses '/' between name and version (JSR-compatible).
 *
 * Version may be a semver tag, branch name, or commit SHA. The '$' prefix
 * can be used to mark a git ref explicitly (e.g. /@scope/name/$main/mod.ts).
 * meta.json and _meta.json routes are handled before this parser, so
 * non-numeric versions won't collide with metadata endpoints.
 */
function parseJsrUrl(pathname: string): ParsedPackageUrl | null {
  const path = pathname.replace(/^\/+/, "");
  // Match: [@scope/]name/version[/file/path]
  const m = path.match(
    /^(?:@([^/]+)\/)?([^/@]+)\/([^/]+)(?:\/(.*))?$/,
  );
  if (!m) return null;

  const [, scope, pkgName, version, filePath] = m;
  const fullName = scope ? `@${scope}/${pkgName}` : pkgName;

  return { scope, name: fullName, version, filePath: filePath ?? "" };
}

// ── response helpers ──────────────────────────────────────────────────

function contentType(filePath: string): string {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
    return "text/typescript; charset=utf-8";
  }
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx") || filePath.endsWith(".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function serveFile(filePath: string, content: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": contentType(filePath),
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}

/** SHA-256 checksum of a string, hex-encoded. */
async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build a manifest from package files (JSR _meta.json format). */
async function buildManifest(
  files: Record<string, string>,
): Promise<Record<string, { size: number; checksum: string }>> {
  const manifest: Record<string, { size: number; checksum: string }> = {};
  for (const [path, content] of Object.entries(files)) {
    manifest[`/${path}`] = {
      size: new TextEncoder().encode(content).length,
      checksum: `sha256-${await sha256Hex(content)}`,
    };
  }
  return manifest;
}

/**
 * Auto-detect the entrypoint for a package when no exports map is
 * provided. Prefers mod.ts, then any .ts/.js file.
 */
function autoDetectEntry(files: Record<string, string>): string {
  if ("mod.ts" in files) return "./mod.ts";
  if ("mod.js" in files) return "./mod.js";
  const ts = Object.keys(files).find((f) =>
    f.endsWith(".ts") || f.endsWith(".js")
  );
  return ts ? `./${ts}` : "./mod.ts";
}

/** Full package name from scope + name parts. */
function fullName(scope: string | undefined, name: string): string {
  return scope ? `@${scope}/${name}` : name;
}

// ── jsr.io proxy ──────────────────────────────────────────────────────

const JSR_BASE = "https://jsr.io";

// ── factory ────────────────────────────────────────────────────────────

export function createPackageRegistryFactory(
  opts: PackageRegistryOptions,
): Hono {
  const { store, label } = opts;
  const LABEL = label ?? "pkg-registry";
  const app = new Hono();

  // ── structured logging ─────────────────────────────────────────────
  const logInfo = (obj: Record<string, unknown>) => console.log(JSON.stringify(obj));
  const log = (
    severity: string,
    msg: string,
    extra?: Record<string, unknown>,
  ) => logInfo({ label: LABEL, severity, message: msg, ...(extra ?? {}) });

  // ── access log middleware ──────────────────────────────────────────
  app.use("*", async (c, next) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const start = performance.now();
    log("info", "request", { event: "request", method, path });
    await next();
    const durationMs = Math.round(performance.now() - start);
    const status = c.res.status;
    const logEntry: Record<string, unknown> = {
      event: "response",
      method,
      path,
      status,
      durationMs,
    };
    if (status >= 400) {
      let responseBody: unknown;
      try {
        const text = await c.res.clone().text();
        try { responseBody = JSON.parse(text); } catch { responseBody = text; }
      } catch { responseBody = null; }
      logEntry.responseBody = responseBody;
      log("error", `response ${status}`, logEntry);
    } else {
      log("info", `response ${status}`, logEntry);
    }
  });

  // ── jsr.io proxy ──────────────────────────────────────────────────
  /**
   * Proxy a request to jsr.io. Used when a package is not found in the
   * local store — this makes DENO_REGISTRY_URL transparent for all JSR
   * traffic.
   */
  async function proxyToJsr(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const target = `${JSR_BASE}${url.pathname}${url.search}`;
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          "accept": req.headers.get("accept") ?? "*/*",
          "user-agent": "pdr-package-registry",
        },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ??
            "application/octet-stream",
          "cache-control": upstream.headers.get("cache-control") ??
            "public, max-age=3600",
          "access-control-allow-origin": "*",
          "cross-origin-resource-policy": "cross-origin",
        },
      });
    } catch (err) {
      log("error", "jsr.io proxy error", { target, error: String(err) });
      return new Response("Bad Gateway", { status: 502 });
    }
  }

  // ── import map: resolve all bare specifiers to this registry ─────

  /** Semver-like version pattern. */
  const SEMVER_RE = /^\d+\.\d+\.\d+/;

  app.get("/import-map.json", async (c) => {
    const imports: Record<string, string> = {};
    const host = new URL(c.req.url).host;
    const base = `http://${host}`;

    try {
      const packages = await store.list();
      for (const pkg of packages) {
        // Prefer 0.1.0-main (branch pseudo-semver) since it has the most
        // up-to-date deno.json with proper jsr: imports. Fall back to latest
        // semver tag if main branch not available.
        let version: string | null = null;
        let pkgData: { name: string; version: string; files: Record<string, string>; metadata?: Record<string, unknown> } | null = null;

        // Try main branch pseudo-semver first
        for (const branchVer of ["0.1.0-main", "0.1.0-master"]) {
          if (pkg.versions.includes(branchVer)) {
            version = branchVer;
            pkgData = await store.get(pkg.name, version);
            if (pkgData) break;
          }
        }

        // Fallback: latest semver tag
        if (!pkgData) {
          version = [...pkg.versions].reverse().find((v) => SEMVER_RE.test(v)) ?? null;
          if (version) {
            pkgData = await store.get(pkg.name, version);
          }
        }

        // Last resort: try direct branch refs
        if (!pkgData) {
          for (const branch of ["main", "master"]) {
            version = `$${branch}`;
            pkgData = await store.get(pkg.name, version);
            if (pkgData) break;
          }
        }

        if (!pkgData) continue;

        // Determine entrypoint
        const exports = pkgData.metadata?.exports as Record<string, string> | undefined;
        const entry = exports?.["."] ?? autoDetectEntry(pkgData.files);

        // Map bare specifier to registry URL
        imports[pkg.name] = `${base}/@${pkg.name.replace(/^@/, "")}@${version}/${entry.replace(/^\.\//, "")}`;
        // Also map with trailing / for subpath imports
        imports[`${pkg.name}/`] = `${base}/@${pkg.name.replace(/^@/, "")}@${version}/`;

        // Collect npm/jsr passthroughs from deno.json imports.
        // For jsr: targets that reference packages in this registry,
        // resolve to local HTTP URLs instead of jsr.io.
        const denoImports = pkgData.metadata?.denoJson?.imports as Record<string, string> | undefined;
        if (denoImports) {
          for (const [specifier, target] of Object.entries(denoImports)) {
            if (target.startsWith("npm:")) {
              if (!imports[specifier]) imports[specifier] = target;
              // Subpath mapping with clean version: pkg/ → npm:pkg@version/
              // e.g., npm:multiformats@^13.3.0 → npm:multiformats@13.3.0/path
              const npmClean = target.slice(4); // "multiformats@^13.3.0"
              if (!imports[`${specifier}/`]) {
                imports[`${specifier}/`] = `npm:${npmClean}/`;
              }
              // Scoped prefix: @scope/ → npm:@scope/
              const scopeMatch = specifier.match(/^(@[^/]+\/)/);
              if (scopeMatch && !imports[scopeMatch[1]]) {
                imports[scopeMatch[1]] = `npm:${scopeMatch[1]}`;
              }
            } else if (target.startsWith("jsr:")) {
              // Check if this JSR package exists in our registry
              const jsrSpec = target.slice(4); // remove "jsr:"
              const jsrMatch = jsrSpec.match(/^(@[^/]+\/[^/@]+)(?:@[^/]+)?(?:\/(.*))?$/);
              if (jsrMatch) {
                const jsrPkgName = jsrMatch[1];
                // Try to resolve this package locally
                let localVersion: string | null = null;
                const localPkg = packages.find((p) => p.name === jsrPkgName);
                if (localPkg) {
                  // Prefer main branch (most up-to-date deno.json), then latest semver
                  for (const branchVer of ["0.1.0-main", "0.1.0-master"]) {
                    if (localPkg.versions.includes(branchVer)) {
                      localVersion = branchVer;
                      break;
                    }
                  }
                  if (!localVersion) {
                    localVersion = [...localPkg.versions].reverse().find((v) => SEMVER_RE.test(v)) ?? null;
                  }
                }
                if (localVersion) {
                  // Map to local registry URL
                  const subPath = jsrMatch[2] ?? "";
                  const urlPath = `@${jsrPkgName.replace(/^@/, "")}@${localVersion}/${subPath}`;
                  if (!imports[specifier]) {
                    imports[specifier] = `${base}/${urlPath}`;
                  }
                  if (!specifier.endsWith("/")) {
                    const scopeMatch = specifier.match(/^(@[^/]+\/)/);
                    if (scopeMatch && !imports[scopeMatch[1]]) {
                      imports[scopeMatch[1]] = `${base}/@${jsrPkgName.replace(/^@/, "")}@${localVersion}/`;
                    }
                  }
                } else {
                  // Not local — passthrough to jsr.io
                  if (!imports[specifier]) imports[specifier] = target;
                  const scopeMatch = specifier.match(/^(@[^/]+\/)/);
                  if (scopeMatch && !imports[scopeMatch[1]]) {
                    imports[scopeMatch[1]] = `jsr:${scopeMatch[1]}`;
                  }
                }
              }
            }
          }
        }
      }
    } catch (err) {
      log("error", "import-map generation error", { error: String(err) });
    }

    return c.json({ imports });
  });

  // ── XRPC: resolve by name+version ────────────────────────────────

  app.get(`/xrpc/${PACKAGE_REGISTRY_RESOLVE_NSID}`, async (c) => {
    const name = c.req.query("name");
    const version = c.req.query("version");

    if (!name || !version) {
      return c.json(
        { error: "InvalidRequest", message: "name and version required" },
        400,
      );
    }

    try {
      const pkg = await store.get(name, version);
      if (!pkg) {
        return c.json(
          { error: "PackageNotFound", message: `${name}@${version} not found` },
          404,
        );
      }
      return c.json({
        name: pkg.name,
        version: pkg.version,
        files: Object.keys(pkg.files).sort(),
        metadata: pkg.metadata ?? {},
      });
    } catch (err) {
      log("error", "resolve error", { error: String(err) });
      return c.json({ error: "InternalError", message: String(err) }, 500);
    }
  });

  // ── XRPC: list all packages ──────────────────────────────────────

  app.get(`/xrpc/${PACKAGE_REGISTRY_RESOLVE_NSID}/list`, async (c) => {
    try {
      const packages = await store.list();
      return c.json({ packages });
    } catch (err) {
      log("error", "list error", { error: String(err) });
      return c.json({ error: "InternalError", message: String(err) }, 500);
    }
  });

  // ── JSR: package metadata (meta.json) ────────────────────────────
  //
  // GET /@scope/name/meta.json  → scoped
  // GET /name/meta.json         → unscoped
  //
  // Registered BEFORE the catch-all so Hono matches these first.

  // Scoped: /@scope/name/meta.json
  app.get("/@:scope/:name/meta.json", async (c) => {
    const scope = c.req.param("scope");
    const pkgName = c.req.param("name");
    const fqn = fullName(scope, pkgName);

    try {
      const packages = await store.list();
      const entry = packages.find((p) => p.name === fqn);

      if (!entry) return proxyToJsr(c.req.raw);

      // Filter to only include real semver versions (exclude branch
      // pseudo-semver like 0.1.0-main which JSR rejects).
      const jsrVersions = entry.versions.filter((v) => !v.startsWith("0.1.0-"));
      if (jsrVersions.length === 0) return proxyToJsr(c.req.raw);

      const versions: Record<string, Record<string, unknown>> = {};
      for (const v of jsrVersions) {
        versions[v] = {};
      }

      const latest = jsrVersions[jsrVersions.length - 1];

      return c.json({ scope, name: pkgName, latest, versions });
    } catch (err) {
      log("error", "meta.json error", { package: fqn, error: String(err) });
      return proxyToJsr(c.req.raw);
    }
  });

  // Unscoped: /name/meta.json
  app.get("/:name/meta.json", async (c) => {
    const pkgName = c.req.param("name");
    // Skip if it's our XRPC route or other special paths
    if (pkgName === "xrpc") {
      return c.json({ error: "NotFound" }, 404);
    }

    try {
      const packages = await store.list();
      const entry = packages.find((p) => p.name === pkgName);

      if (!entry) return proxyToJsr(c.req.raw);

      // Filter to only include real semver versions
      const jsrVersions = entry.versions.filter((v) => !v.startsWith("0.1.0-"));
      if (jsrVersions.length === 0) return proxyToJsr(c.req.raw);

      const versions: Record<string, Record<string, unknown>> = {};
      for (const v of jsrVersions) {
        versions[v] = {};
      }

      const latest = jsrVersions[jsrVersions.length - 1];

      return c.json({ name: pkgName, latest, versions });
    } catch (err) {
      log("error", "meta.json error", { package: pkgName, error: String(err) });
      return proxyToJsr(c.req.raw);
    }
  });

  // ── JSR: version metadata (_meta.json) + file serving (catch-all) ─
  //
  // GET /@scope/name/<version>_meta.json  → version metadata
  // GET /@scope/name@version/path/file.ts  → file (at-style)
  // GET /@scope/name/version/path/file.ts  → file (JSR-style)
  //
  // _meta.json is handled here (not as separate routes) because Hono's
  // segment-based routing can't split "1.0.0_meta.json" into param + literal.
  //
  // Unknown paths are proxied to jsr.io so DENO_REGISTRY_URL works
  // transparently for all JSR traffic.

  app.get("/*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // ── _meta.json: version metadata ───────────────────────────────
    // Match: /@scope/name/<version>_meta.json  or  /name/<version>_meta.json
    const metaVersionMatch = pathname.match(
      /^\/(?:@([^/]+)\/)?([^/@]+)\/([^/]+)_meta\.json$/,
    );
    if (metaVersionMatch) {
      const [, scope, pkgName, version] = metaVersionMatch;
      const fqn = fullName(scope, pkgName);

      try {
        const pkg = await store.get(fqn, version);
        if (!pkg) return proxyToJsr(c.req.raw);

        const exportsMap =
          (pkg.metadata?.exports as Record<string, string>) ??
          { ".": autoDetectEntry(pkg.files) };

        const manifest = await buildManifest(pkg.files);

        return c.json({ exports: exportsMap, manifest, moduleGraph2: {} });
      } catch (err) {
        log("error", "_meta.json error", { package: fqn, version, error: String(err) });
        return proxyToJsr(c.req.raw);
      }
    }

    // ── meta.json: package metadata (fallback) ───────────────────
    // Handles both /@scope/name/meta.json and /name/meta.json.
    // The explicit /@:scope/:name/meta.json route may not match due to
    // Hono router behaviour; this regex in the catch-all ensures both
    // scoped and unscoped patterns work.
    const metaPkgMatch = pathname.match(
      /^\/(?:@([^/]+)\/)?([^/@]+)\/meta\.json$/,
    );
    if (metaPkgMatch) {
      const [, scope, pkgName] = metaPkgMatch;
      const fqn = fullName(scope, pkgName);

      try {
        const packages = await store.list();
        const entry = packages.find((p) => p.name === fqn);

        if (entry) {
          const jsrVersions = entry.versions.filter((v) => !v.startsWith("0.1.0-"));
          if (jsrVersions.length === 0) return proxyToJsr(c.req.raw);
          const versions: Record<string, Record<string, unknown>> = {};
          for (const v of jsrVersions) versions[v] = {};
          const latest = jsrVersions[jsrVersions.length - 1];
          return c.json(
            scope
              ? { scope, name: pkgName, latest, versions }
              : { name: pkgName, latest, versions },
          );
        }
      } catch { /* fall through to proxy */ }
      return proxyToJsr(c.req.raw);
    }

    // ── file serving ───────────────────────────────────────────────
    // Try at-style parser first, then JSR-style
    let parsed = parsePackageUrl(pathname) ?? parseJsrUrl(pathname);

    if (!parsed) {
      if (pathname.startsWith("/.well-known/")) {
        return c.json({ error: "NotFound" }, 404);
      }
      return proxyToJsr(c.req.raw);
    }

    try {
      const pkg = await store.get(parsed.name, parsed.version);
      if (!pkg) return proxyToJsr(c.req.raw);

      let filePath = parsed.filePath;
      if (!filePath) {
        filePath = "mod.ts" in pkg.files
          ? "mod.ts"
          : Object.keys(pkg.files).find((f) =>
            f.endsWith(".ts") || f.endsWith(".js")
          ) ?? "";
      }

      // Auto-resolve extensionless imports: try common TypeScript/JS extensions
      const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cts", "/index.ts", "/index.js", "/mod.ts", "/mod.js"];
      let resolvedPath: string | null = null;
      let content: string | undefined;

      if (pkg.files[filePath] !== undefined) {
        resolvedPath = filePath;
        content = pkg.files[filePath];
      } else {
        for (const ext of extensions) {
          const candidate = filePath + ext;
          if (pkg.files[candidate] !== undefined) {
            resolvedPath = candidate;
            content = pkg.files[candidate];
            break;
          }
        }
      }

      if (content === undefined) {
        return c.json({
          error: "FileNotFound",
          message: `${filePath} not found in ${parsed.name}@${parsed.version}`,
          availableFiles: Object.keys(pkg.files).sort(),
        }, 404);
      }

      return serveFile(resolvedPath ?? filePath, content);
    } catch (err) {
      log("error", "serve error", { error: String(err) });
      return c.json({ error: "InternalError", message: String(err) }, 500);
    }
  });

  return app;
}
