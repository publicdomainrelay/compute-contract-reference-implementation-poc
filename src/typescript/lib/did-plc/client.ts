// PLC Directory API client — thin wrapper around the @hey-api/openapi-ts
// generated HTTP client.
//
// In browsers the generated SDK functions (resolveDid, createPlcOp, etc.)
// work fine — the browser's Request constructor silently ignores unknown
// RequestInit fields.
//
// In Deno the generated functions break: they spread the `client` option
// into every request, and Deno's Request constructor rejects `client`
// because it expects a Deno.HttpClient, not an OpenAPI client object.
//
// We detect the runtime at module load and take the right path:
//   Deno    → call this._client.{get,post}() directly (no client leak)
//   Browser → use the generated SDK functions (full type safety)

import { createClient, createConfig } from "./generated/client/index.ts";
import type { Client } from "./generated/client/index.ts";
import {
  createPlcOp,
  export_,
  getLastOp,
  getPlcAuditLog,
  getPlcData,
  getPlcOpLog,
  resolveDid,
} from "./generated/sdk.gen.ts";
import type {
  DidDocument,
  ExportOptions,
  HealthResponse,
  LogEntry,
  Operation,
} from "./types.ts";

export const PLC_DIRECTORY_URL = "https://plc.directory";

// Deno exposes a global `Deno` namespace; browsers do not.
const _isDeno = typeof (globalThis as Record<string, unknown>).Deno !== "undefined";

// ── Error classes ─────────────────────────────────────────────────────

export class PlcError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlcError";
  }
}

export class PlcNotFoundError extends PlcError {
  constructor(did: string) {
    super(404, `DID not found: ${did}`);
    this.name = "PlcNotFoundError";
  }
}

export class PlcTombstonedError extends PlcError {
  constructor(did: string) {
    super(410, `DID tombstoned (not available): ${did}`);
    this.name = "PlcTombstonedError";
  }
}

export class PlcInvalidOperationError extends PlcError {
  constructor(message: string) {
    super(400, message);
    this.name = "PlcInvalidOperationError";
  }
}

/** Extract a human-readable message from a client error value. */
function errorMessage(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.error === "string") return e.error;
  }
  return undefined;
}

/**
 * Helper: given a client result, throw the right PlcError subclass.
 *
 * The generated @hey-api/openapi-ts client reads the response body on error
 * (response.text()) *before* returning.  Calling res.json() afterwards fails
 * because the body is already consumed.  Pass `clientError` (from
 * `result.error`) so we can extract the server's error message.
 */
async function checkResponse(
  res: Response,
  did?: string,
  clientError?: unknown,
): Promise<void> {
  // If the fetch itself failed (network error), res is undefined.
  if (!res) throw new PlcError(0, "PLC directory unreachable (fetch failed)");
  if (res.ok) return;

  // Prefer the message already parsed by the generated client.
  let msg = errorMessage(clientError) ?? res.statusText;

  // Only try to read the body directly when we don't have a client-error
  // message (e.g. when called from hand-rolled fetch paths).
  if (!errorMessage(clientError)) {
    try {
      const body = await res.json() as { message?: string };
      if (body.message) msg = body.message;
    } catch { /* body already consumed or not JSON */ }
  }

  if (res.status === 404) throw new PlcNotFoundError(did ?? msg);
  if (res.status === 410) throw new PlcTombstonedError(did ?? msg);
  if (res.status === 400) throw new PlcInvalidOperationError(msg);
  throw new PlcError(res.status, msg);
}

// ── Client options ─────────────────────────────────────────────────────

export interface PlcClientOptions {
  /** PLC directory base URL. Defaults to https://plc.directory */
  baseUrl?: string;
  /** Fetch timeout in milliseconds. */
  timeout?: number;
  /** Custom fetch implementation. */
  fetch?: typeof globalThis.fetch;
}

// ── Client class ───────────────────────────────────────────────────────

export class PlcClient {
  private readonly baseUrl: string;
  private readonly timeout: number | undefined;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _client: Client;

  constructor(opts: PlcClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? PLC_DIRECTORY_URL).replace(/\/$/, "");
    this.timeout = opts.timeout;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this._client = createClient(
      createConfig({
        baseUrl: this.baseUrl,
        fetch: this._fetch,
      }),
    );
  }

  /** Build an AbortSignal if a timeout is configured. */
  private signal(): AbortSignal | undefined {
    return this.timeout ? AbortSignal.timeout(this.timeout) : undefined;
  }

  // ── Deno helpers (bypass generated SDK — see module doc) ──────────

  /** GET a path, parse JSON, throw on error. */
  private async _denoGet<T>(path: string, did?: string): Promise<T> {
    const result = await this._client.get({
      url: path,
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did, result.error);
    return (result as { data: T }).data;
  }

  /** POST to a path with a JSON body, throw on error. */
  private async _denoPost(path: string, body: unknown, did?: string): Promise<void> {
    const result = await this._client.post({
      url: path,
      body,
      headers: { "Content-Type": "application/json" },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did, result.error);
  }

  // ── public API ────────────────────────────────────────────────────

  /** Resolve DID Document for a did:plc identifier. */
  async resolve(did: string): Promise<DidDocument> {
    if (_isDeno) return this._denoGet<DidDocument>(`/${did}`, did);

    const result = await resolveDid({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did, result.error);
    return result.data!;
  }

  /** Fetch the current (non-nullified) operation chain for a DID. */
  async getLog(did: string): Promise<Operation[]> {
    if (_isDeno) return this._denoGet<Operation[]>(`/${did}/log`, did);

    const result = await getPlcOpLog({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did, result.error);
    return result.data!;
  }

  /** Fetch the full audit log, including nullified (forked) operations. */
  async getAuditLog(did: string): Promise<LogEntry[]> {
    if (_isDeno) return this._denoGet<LogEntry[]>(`/${did}/log/audit`, did);

    const result = await getPlcAuditLog({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did, result.error);
    return result.data!;
  }

  /** Fetch the latest operation for a DID (without walking the chain). */
  async getLastOp(did: string): Promise<Operation> {
    if (_isDeno) return this._denoGet<Operation>(`/${did}/log/last`, did);

    const result = await getLastOp({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did, result.error);
    return result.data!;
  }

  /** Fetch current PLC data for a DID. */
  async getData(did: string): Promise<unknown> {
    if (_isDeno) return this._denoGet<unknown>(`/${did}/data`, did);

    const result = await getPlcData({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did, result.error);
    return result.data!;
  }

  /** Submit a signed PLC operation. Throws on invalid signature or bad prev. */
  async submitOp(did: string, op: Operation): Promise<void> {
    if (_isDeno) {
      await this._denoPost(`/${did}`, op, did);
      return;
    }

    const result = await createPlcOp({
      client: this._client,
      body: op,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did, result.error);
  }

  /** Get server health / version. (Manual fetch — no generated type.) */
  async health(): Promise<HealthResponse> {
    const url = this.baseUrl + "/health";
    const res = await this._fetch(url, { signal: this.signal() });
    if (!res.ok) throw new PlcError(res.status, res.statusText);
    return res.json() as Promise<HealthResponse>;
  }

  /**
   * Paginated export of all log entries across all DIDs.
   * Use `after` (ISO timestamp) as cursor for subsequent pages.
   *
   * Note: the server returns JSON Lines, but the generated client parses
   * only the first line. For full access use `exportPages()`.
   */
  async export(opts: ExportOptions = {}): Promise<LogEntry[]> {
    if (_isDeno) {
      let url = "/export";
      const qs: string[] = [];
      if (opts.after) qs.push(`after=${encodeURIComponent(opts.after)}`);
      if (opts.count != null) qs.push(`count=${opts.count}`);
      if (qs.length) url += `?${qs.join("&")}`;

      const result = await this._client.get({
        url,
        signal: this.signal(),
        throwOnError: false,
      });
      if (result.error) await checkResponse(result.response!, undefined, result.error);
      const data = result.data as unknown;
      if (Array.isArray(data)) return data as LogEntry[];
      if (data && typeof data === "object") return [data as LogEntry];
      return [];
    }

    const query: { count?: number; after?: string } = {};
    if (opts.after) query.after = opts.after;
    if (opts.count != null) query.count = opts.count;
    const result = await export_({
      client: this._client,
      query,
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, undefined, result.error);
    // The spec models export as a single LogEntry, but the server returns
    // JSON Lines — an array of entries. Handle both shapes.
    const data = result.data as unknown;
    if (Array.isArray(data)) return data as LogEntry[];
    if (data && typeof data === "object") return [data as LogEntry];
    return [];
  }

  /**
   * Async generator for iterating the full PLC export in pages.
   * Yields each page of entries; stops when the server returns an empty page.
   */
  async *exportPages(pageSize = 1000): AsyncGenerator<LogEntry[]> {
    let after: string | undefined;
    while (true) {
      const page = await this.export({ after, count: pageSize });
      if (page.length === 0) break;
      yield page;
      after = page[page.length - 1].createdAt;
      if (page.length < pageSize) break;
    }
  }
}

/** Shared default client pointing at the public PLC directory. */
export const defaultPlcClient = new PlcClient();
