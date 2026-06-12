import { log } from "./log.ts";

export interface WsConnectOptions {
  url: string;
  onOpen?: () => void;
  onMessage: (data: string) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: unknown) => void;
  /** If set, reconnect with exponential backoff */
  reconnect?: { label: string; onBeforeReconnect?: () => void };
}

export interface WsHandle {
  close(): void;
  send(data: string): void;
}

/**
 * Open a WebSocket. If `reconnect` is set, auto-reconnect on close/error
 * with exponential backoff (1s → 30s). Returns handle with close() + send().
 */
export function wsConnect(opts: WsConnectOptions): WsHandle {
  let ws = new WebSocket(opts.url);
  let reconnectDelay = 1_000;
  let closed = false;

  function connect() {
    if (closed) return;
    ws = new WebSocket(opts.url);

    ws.addEventListener("open", () => {
      reconnectDelay = 1_000;
      opts.onOpen?.();
    });

    ws.addEventListener("message", (evt) => {
      opts.onMessage(evt.data as string);
    });

    ws.addEventListener("close", (e) => {
      opts.onClose?.(e.code, e.reason || "none");
      if (opts.reconnect && !closed) {
        log("info", {
          component: opts.reconnect.label,
          event: "reconnecting",
          delayMs: reconnectDelay,
          code: e.code,
        });
        opts.reconnect.onBeforeReconnect?.();
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      }
    });

    ws.addEventListener("error", () => {
      opts.onError?.(new Error("WebSocket error"));
    });
  }

  connect();

  return {
    close() {
      closed = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "closed by handle");
      }
    },
    send(data: string) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
  };
}
