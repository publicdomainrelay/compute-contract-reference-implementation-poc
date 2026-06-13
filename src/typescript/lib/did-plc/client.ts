// PLC Directory API client — thin wrapper around the @hey-api/openapi-ts
// generated SDK that preserves the existing PlcClient class API.

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

async function checkResponse(res: Response, did?: string): Promise<void> {
  if (res.ok) return;
  let msg = res.statusText;
  try {
    const body = await res.json() as { message?: string };
    if (body.message) msg = body.message;
  } catch { /* ignore */ }
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

  /** Resolve DID Document for a did:plc identifier. */
  async resolve(did: string): Promise<DidDocument> {
    const result = await resolveDid({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did);
    return result.data!;
  }

  /** Fetch the current (non-nullified) operation chain for a DID. */
  async getLog(did: string): Promise<Operation[]> {
    const result = await getPlcOpLog({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did);
    return result.data!;
  }

  /** Fetch the full audit log, including nullified (forked) operations. */
  async getAuditLog(did: string): Promise<LogEntry[]> {
    const result = await getPlcAuditLog({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did);
    return result.data!;
  }

  /** Fetch the latest operation for a DID (without walking the chain). */
  async getLastOp(did: string): Promise<Operation> {
    const result = await getLastOp({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did);
    return result.data!;
  }

  /** Fetch current PLC data for a DID. */
  async getData(did: string): Promise<unknown> {
    const result = await getPlcData({
      client: this._client,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did);
    return result.data!;
  }

  /** Submit a signed PLC operation. Throws on invalid signature or bad prev. */
  async submitOp(did: string, op: Operation): Promise<void> {
    const result = await createPlcOp({
      client: this._client,
      body: op,
      path: { did },
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!, did);
  }

  /** Get server health / version. (Not in OpenAPI spec — manual fetch.) */
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
    const query: { count?: number; after?: string } = {};
    if (opts.after) query.after = opts.after;
    if (opts.count != null) query.count = opts.count;
    const result = await export_({
      client: this._client,
      query,
      signal: this.signal(),
      throwOnError: false,
    });
    if (result.error) await checkResponse(result.response!);
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
