import type { RegistrationStore } from "./store.ts";

export interface HealthCheckerOptions {
  intervalMs?: number;
  staleThresholdMs?: number; // default 5 minutes
}

export interface HealthChecker {
  start(): void;
  stop(): void;
}

export function createHealthChecker(
  store: RegistrationStore,
  log: (severity: string, msg: string, extra?: Record<string, unknown>) => void,
  opts: HealthCheckerOptions = {},
): HealthChecker {
  const intervalMs = opts.intervalMs ?? 60_000;
  const staleThresholdMs = opts.staleThresholdMs ?? 300_000; // 5 min
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      if (timer) return;
      timer = setInterval(async () => {
        try {
          const entries = await store.getAll();
          log("info", "health check: scanning bidders", { count: entries.length });

          for (const entry of entries) {
            const discovery = await store.fetchDiscovery(entry.bidderDid, staleThresholdMs);
            if (!discovery) {
              log("info", "health check: removing stale bidder", {
                bidderDid: entry.bidderDid,
                reason: "bidderDiscovery record not found or stale",
              });
              await store.removeBidder(entry.bidderDid);
            }
          }
        } catch (err) {
          log("error", "health check error", { err: String(err) });
        }
      }, intervalMs);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
