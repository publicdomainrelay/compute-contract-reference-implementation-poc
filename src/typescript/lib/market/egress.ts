// SSRF guard for outbound requests built from counterparty-supplied URLs.
//
// Settlement layers (x402, free, …) take a `url` from a winning bid's payload —
// i.e. from a counterparty, so it is untrusted input. Before any leg GETs it we
// reject non-http(s) schemes and the cloud-metadata host, and (opt-in)
// private/loopback ranges. Kept runtime-agnostic: the caller decides whether to
// block private ranges rather than this library reading an env var, so it
// behaves identically on Deno and Node. The reference spindle passes
// `blockPrivate: !!Deno.env.get("MARKET_BLOCK_PRIVATE_EGRESS")`.

export type EgressOptions = {
  /** Also reject localhost / private / loopback / link-local / ULA hosts. */
  blockPrivate?: boolean;
};

/** Validate an untrusted egress URL, returning the parsed URL or throwing. */
export function assertSafeEgressUrl(raw: string, opts: EgressOptions = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked URL scheme: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new Error(`blocked cloud-metadata host: ${host}`);
  }
  if (opts.blockPrivate) {
    const isPrivate = host === "localhost" || host === "::1" ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^(fc|fd)/.test(host);
    if (isPrivate) throw new Error(`blocked private/loopback host: ${host}`);
  }
  return u;
}
