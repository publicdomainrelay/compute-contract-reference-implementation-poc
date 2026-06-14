/**
 * ssh-xrpc-factory.ts — Hono factory exposing SSH relay XRPC endpoints.
 *
 * Exposes two atproto XRPC methods reachable via PDS service proxying:
 *   - subscribe  (subscription): WebSocket, streams SSH session output
 *   - write      (procedure):     POST JSON, writes bytes to SSH stdin
 *
 * Also serves the did:web document at /.well-known/did.json so the PDS
 * can discover the service and proxy calls to it.
 *
 * Usage:
 *   import { createSshXrpcFactory } from "./ssh-xrpc-factory.ts";
 *
 *   const { createApp } = createSshXrpcFactory({
 *     operatorHandle: "did:plc:xxx",
 *     issuerUrl:       "https://ssh-relay.example.com",
 *     serviceId:       "ssh_relay",
 *   });
 *
 *   const app = createApp();
 *   Deno.serve({ port: 8080 }, app.fetch);
 */

import { createFactory, createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { raiseIfUnauthorizedServiceAuth } from "@publicdomainrelay/qemu/rbac_helper.ts";
import type { AuthToken } from "@publicdomainrelay/qemu/rbac_helper.ts";
import {
  SshSessionManager,
  type SshConnectParams,
  type SshSession,
} from "./ssh-session-manager.ts";

// ── Lexicon NSIDs ────────────────────────────────────────────────────────

export const SUBSCRIBE_NSID = "com.publicdomainrelay.ssh.subscribe";
export const WRITE_NSID = "com.publicdomainrelay.ssh.write";

// ── Factory types ────────────────────────────────────────────────────────

export interface SshXrpcFactoryOptions {
  /**
   * DID or handle of the service operator.
   * Used for RBAC service-auth allowlist lookups.
   * When a function, called at request time so callers can update a
   * captured variable after PLC registration.
   */
  operatorHandle: string | (() => string);

  /**
   * Public base URL of this service (scheme + host, optional port).
   * Used as the aud for service-auth JWT validation.
   * When a function, called at request time (useful when the relay
   * registration updates the proxyRef after startup).
   */
  issuerUrl: string | (() => string);

  /**
   * atproto service ID fragment (no leading `#`).
   * Appears in the did:web document service entry and the
   * atproto-proxy header.
   */
  serviceId: string;

  /**
   * RBAC scope used for policy checks on both endpoints.
   * Default: "ssh.session"
   */
  scope?: string;

  /**
   * Path to the SSH binary. Defaults to SSH_BIN_PATH env var or "ssh".
   */
  sshBinPath?: string;
}

export interface SshXrpcFactoryEnv {
  Variables: {
    authToken: AuthToken;
    sessionManager: SshSessionManager;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractBearer(authHeader: string | undefined): string {
  if (!authHeader) {
    throw Object.assign(new Error("Missing Authorization header"), {
      name: "Unauthorized",
    });
  }
  const parts = authHeader.split(" ");
  const token = parts[parts.length - 1];
  if (!token || token === "0") {
    throw Object.assign(new Error("Missing bearer token"), {
      name: "Unauthorized",
    });
  }
  return token;
}

function effectiveHostname(host: string): string {
  // Strip port so did:web ids are pure hostnames
  return host.replace(/:\d+$/, "");
}

// ── Factory constructor ──────────────────────────────────────────────────

export function createSshXrpcFactory(opts: SshXrpcFactoryOptions) {
  const scope = opts.scope ?? "ssh.session";
  const sshBinPath = opts.sshBinPath ?? Deno.env.get("SSH_BIN_PATH") ?? "ssh";

  // Set SSH_BIN_PATH for ssh-session-manager to pick up
  if (!Deno.env.get("SSH_BIN_PATH") && opts.sshBinPath) {
    Deno.env.set("SSH_BIN_PATH", opts.sshBinPath);
  }
  void sshBinPath; // used via env for session-manager, captured for clarity

  const sessionManager = new SshSessionManager();

  // ── Auth middleware ──────────────────────────────────────────────────

  const authMiddleware = (endpointScope: string) =>
    createMiddleware<SshXrpcFactoryEnv>(async (c, next) => {
      const token = extractBearer(c.req.header("Authorization"));
      const opHandle =
        typeof opts.operatorHandle === "function"
          ? opts.operatorHandle()
          : opts.operatorHandle;
      const issuerUrl =
        typeof opts.issuerUrl === "function"
          ? opts.issuerUrl()
          : opts.issuerUrl;

      const authToken = await raiseIfUnauthorizedServiceAuth(
        issuerUrl,
        endpointScope,
        opHandle,
        token,
        new URL(c.req.url).pathname,
        c.req.method,
      );
      c.set("authToken", authToken);
      await next();
    });

  // ── Factory ──────────────────────────────────────────────────────────

  const factory = createFactory<SshXrpcFactoryEnv>({
    initApp: (app) => {
      // Inject session manager into every request context
      app.use("*", async (c, next) => {
        c.set("sessionManager", sessionManager);
        await next();
      });

      // ── /.well-known/did.json ───────────────────────────────────────

      app.get("/.well-known/did.json", (c) => {
        const host = c.req.header("host") ?? "localhost";
        const serviceHost = effectiveHostname(host);
        return c.json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: `did:web:${serviceHost}`,
          service: [
            {
              id: `#${opts.serviceId}`,
              type: "SshRelay",
              serviceEndpoint: `https://${serviceHost}`,
            },
          ],
        });
      });

      // ── Subscribe (WebSocket subscription) ──────────────────────────
      // GET /xrpc/com.publicdomainrelay.ssh.subscribe
      // Auth via Authorization header on the upgrade request.

      app.get(
        `/xrpc/${SUBSCRIBE_NSID}`,
        authMiddleware(scope),
        async (c: Context<SshXrpcFactoryEnv>) => {
          const actorDid = c.var.authToken.sub;

          // Deno-native WebSocket upgrade
          const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

          let session: SshSession | null = null;
          let stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null =
            null;
          let stderrReader: ReadableStreamDefaultReader<Uint8Array> | null =
            null;
          let streaming = false;

          /** Push a text (JSON) frame to the client. */
          function sendJson(obj: Record<string, unknown>): void {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(obj));
            }
          }

          /** Push a binary frame: 1-byte stream discriminator + payload. */
          function sendFrame(
            stream: 0 | 1,
            data: Uint8Array,
          ): void {
            if (
              socket.readyState === WebSocket.OPEN &&
              data.length > 0
            ) {
              const frame = new Uint8Array(1 + data.length);
              frame[0] = stream; // 0=stdout, 1=stderr
              frame.set(data, 1);
              socket.send(frame);
            }
          }

          /** Pump a ReadableStream into WebSocket frames. */
          async function pumpStream(
            streamTag: 0 | 1,
            reader: ReadableStreamDefaultReader<Uint8Array>,
          ): Promise<void> {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.length > 0) sendFrame(streamTag, value);
              }
            } catch {
              // Stream closed or errored — client probably disconnected
            }
          }

          /** Start streaming stdout + stderr to the WebSocket. */
          async function startStreaming(s: SshSession): Promise<void> {
            if (streaming) return;
            streaming = true;

            stdoutReader = s.stdout.getReader();
            stderrReader = s.stderr.getReader();

            // Pump both streams concurrently
            const stdoutDone = pumpStream(0, stdoutReader);
            const stderrDone = pumpStream(1, stderrReader);

            // Wait for SSH exit
            const exitCode = await s.exited;

            // Cancel readers so pumpStream exits
            try { stdoutReader?.cancel(); } catch { /* ok */ }
            try { stderrReader?.cancel(); } catch { /* ok */ }

            await Promise.allSettled([stdoutDone, stderrDone]);

            // Send exit frame and close
            sendJson({ type: "exit", code: exitCode });
            if (socket.readyState === WebSocket.OPEN) {
              socket.close(1000, `SSH exited with code ${exitCode}`);
            }
          }

          socket.onopen = () => {
            // Send ready signal so the client knows it can send the connect message
            sendJson({ type: "ready", message: "send connect params" });
          };

          socket.onmessage = async (event) => {
            // First message must be the connect params (JSON)
            if (session) return; // already connected

            let params: SshConnectParams;
            try {
              params =
                typeof event.data === "string"
                  ? JSON.parse(event.data)
                  : JSON.parse(new TextDecoder().decode(event.data));
            } catch {
              sendJson({
                type: "error",
                message: "invalid JSON — expected SSH connect params",
              });
              socket.close(1002, "invalid connect params");
              return;
            }

            if (!params.host || !params.username) {
              sendJson({
                type: "error",
                message: "missing required fields: host, username",
              });
              socket.close(1002, "missing required fields");
              return;
            }

            try {
              session = await sessionManager.connect(params);
              sendJson({ type: "connected", sessionId: session.sessionId });
              // Start streaming in background (don't block onmessage)
              startStreaming(session);
            } catch (err) {
              sendJson({
                type: "error",
                message: `SSH connection failed: ${String(err)}`,
              });
              socket.close(1011, "SSH connection failed");
            }
          };

          socket.onclose = () => {
            // Clean up SSH session on disconnect
            if (session) {
              try { session.kill(); } catch { /* ok */ }
            }
            try { stdoutReader?.cancel(); } catch { /* ok */ }
            try { stderrReader?.cancel(); } catch { /* ok */ }
          };

          socket.onerror = (err) => {
            console.error(
              `[ssh-xrpc] WebSocket error for actor ${actorDid}:`,
              err,
            );
          };

          return response;
        },
      );

      // ── Write (procedure) ───────────────────────────────────────────
      // POST /xrpc/com.publicdomainrelay.ssh.write
      // Body: { sessionId: string, data: string (base64) }

      app.post(
        `/xrpc/${WRITE_NSID}`,
        authMiddleware(scope),
        async (c: Context<SshXrpcFactoryEnv>) => {
          let body: { sessionId?: string; data?: string };
          try {
            body = await c.req.json();
          } catch {
            return c.json(
              { error: "InvalidRequest", message: "invalid JSON body" },
              400,
            );
          }

          if (!body.sessionId || typeof body.data !== "string") {
            return c.json({
              error: "InvalidRequest",
              message: "required fields: sessionId (string), data (base64 string)",
            }, 400);
          }

          // Decode base64 → Uint8Array
          let bytes: Uint8Array;
          try {
            const binary = atob(body.data);
            bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
          } catch {
            return c.json({
              error: "InvalidRequest",
              message: "data must be valid base64",
            }, 400);
          }

          try {
            await sessionManager.writeStdin(body.sessionId, bytes);
            return c.json({ written: bytes.length });
          } catch (err) {
            const msg = String(err);
            if (msg.includes("not found")) {
              return c.json({
                error: "SessionNotFound",
                message: msg,
              }, 404);
            }
            return c.json({
              error: "SessionClosed",
              message: msg,
            }, 410);
          }
        },
      );
    },
  });

  return {
    /** The underlying Hono factory. */
    factory,
    /** Create a fully-configured Hono app. */
    createApp: () => factory.createApp(),
    /** Direct access to the session manager for lifecycle management. */
    sessionManager,
  };
}
