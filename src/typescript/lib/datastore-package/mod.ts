/**
 * @publicdomainrelay/datastore-package — common interface for package registry
 * backing stores.
 *
 * A PackageStore provides list/get operations. Implementations can read from
 * a PDS repo, a remote git repository, a local filesystem directory, or any
 * other source that can produce versioned file trees.
 */

export interface PackageEntry {
  /** Package name, e.g. "@scope/name" or "name" */
  name: string;
  /** Available versions (semver strings or git tags) */
  versions: string[];
  /** Optional human-readable description */
  description?: string;
}

export interface PackageVersion {
  /** Package name */
  name: string;
  /** Version string */
  version: string;
  /** File path (relative to package root) → file contents as UTF-8 string */
  files: Record<string, string>;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface PackageStore {
  /** List all packages available in this store. */
  list(): Promise<PackageEntry[]>;

  /**
   * Get a specific version of a package.
   * Returns null if the package or version is not found.
   */
  get(name: string, version: string): Promise<PackageVersion | null>;
}
