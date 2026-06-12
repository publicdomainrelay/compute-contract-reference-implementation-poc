import type {
  DidDocument,
  ExportOptions,
  HealthResponse,
  LogEntry,
  Operation,
} from "./types.ts";

export const PLC_DIRECTORY_URL = "https://plc.directory";

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

export interface PlcClientOptions {
  /** PLC directory base URL. Defaults to https://plc.directory */
  baseUrl?: string;
  /** Fetch timeout in milliseconds. */
  timeout?: number;
  /** Custom fetch implementation. */
  fetch?: typeof globalThis.fetch;
}

export class PlcClient {
  private readonly baseUrl: string;
  private readonly timeout: number | undefined;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(opts: PlcClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? PLC_DIRECTORY_URL).replace(/\/$/, "");
    this.timeout = opts.timeout;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async get(path: string, params?: Record<string, string>): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const signal = this.timeout ? AbortSignal.timeout(this.timeout) : undefined;
    return this._fetch(url.toString(), { signal });
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const url = this.baseUrl + path;
    const signal = this.timeout ? AbortSignal.timeout(this.timeout) : undefined;
    return this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** Resolve DID Document for a did:plc identifier. */
  async resolve(did: string): Promise<DidDocument> {
    const res = await this.get(`/${encodeURIComponent(did)}`);
    await checkResponse(res, did);
    return res.json() as Promise<DidDocument>;
  }

  /** Fetch the current (non-nullified) operation chain for a DID. */
  async getLog(did: string): Promise<Operation[]> {
    const res = await this.get(`/${encodeURIComponent(did)}/log`);
    await checkResponse(res, did);
    return res.json() as Promise<Operation[]>;
  }

  /** Fetch the full audit log, including nullified (forked) operations. */
  async getAuditLog(did: string): Promise<LogEntry[]> {
    const res = await this.get(`/${encodeURIComponent(did)}/log/audit`);
    await checkResponse(res, did);
    return res.json() as Promise<LogEntry[]>;
  }

  /** Submit a signed PLC operation. Throws on invalid signature or bad prev. */
  async submitOp(did: string, op: Operation): Promise<void> {
    const res = await this.post(`/${encodeURIComponent(did)}`, op);
    await checkResponse(res, did);
  }

  /** Get server health / version. */
  async health(): Promise<HealthResponse> {
    const res = await this.get("/health");
    if (!res.ok) throw new PlcError(res.status, res.statusText);
    return res.json() as Promise<HealthResponse>;
  }

  /**
   * Paginated export of all log entries across all DIDs.
   * Use `after` (ISO timestamp) as cursor for subsequent pages.
   */
  async export(opts: ExportOptions = {}): Promise<LogEntry[]> {
    const params: Record<string, string> = {};
    if (opts.after) params.after = opts.after;
    if (opts.count != null) params.count = String(opts.count);
    const res = await this.get("/export", params);
    if (!res.ok) throw new PlcError(res.status, res.statusText);
    return res.json() as Promise<LogEntry[]>;
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
