/**
 * Relay subscriber client — Deno
 *
 * 1. Connects to the relay server WebSocket.
 * 2. First frame received is #registered → contains serviceId and proxyRef.
 *    Share proxyRef (did:web:HOST#serviceId) with callers so they route here.
 * 3. Subsequent frames are #request → inbound XRPC calls to handle.
 * 4. For each #request, handle it locally and send back a #response frame
 *    on the same WebSocket.
 *
 * Run:
 *   DISPATCHER_HOST=dispatcher.example.com \
 *   deno run --allow-net client-example.ts
 */

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}

// ── config ────────────────────────────────────────────────────────────────────

const DISPATCHER_HOST = Deno.env.get("DISPATCHER_HOST") ?? "dispatcher.example.com";
const SUBSCRIBE_NSID  = "com.example.dispatcher.subscribe";

// ── frame types ───────────────────────────────────────────────────────────────

interface RegisteredFrame {
  $type: "com.example.dispatcher.subscribe#registered";
  serviceId: string;
  proxyRef:  string;
}

interface RequestFrame {
  $type: "com.example.dispatcher.subscribe#request";
  requestId: string;
  method:    string;
  nsid:      string;
  params:    Record<string, string>;
  body:      unknown;
  callerDid: string;
}

interface ResponseFrame {
  $type:        "com.example.dispatcher.subscribe#response";
  requestId:    string;
  status:       number;
  body:         unknown;
  contentType?: string;
}

// ── request handler ───────────────────────────────────────────────────────────
//
// Replace this function with your real business logic.
// Return a ResponseFrame body (status + body); the WS loop sends it back.

async function handleRequest(req: RequestFrame): Promise<{ status: number; body: unknown }> {
  log("info", { component: "handler", event: "request", requestId: req.requestId, nsid: req.nsid, callerDid: req.callerDid });

  // Example: echo the request back.
  // Swap this for real XRPC dispatch, database calls, etc.
  return {
    status: 200,
    body:   { ok: true, echo: { nsid: req.nsid, params: req.params, body: req.body } },
  };
}

// ── subscription loop ─────────────────────────────────────────────────────────

function connect() {
  const url = `wss://${DISPATCHER_HOST}/xrpc/${SUBSCRIBE_NSID}`;
  log("info", { component: "client", event: "connecting", url });

  const ws = new WebSocket(url);
  let reconnectDelay = 1_000;
  let serviceId: string | undefined;

  ws.addEventListener("open", () => {
    log("info", { component: "client", event: "connected" });
    reconnectDelay = 1_000;
  });

  ws.addEventListener("message", async (evt) => {
    let frame: RegisteredFrame | RequestFrame;
    try {
      frame = JSON.parse(evt.data as string);
    } catch {
      log("warn", { component: "client", event: "non_json_frame_skipped" });
      return;
    }

    // First frame: server assigns our serviceId.
    if (frame.$type === `${SUBSCRIBE_NSID}#registered`) {
      serviceId = frame.serviceId;
      log("info", {
        component: "client",
        event:     "registered",
        serviceId: frame.serviceId,
        proxyRef:  frame.proxyRef,
        note:      "share proxyRef as atproto-proxy header value with callers",
      });
      return;
    }

    // Subsequent frames: relay a request to us.
    if (frame.$type === `${SUBSCRIBE_NSID}#request`) {
      const req = frame as RequestFrame;
      let result: { status: number; body: unknown };

      try {
        result = await handleRequest(req);
      } catch (err) {
        result = {
          status: 500,
          body:   { error: "HandlerError", message: String(err) },
        };
      }

      const response: ResponseFrame = {
        $type:       `${SUBSCRIBE_NSID}#response`,
        requestId:   req.requestId,
        status:      result.status,
        body:        result.body,
        contentType: "application/json",
      };

      ws.send(JSON.stringify(response));
      log("info", { component: "client", event: "responded", requestId: req.requestId, status: result.status });
      return;
    }
  });

  ws.addEventListener("close", () => {
    log("info", { component: "client", event: "disconnected_reconnecting", serviceId, reconnectDelayMs: reconnectDelay });
    serviceId = undefined;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  ws.addEventListener("error", (e) => {
    log("error", { component: "client", event: "ws_error", error: String(e) });
  });
}

connect();
