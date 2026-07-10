export function log(level: "debug" | "info" | "warn" | "error", fields: Record<string, unknown>) {
  if (level === "debug") return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}
