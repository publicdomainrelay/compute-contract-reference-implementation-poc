/**
 * @publicdomainrelay/datastore-pds — PackageStore backed by AT Protocol PDS
 * records.
 *
 * Stores package metadata as com.publicdomainrelay.temp.packageRegistry.package
 * records and release metadata as com.publicdomainrelay.temp.packageRegistry.release
 * records in a repo.
 *
 * Each release record contains the file listing (paths → content) for a given
 * version. The package record links to the latest release.
 *
 * Options:
 *   - api: Repo API from createRepoFactory (for writing)
 *   - repoDid: DID of the repo storing these records
 *   - idResolver: for reading from remote PDS repos
 */

import type { PackageEntry, PackageStore, PackageVersion } from "@publicdomainrelay/datastore-package";
import {
  PACKAGE_REGISTRY_PACKAGE_NSID,
  PACKAGE_REGISTRY_RELEASE_NSID,
} from "@publicdomainrelay/lexicons";
import { TID } from "@atproto/common";
import type { createRepoFactory } from "@publicdomainrelay/hono-factory-atproto-repo";

type RepoApi = ReturnType<typeof createRepoFactory>["api"];

export interface PdsStoreOptions {
  /** Repo API for writing records */
  api: RepoApi;
  /** DID of the repo storing package records */
  repoDid: string;
}

/** Derive a stable rkey from package name */
function packageRkey(name: string): string {
  return name.replace(/[@/]/g, "-").replace(/^-/, "");
}

/** Derive a stable rkey from package name + version */
function releaseRkey(name: string, version: string): string {
  return `${packageRkey(name)}-v${version}`;
}

export function createPdsStore(opts: PdsStoreOptions): PackageStore {
  const { api, repoDid } = opts;

  return {
    async list(): Promise<PackageEntry[]> {
      const result = await api.listRecords(repoDid, PACKAGE_REGISTRY_PACKAGE_NSID, { limit: 100 });
      const entries: PackageEntry[] = [];
      for (const rec of result?.records ?? []) {
        const val = rec.value as Record<string, unknown>;
        entries.push({
          name: val.name as string,
          versions: (val.versions as string[]) ?? [],
          description: val.description as string | undefined,
        });
      }
      return entries;
    },

    async get(name: string, version: string): Promise<PackageVersion | null> {
      const rkey = releaseRkey(name, version);
      try {
        const rec = await api.getRecord(repoDid, PACKAGE_REGISTRY_RELEASE_NSID, rkey);
        const val = rec?.value as Record<string, unknown> | undefined;
        if (!val) return null;
        return {
          name: val.name as string,
          version: val.version as string,
          files: (val.files as Record<string, string>) ?? {},
          metadata: val.metadata as Record<string, unknown> | undefined,
        };
      } catch {
        return null;
      }
    },
  };
}

/** Helper: publish a package version to the PDS store */
export async function publishToPds(
  api: RepoApi,
  repoDid: string,
  pkg: PackageVersion,
): Promise<{ packageUri: string; releaseUri: string }> {
  // Upsert package record
  const pkRkey = packageRkey(pkg.name);
  let existingVersions: string[] = [];
  let existingPkg: Record<string, unknown> | null = null;
  try {
    const rec = await api.getRecord(repoDid, PACKAGE_REGISTRY_PACKAGE_NSID, pkRkey);
    existingPkg = rec?.value as Record<string, unknown> | null;
    existingVersions = (existingPkg?.versions as string[]) ?? [];
  } catch { /* not found */ }

  const versions = [...new Set([...existingVersions, pkg.version])].sort();
  const pkgRecord = {
    $type: PACKAGE_REGISTRY_PACKAGE_NSID,
    name: pkg.name,
    versions,
    description: (pkg.metadata?.description as string) ?? existingPkg?.description,
    updatedAt: new Date().toISOString(),
    createdAt: (existingPkg?.createdAt as string) ?? new Date().toISOString(),
  };

  if (existingPkg) {
    await api.applyWrites(repoDid, [
      { action: "update", collection: PACKAGE_REGISTRY_PACKAGE_NSID, rkey: pkRkey, record: pkgRecord },
    ]);
  } else {
    await api.applyWrites(repoDid, [
      { action: "create", collection: PACKAGE_REGISTRY_PACKAGE_NSID, rkey: pkRkey, record: pkgRecord },
    ]);
  }

  // Create release record
  const relRkey = releaseRkey(pkg.name, pkg.version);
  const releaseRecord = {
    $type: PACKAGE_REGISTRY_RELEASE_NSID,
    name: pkg.name,
    version: pkg.version,
    files: pkg.files,
    metadata: pkg.metadata ?? {},
    createdAt: new Date().toISOString(),
  };

  // Check if release already exists
  let relExists = false;
  try {
    await api.getRecord(repoDid, PACKAGE_REGISTRY_RELEASE_NSID, relRkey);
    relExists = true;
  } catch { /* not found */ }

  if (relExists) {
    await api.applyWrites(repoDid, [
      { action: "update", collection: PACKAGE_REGISTRY_RELEASE_NSID, rkey: relRkey, record: releaseRecord },
    ]);
  } else {
    await api.applyWrites(repoDid, [
      { action: "create", collection: PACKAGE_REGISTRY_RELEASE_NSID, rkey: relRkey, record: releaseRecord },
    ]);
  }

  return {
    packageUri: `at://${repoDid}/${PACKAGE_REGISTRY_PACKAGE_NSID}/${pkRkey}`,
    releaseUri: `at://${repoDid}/${PACKAGE_REGISTRY_RELEASE_NSID}/${relRkey}`,
  };
}
