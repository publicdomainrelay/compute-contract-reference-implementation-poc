import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPError } from "./http_error.ts";

/** True for any error carrying a numeric HTTP `status` in the 4xx/5xx range. */
function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : undefined;
}

export function registerErrorMiddleware(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof HTTPError) {
      return c.json({ error: "http_error", code: err.status, detail: err.detail }, err.status as ContentfulStatusCode);
    }
    // Errors from other libraries that carry an HTTP `status` (e.g.
    // X402PaymentError / FreeGrantError from the settlement layers) are mapped
    // to that status too, rather than collapsing to a generic 500.
    const status = httpStatusOf(err);
    if (status !== undefined) {
      return c.json({ error: "http_error", code: status, detail: (err as Error).message }, status as ContentfulStatusCode);
    }
    console.error("[err]", (err as Error).stack ?? err);
    return c.json({ error: "internal", detail: (err as Error).message }, 500);
  });
}
