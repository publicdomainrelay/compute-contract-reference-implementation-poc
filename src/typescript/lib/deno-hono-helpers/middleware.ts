import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPError } from "./http_error.ts";

export function registerErrorMiddleware(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof HTTPError) {
      return c.json({ error: "http_error", code: err.status, detail: err.detail }, err.status as ContentfulStatusCode);
    }
    console.error("[err]", (err as Error).stack ?? err);
    return c.json({ error: "internal", detail: (err as Error).message }, 500);
  });
}
