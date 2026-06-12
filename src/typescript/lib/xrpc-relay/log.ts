export function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}
