import { log } from "./log.ts";
import { didToSubdomain, wsOrigin } from "./types.ts";
import { inferFrameType, summarizeFrame } from "./synthetic.ts";
import { wsConnect, type WsHandle } from "./ws.ts";

export interface CallerOptions {
  label?: string;
  dispatcherHost: string;
  subscriberDid?: string;
  subscriberSubdomain?: string;
  nsid?: string;
  cursor?: number;
  onEvent?: (frame: Record<string, unknown>, eventIndex: number) => void;
}

export interface CallerHandle {
  ws: WsHandle;
  close(): void;
}

export function createCaller(opts: CallerOptions): CallerHandle {
  const label = opts.label ?? "caller";
  const subdomain = opts.subscriberSubdomain ?? (opts.subscriberDid ? didToSubdomain(opts.subscriberDid) : undefined);
  if (!subdomain) throw new Error("subscriberDid or subscriberSubdomain required");
  const hostname = `${subdomain}.${opts.dispatcherHost}`;
  const nsid = opts.nsid ?? "com.atproto.sync.subscribeRepos";

  const params = new URLSearchParams();
  if (opts.cursor != null) params.set("cursor", String(opts.cursor));
  const qs = params.toString();
  const url = `${wsOrigin(hostname)}/xrpc/${nsid}${qs ? `?${qs}` : ""}`;

  let eventIndex = 0;

  const ws = wsConnect({
    url,
    reconnect: {
      label,
      onBeforeReconnect: () => { eventIndex = 0; },
    },
    onOpen: () => log("info", { component: label, event: "connected", subdomain, nsid }),
    onMessage: (data: string) => {
      eventIndex++;
      try {
        const frame = JSON.parse(data) as Record<string, unknown>;
        const type = (frame.$type as string | undefined) ?? inferFrameType(frame);
        const summary = summarizeFrame(frame, type);
        opts.onEvent?.(summary, eventIndex);
      } catch {
        log("warn", { component: label, event: "non_json_frame" });
      }
    },
  });

  return {
    ws,
    close: () => ws.close(),
  };
}
