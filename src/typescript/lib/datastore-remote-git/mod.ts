/**
 * @publicdomainrelay/datastore-remote-git — PackageStore backed by a remote git
 * repository.
 *
 * Monorepo-aware: scans each git tag for `deno.json` files in subdirectories.
 * Each `deno.json` with a `name` field becomes a discovered package. Falls
 * back to whole-repo-as-one-package mode when no sub-package deno.json files
 * are found.
 *
 * Uses `git` CLI under the hood (requires git installed). Maintains a local
 * bare clone for efficient fetches.
 *
 * Options:
 *   - url: remote git URL (https:// or git@)
 *   - cacheDir: directory for bare clone cache (default: system temp)
 */

import type { PackageEntry, PackageStore, PackageVersion } from "@publicdomainrelay/datastore-package";

export interface RemoteGitStoreOptions {
  /** Remote git repository URL */
  url: string;
  /** Directory for bare clone cache (default: OS temp dir) */
  cacheDir?: string;
}

/** Derive package name from git URL (fallback when no deno.json found). */
function derivePackageName(url: string): string {
  let name = url.replace(/\.git$/, "");
  const match = name.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
  if (match) return `@${match[1]}`; // "@owner/repo"
  const parts = name.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "unknown";
}

/** Semver-like tag pattern: optional 'v' prefix, then digits. */
const VERSION_TAG_RE = /^v?\d+\.\d+\.\d+/;

/** Strip leading 'v' from a tag to get the semver version. */
function tagToVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

/** Run a git command, return stdout as string. Throws on non-zero exit. */
async function git(args: string[], cwd?: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`git ${args[0]} failed (exit ${code}): ${err.trim()}`);
  }
  return new TextDecoder().decode(stdout);
}

/** Read a file from the bare repo at a given tag. Returns null on failure. */
async function readFileAtTag(
  repoDir: string,
  tag: string,
  path: string,
): Promise<string | null> {
  try {
    return await git(["show", `${tag}:${path}`], repoDir);
  } catch {
    return null;
  }
}

// ── monorepo discovery ──────────────────────────────────────────────────

interface PackageMeta {
  /** Subdirectory within the repo, e.g. "src/typescript/lib/datastore-package" */
  subdir: string;
  /** Parsed deno.json contents */
  denoJson: {
    name?: string;
    version?: string;
    exports?: string | Record<string, string>;
    description?: string;
    [key: string]: unknown;
  };
}

/**
 * Discover packages at a given tag by scanning for deno.json files.
 * Returns Map<packageName, PackageMeta>. Falls back to whole-repo mode
 * if no deno.json files with a `name` field are found.
 */
async function discoverPackages(
  repoDir: string,
  tag: string,
): Promise<Map<string, PackageMeta>> {
  const pkgs = new Map<string, PackageMeta>();

  // List all files at this tag
  const fileList = await git(
    ["ls-tree", "-r", "--name-only", tag],
    repoDir,
  );
  const paths = fileList.trim().split("\n").filter(Boolean);

  // Find deno.json files
  const denoJsonPaths = paths.filter((p) =>
    p.endsWith("deno.json") || p.endsWith("deno.jsonc")
  );

  for (const denoPath of denoJsonPaths) {
    const content = await readFileAtTag(repoDir, tag, denoPath);
    if (!content) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue; // invalid JSON, skip
    }

    const name = typeof parsed.name === "string" ? parsed.name : undefined;
    if (!name) continue; // no package name, skip

    // Subdirectory is the directory containing deno.json
    const subdir = denoPath.replace(/\/?deno\.jsonc?$/, "");

    // Ensure exports is a string or record
    let exports: string | Record<string, string> | undefined;
    if (typeof parsed.exports === "string") {
      exports = parsed.exports;
    } else if (parsed.exports && typeof parsed.exports === "object") {
      exports = parsed.exports as Record<string, string>;
    }

    pkgs.set(name, {
      subdir,
      denoJson: {
        name,
        version: typeof parsed.version === "string" ? parsed.version : undefined,
        exports,
        description: typeof parsed.description === "string"
          ? parsed.description
          : undefined,
      },
    });
  }

  // Fallback: if no packages found, treat whole repo as one package
  if (pkgs.size === 0) {
    const fallbackName = derivePackageName(""); // will be overridden below
    // We need the URL for derivePackageName, but we don't have it here.
    // The caller handles this fallback.
  }

  return pkgs;
}

// ── public API ──────────────────────────────────────────────────────────

export function createRemoteGitStore(opts: RemoteGitStoreOptions): PackageStore {
  const { url } = opts;
  const cacheDir = opts.cacheDir ?? Deno.makeTempDirSync({ prefix: "pkg-git-" });
  const fallbackName = derivePackageName(url);

  let initialized = false;
  // Cache: tag -> Map<packageName, PackageMeta>
  const discoveryCache = new Map<string, Map<string, PackageMeta>>();

  async function ensureClone(): Promise<string> {
    const repoDir = `${cacheDir}/repo.git`;
    if (!initialized) {
      let cloneError: string | undefined;
      try {
        await git(["clone", "--bare", url, repoDir]);
      } catch (e) {
        cloneError = e instanceof Error ? e.message : String(e);
        try {
          const stat = await Deno.stat(repoDir);
          if (stat.isDirectory) {
            await git(["fetch", "--tags"], repoDir);
          }
        } catch { /* dir doesn't exist either */ }
      }
      initialized = true;
      try {
        const stat = await Deno.stat(repoDir);
        if (!stat.isDirectory) throw new Error("not a directory");
      } catch {
        const cause = cloneError ? `: ${cloneError}` : "";
        throw new Error(
          `Git clone/fetch failed. Repo dir does not exist: ${repoDir}${cause}`,
        );
      }
    } else {
      try { await git(["fetch", "--tags"], repoDir); } catch { /* ok */ }
    }
    return repoDir;
  }

  async function listTags(repoDir: string): Promise<string[]> {
    const out = await git(["tag"], repoDir);
    return out.trim().split("\n").filter(Boolean).filter((t) =>
      VERSION_TAG_RE.test(t)
    );
  }

  /** Get or populate discovery cache for a tag. */
  async function getDiscovery(
    repoDir: string,
    tag: string,
  ): Promise<Map<string, PackageMeta>> {
    const cached = discoveryCache.get(tag);
    if (cached) return cached;
    const pkgs = await discoverPackages(repoDir, tag);
    discoveryCache.set(tag, pkgs);
    return pkgs;
  }

  /** Find the subdirectory and deno.json metadata for a package at a tag. */
  async function findPackage(
    repoDir: string,
    tag: string,
    packageName: string,
  ): Promise<PackageMeta | null> {
    const pkgs = await getDiscovery(repoDir, tag);
    const found = pkgs.get(packageName);
    if (found) return found;

    // Also try fallback name (whole-repo mode)
    if (packageName === fallbackName && pkgs.size === 0) {
      return {
        subdir: "",
        denoJson: { name: fallbackName },
      };
    }

    return null;
  }

  /** Determine if this is a binary file by extension. */
  function isBinaryPath(path: string): boolean {
    return /\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|wasm|gz|zip|tar|bz2|xz|7z)$/i
      .test(path);
  }

  /**
   * Try to resolve a version string as a git ref (branch name or commit SHA).
   * Strips optional '$' prefix for explicit git-ref markers.
   *
   * - Branch names: always fetch from origin to get the latest head.
   * - Commit SHAs (7-40 hex chars): resolve directly (must be reachable
   *   from already-fetched refs).
   */
  async function resolveRef(repoDir: string, version: string): Promise<string | null> {
    // Strip optional '$' prefix (explicit git-ref marker)
    const ref = version.startsWith("$") ? version.slice(1) : version;

    // Heuristic: all-hex string of 7+ chars is likely a commit SHA
    const isShaLike = /^[0-9a-f]{7,40}$/i.test(ref);

    if (isShaLike) {
      // SHAs: try direct resolution (should be reachable from fetched refs)
      try {
        await git(["rev-parse", "--verify", `${ref}^{commit}`], repoDir);
        return ref;
      } catch {
        return null; // SHA not reachable
      }
    }

    // Branch name: always fetch latest from origin, then verify
    try {
      await git(
        ["fetch", "origin", `refs/heads/${ref}:refs/heads/${ref}`],
        repoDir,
      );
      await git(["rev-parse", "--verify", `${ref}^{commit}`], repoDir);
      return ref;
    } catch {
      return null; // branch doesn't exist on remote
    }
  }

  /**
   * Build a PackageVersion from a resolved git ref (tag, branch, or SHA).
   */
  async function buildPackageVersion(
    repoDir: string,
    ref: string,
    pkgMeta: PackageMeta,
    requestedName: string,
    requestedVersion: string,
  ): Promise<PackageVersion> {
    // List files at the ref, filtered to the package subdirectory
    const fileList = await git(
      ["ls-tree", "-r", "--name-only", ref],
      repoDir,
    );
    let paths = fileList.trim().split("\n").filter(Boolean);

    // Filter paths to the package's subdirectory
    if (pkgMeta.subdir) {
      const prefix = pkgMeta.subdir + "/";
      paths = paths
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    }

    const files: Record<string, string> = {};
    for (const relPath of paths) {
      if (isBinaryPath(relPath)) continue;

      const gitPath = pkgMeta.subdir
        ? `${pkgMeta.subdir}/${relPath}`
        : relPath;

      try {
        const content = await git(["show", `${ref}:${gitPath}`], repoDir);
        files[relPath] = content;
      } catch {
        // Skip files that can't be shown (binaries, submodules, etc.)
      }
    }

    // Build export map: prefer deno.json exports, then auto-detect
    let exports: Record<string, string>;
    const denoExports = pkgMeta.denoJson.exports;
    if (typeof denoExports === "string") {
      exports = { ".": denoExports };
    } else if (denoExports && typeof denoExports === "object") {
      exports = denoExports as Record<string, string>;
    } else {
      // Auto-detect entrypoint
      const entry = "mod.ts" in files
        ? "./mod.ts"
        : Object.keys(files).find((f) =>
          f.endsWith(".ts") || f.endsWith(".js")
        ) ?? "";
      exports = { ".": entry ? `./${entry}` : "./mod.ts" };
    }

    return {
      name: requestedName,
      version: requestedVersion,
      files,
      metadata: {
        exports,
        denoJson: pkgMeta.denoJson,
      },
    };
  }

  return {
    async list(): Promise<PackageEntry[]> {
      const repoDir = await ensureClone();
      const tags = await listTags(repoDir);

      // Accumulate versions per package across all tags
      const pkgVersions = new Map<string, { versions: string[]; description?: string }>();

      for (const tag of tags) {
        const version = tagToVersion(tag);
        const pkgs = await getDiscovery(repoDir, tag);

        if (pkgs.size === 0) {
          // Fallback: whole repo = one package
          const existing = pkgVersions.get(fallbackName);
          if (existing) {
            existing.versions.push(version);
          } else {
            pkgVersions.set(fallbackName, { versions: [version] });
          }
        } else {
          for (const [name, meta] of pkgs) {
            const existing = pkgVersions.get(name);
            if (existing) {
              existing.versions.push(version);
              existing.description = existing.description ??
                meta.denoJson.description;
            } else {
              pkgVersions.set(name, {
                versions: [version],
                description: meta.denoJson.description,
              });
            }
          }
        }
      }

      return [...pkgVersions.entries()].map(([name, info]) => ({
        name,
        versions: info.versions.sort(),
        description: info.description,
      }));
    },

    async get(name: string, version: string): Promise<PackageVersion | null> {
      const repoDir = await ensureClone();
      const tags = await listTags(repoDir);

      // Try semver tag first
      const tag = tags.find((t) =>
        tagToVersion(t) === version || t === version
      );

      let ref: string | null = null;

      if (tag) {
        ref = tag;
      } else {
        // Not a semver tag — try resolving as branch or commit SHA
        ref = await resolveRef(repoDir, version);
      }

      if (!ref) return null;

      const pkgMeta = await findPackage(repoDir, ref, name);
      if (!pkgMeta) return null;

      return await buildPackageVersion(repoDir, ref, pkgMeta, name, version);
    },
  };
}
